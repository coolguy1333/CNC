#!/usr/bin/env python3
"""Shop Toolkit for an FRC team shop: tiny stdlib-only web app (HTTP + SQLite).

There is no login. Anyone who can open the page can use and edit everything.
That is deliberate (the data is shop notes, not secrets), so the server defends
itself instead: strict input validation, size and row caps, a per-IP write rate
limit, same-origin checks, automatic backups and one-click restore.

Run:  DATA_DIR=./data python3 server.py     (http://localhost:8080)
"""
import contextlib
import datetime
import gzip
import ipaddress
import json
import math
import mimetypes
import os
import re
import signal
import sqlite3
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE / "data"))
DB_FILE = "cnc.sqlite3"
MAX_BODY = 256 * 1024            # normal writes
MAX_IMPORT = 8 * 1024 * 1024     # backup restore
BACKUP_KEEP = 20
AUTO_BACKUP_SECONDS = 6 * 3600
RATE_CAP = 90                    # write requests per IP: burst size ...
RATE_REFILL = 1.0                # ... and sustained requests per second
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()}
APP_VERSION = "2.0"
SCHEMA_VERSION = 2
SEED_VERSION = 6

# --------------------------------------------------------------------------
# Data model. Every table is described once; validation, SQL and the UI's
# forms all follow from these specs.
# --------------------------------------------------------------------------
MATERIALS = ["aluminum", "polycarbonate", "spoilboard"]
OPS = ["slot", "pocket", "profile", "adaptive", "finish", "surface"]
KINDS = ["flat", "ball", "bull", "face", "drill", "other"]
IGNORED_KEYS = {"id", "updated_at"}


def s_(name, default="", lo=0, hi=200):
    return dict(name=name, kind="str", default=default, lo=lo, hi=hi)


def n_(name, default, lo, hi, integer=False):
    return dict(name=name, kind="int" if integer else "float", default=default, lo=lo, hi=hi)


def e_(name, default, options):
    return dict(name=name, kind="enum", default=default, options=options)


def d_(name, default=""):
    return dict(name=name, kind="date", default=default)


def r_(name, table, optional=False):
    return dict(name=name, kind="ref", default=0, table=table, optional=optional)


ENTITIES = {
    "tools": {"cap": 500, "fields": [
        s_("name", "", 1, 120), s_("vendor", "", 0, 120), e_("kind", "flat", KINDS),
        n_("nominal_mm", 3.0, 0.1, 200), n_("actual_mm", 3.0, 0.1, 200), n_("flutes", 1, 1, 12, True),
        n_("flute_len_mm", 10.0, 0.1, 300), n_("overall_mm", 40.0, 0, 500), n_("shank_mm", 0.0, 0, 50),
        e_("mat", "carbide", ["carbide", "hss"]), s_("coating", "", 0, 60),
        n_("feed_factor", 1.0, 0.2, 2.0), s_("notes", "", 0, 1000)]},
    "recipes": {"cap": 3000, "fields": [
        r_("tool_id", "tools"), e_("material", "aluminum", MATERIALS), e_("op", "slot", OPS), s_("label", "", 0, 60),
        n_("rpm", 0, 0, 100000), n_("feed_mm", 0, 0, 100000), n_("plunge_mm", 0, 0, 100000), n_("ramp_mm", 0, 0, 100000),
        n_("doc_mm", 0, 0, 500), n_("woc_mm", 0, 0, 500), n_("rating", 3, 1, 5, True), s_("notes", "", 0, 1000)]},
    "joblog": {"cap": 5000, "fields": [
        d_("date"), s_("name", "", 1, 120), s_("operator", "", 0, 60), e_("material", "aluminum", MATERIALS),
        r_("tool_id", "tools", True), n_("thickness_mm", 0, 0, 500), n_("rpm", 0, 0, 100000), n_("feed_mm", 0, 0, 100000),
        n_("doc_mm", 0, 0, 500), n_("minutes", 0, 0, 100000), e_("result", "ok", ["great", "ok", "bad"]), s_("notes", "", 0, 1000)]},
    "inventory": {"cap": 3000, "fields": [
        e_("category", "stock", ["stock", "endmill", "hardware", "consumable", "other"]), s_("name", "", 1, 120),
        n_("qty", 0, 0, 1e7), s_("unit", "ea", 0, 20), n_("min_qty", 0, 0, 1e7), s_("location", "", 0, 80), s_("notes", "", 0, 1000)]},
    "maintenance": {"cap": 500, "fields": [
        s_("task", "", 1, 120), s_("machine", "OMIO X8", 0, 60), n_("interval_days", 0, 0, 3650, True),
        d_("last_done"), s_("notes", "", 0, 1000)]},
}

SETTINGS_DEFAULTS = {
    "units": "in", "min_rpm": 5000.0, "max_rpm": 24000.0, "max_feed_mm": 4000.0, "spindle_w": 2200.0,
    "defl_limit_mm": 0.02, "table_x_mm": 565.0, "table_y_mm": 770.0, "z_travel_mm": 85.0, "weight_limit_lb": 115.0,
}
SETTINGS_LIMITS = {
    "min_rpm": (0, 100000), "max_rpm": (100, 100000), "max_feed_mm": (10, 100000), "spindle_w": (10, 100000),
    "defl_limit_mm": (0.001, 1), "table_x_mm": (50, 5000), "table_y_mm": (50, 5000), "z_travel_mm": (5, 1000),
    "weight_limit_lb": (1, 1000),
}
HIDDEN_SETTINGS = ("schema", "seed_version", "rev")

# --------------------------------------------------------------------------
# Built-in data: the team's tool library and tested settings (from the Fusion
# tool library the team supplied), plus suggested maintenance tasks.
# --------------------------------------------------------------------------
SEED_TOOLS = [
    dict(name="Thrifty Bot 5 mm", vendor="Thrifty Bot", kind="flat", nominal_mm=5.0, actual_mm=4.6, flutes=1,
         flute_len_mm=12, overall_mm=50, shank_mm=5.0, mat="carbide", coating="Diamond grit",
         notes="Single flute. Real cutting diameter is 4.6 mm, so use 4.6 mm in CAM."),
    dict(name="Thrifty Bot 4 mm", vendor="Thrifty Bot", kind="flat", nominal_mm=4.0, actual_mm=3.7, flutes=1,
         flute_len_mm=12, overall_mm=45, shank_mm=4.0, mat="carbide", coating="Diamond grit",
         notes="Single flute. Real cutting diameter is 3.7 mm, so use 3.7 mm in CAM."),
    dict(name='1/8" endmill', kind="flat", nominal_mm=3.175, actual_mm=2.845, flutes=1, flute_len_mm=20,
         overall_mm=50, shank_mm=3.175, mat="hss", notes="Measured 0.112 in."),
    dict(name='1/8" endmill (undersized, careful)', kind="flat", nominal_mm=3.175, actual_mm=3.124, flutes=1,
         flute_len_mm=20, overall_mm=50, shank_mm=3.175, mat="hss", notes="Measured 0.123 in."),
    dict(name="6 mm endmill", kind="flat", nominal_mm=6.0, actual_mm=6.0, flutes=1, flute_len_mm=20,
         overall_mm=50, shank_mm=6.0, mat="carbide"),
    dict(name='2.5" facemill', kind="face", nominal_mm=63.5, actual_mm=63.5, flutes=4, flute_len_mm=12.7,
         overall_mm=50, shank_mm=12.7, mat="hss", notes="Spoilboard surfacing."),
]
_LIB = "From the team's Fusion tool library (tested)."
# tool name, material, op, label, rpm, feed mm/min, plunge, ramp, doc, woc, notes
SEED_RECIPES = [
    ("Thrifty Bot 5 mm", "aluminum", "slot", "Aluminum", 24000, 1727.2, 508, 1143, 1.5875, 4.6,
     _LIB + ' Full slot, 1/16" per pass (68 in/min, 0.0028"/tooth).'),
    ("Thrifty Bot 5 mm", "polycarbonate", "slot", "Poly", 24000, 3937, 1016, 3048, 3.175, 4.6,
     _LIB + ' Full slot, 1/8" per pass (155 in/min). Near the X8 max feed.'),
    ("Thrifty Bot 4 mm", "aluminum", "slot", "Aluminum", 20000, 1320.8, 508, 889, 0, 3.7, _LIB),
    ("Thrifty Bot 4 mm", "polycarbonate", "slot", "Poly", 20000, 2286, 1016, 1524, 0, 3.7, _LIB),
    ("6 mm endmill", "aluminum", "slot", "Aluminum", 11000, 254, 254, 254, 0, 6, _LIB),
    ("6 mm endmill", "polycarbonate", "slot", "Poly", 22000, 3937, 254, 2032, 0, 6, _LIB),
    ('1/8" endmill', "aluminum", "slot", "Aluminum", 9500, 254, 254, 254, 0, 2.845, _LIB),
    ('1/8" endmill', "aluminum", "slot", ".19 Aluminum", 24000, 1016, 254, 1016, 0, 2.845,
     _LIB + ' Preset is named ".19 Aluminum" there.'),
    ('1/8" endmill', "polycarbonate", "slot", "Poly", 20000, 1016, 254, 1016, 0, 2.845, _LIB),
    ('1/8" endmill (undersized', "aluminum", "slot", "Aluminum", 9500, 254, 254, 254, 0, 3.124, _LIB),
    ('1/8" endmill (undersized', "polycarbonate", "slot", "Poly", 20000, 1016, 254, 1016, 0, 3.124, _LIB),
    ('2.5" facemill', "spoilboard", "surface", "Default preset", 5000, 762, 338.7, 338.7, 0, 0,
     _LIB + " 0.0015\"/tooth, 4 flutes (30 in/min)."),
]
SEED_MAINTENANCE = [
    ("Vacuum chips off the table, rails and covers", 7, "After each session is even better."),
    ("Check spindle cooling (water level, pump running, hoses)", 30, "Check before every long job too."),
    ("Clean ER20 collets and nut, check for wear or rust", 30, ""),
    ("Wipe and lubricate linear rails and ball screws", 30, "Use what the OMIO manual says; adjust the interval to how much you run it."),
    ("Resurface the spoilboard", 90, "Sooner if cuts stop going through cleanly or the board is deeply grooved."),
    ("Test the E-stop and check cables, couplers and set screws", 90, ""),
]

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
_db_lock = threading.RLock()
_last_backup = [0.0]


class ValidationError(ValueError):
    pass


def db_path():
    return DATA_DIR / DB_FILE


@contextlib.contextmanager
def connect():
    """Open the DB; commit on success, roll back on error, always close."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path(), timeout=10)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def sql_type(kind):
    return {"str": "TEXT", "enum": "TEXT", "date": "TEXT", "int": "INTEGER", "ref": "INTEGER", "float": "REAL"}[kind]


def sql_default(f):
    if f["kind"] in ("str", "enum", "date"):
        return "'" + str(f["default"]).replace("'", "''") + "'"
    return repr(f["default"])


def create_tables(con):
    for table, spec in ENTITIES.items():
        cols = ",".join(f"{f['name']} {sql_type(f['kind'])} NOT NULL DEFAULT {sql_default(f)}" for f in spec["fields"])
        con.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols},"
                    " updated_at REAL NOT NULL DEFAULT 0)")
        have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        for f in spec["fields"]:
            if f["name"] not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {f['name']} {sql_type(f['kind'])} NOT NULL DEFAULT {sql_default(f)}")
    con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def set_setting(con, key, value):
    con.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)))


def get_raw_setting(con, key, default=None):
    r = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def touch(con):
    """Bump the data revision so other open browsers know to refresh."""
    set_setting(con, "rev", int(get_raw_setting(con, "rev", "0")) + 1)


def material_key(name):
    n = str(name).lower()
    if "alumin" in n:
        return "aluminum"
    if "polycarb" in n or "lexan" in n:
        return "polycarbonate"
    if "mdf" in n or "spoil" in n:
        return "spoilboard"
    return None


def migrate_v1(con):
    """Version 1 kept materials in a table and recipes pointed at them. Convert in place."""
    cols = {r["name"] for r in con.execute("PRAGMA table_info(recipes)")}
    if "material_id" not in cols:
        return
    names = {r["id"]: r["name"] for r in con.execute("SELECT id,name FROM materials")} if \
        con.execute("SELECT 1 FROM sqlite_master WHERE name='materials'").fetchone() else {}
    old = [dict(r) for r in con.execute("SELECT * FROM recipes ORDER BY id")]
    con.execute("DROP TABLE recipes")
    con.execute("DROP TABLE IF EXISTS materials")
    create_tables(con)
    for r in old:
        mat = material_key(names.get(r.get("material_id"), ""))
        seeded = str(r.get("notes", "")).startswith(("From omio-tools.tools", "Your run:"))
        if not mat or seeded:  # unsupported material, or a v1 seed that is re-created below
            continue
        row = {f["name"]: r.get(f["name"], f["default"]) for f in ENTITIES["recipes"]["fields"]}
        row["material"] = mat
        if con.execute("SELECT 1 FROM tools WHERE id=?", (row["tool_id"],)).fetchone():
            try:
                insert(con, "recipes", clean("recipes", row))
            except ValidationError:
                pass


def seed_defaults(con):
    """Add the built-in tools/settings/tasks that are missing. Never overwrites anything the team edited."""
    for t in SEED_TOOLS:
        if not con.execute("SELECT 1 FROM tools WHERE name=?", (t["name"],)).fetchone():
            insert(con, "tools", clean("tools", t))
    for tname, mat, op, label, rpm, feed, plunge, ramp, doc, woc, notes in SEED_RECIPES:
        tool = con.execute("SELECT id FROM tools WHERE name LIKE ? ORDER BY id LIMIT 1", (tname + "%",)).fetchone()
        if not tool:
            continue
        have = con.execute("SELECT 1 FROM recipes WHERE tool_id=? AND material=? AND op=? AND (label=? OR label='')",
                           (tool["id"], mat, op, label)).fetchone()
        if not have:
            insert(con, "recipes", clean("recipes", dict(tool_id=tool["id"], material=mat, op=op, label=label, rpm=rpm,
                                                         feed_mm=feed, plunge_mm=plunge, ramp_mm=ramp, doc_mm=doc,
                                                         woc_mm=woc, rating=4, notes=notes)))


def upgrade_seed(con):
    """One-time fixes to rows that older versions seeded, applied only if the team never edited them."""
    now = time.time()
    for old, new in (("Thrifty Bot 5 mm (undersized)", "Thrifty Bot 5 mm"), ("Thrifty Bot 4 mm (undersized)", "Thrifty Bot 4 mm")):
        if not con.execute("SELECT 1 FROM tools WHERE name=?", (new,)).fetchone():
            con.execute("UPDATE tools SET name=?, updated_at=? WHERE name=?", (new, now, old))
    # Thrifty Bot's 4 mm endmill is carbide and 45 mm long; version 1 seeded it as HSS / 50 mm.
    con.execute("UPDATE tools SET mat='carbide', overall_mm=45, updated_at=? WHERE name='Thrifty Bot 4 mm' AND mat='hss'"
                " AND overall_mm=50", (now,))


def init_db(backup=True):
    with _db_lock:
        existed = db_path().exists()
        if existed and backup and time.time() - newest_backup_time() > 3600:
            backup_db("startup")
        with connect() as con:
            create_tables(con)
            migrate_v1(con)
            if get_raw_setting(con, "rev") is None:
                set_setting(con, "rev", 0)
            if int(get_raw_setting(con, "seed_version", "0")) < SEED_VERSION:
                upgrade_seed(con)
                seed_defaults(con)
                if con.execute("SELECT COUNT(*) c FROM maintenance").fetchone()["c"] == 0:   # new installs and upgrades from version 1
                    for task, days, notes in SEED_MAINTENANCE:
                        insert(con, "maintenance", clean("maintenance", dict(
                            task=task, interval_days=days, notes=notes)))
                set_setting(con, "seed_version", SEED_VERSION)
            set_setting(con, "schema", SCHEMA_VERSION)
            touch(con)


# -- backups ---------------------------------------------------------------
BACKUP_RE = re.compile(r"^shop-\d{8}-\d{6}(-\d+)?-[a-z0-9]{1,12}\.sqlite3$")


def backup_dir():
    return DATA_DIR / "backups"


def backup_db(reason="auto"):
    """Consistent snapshot of the live DB into DATA_DIR/backups; keeps the newest BACKUP_KEEP."""
    src = db_path()
    if not src.exists():
        return None
    d = backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    tag = re.sub(r"[^a-z0-9]", "", reason.lower())[:12] or "auto"
    name, i = f"shop-{stamp}-{tag}.sqlite3", 1
    while (d / name).exists():
        name, i = f"shop-{stamp}-{i}-{tag}.sqlite3", i + 1
    s = sqlite3.connect(src, timeout=10)
    t = sqlite3.connect(d / name)
    try:
        s.backup(t)
    finally:
        t.close()
        s.close()
    _last_backup[0] = time.time()
    files = sorted((f for f in d.iterdir() if BACKUP_RE.match(f.name)), key=lambda f: f.name)
    for old in files[:-BACKUP_KEEP]:
        with contextlib.suppress(OSError):
            old.unlink()
    return name


def newest_backup_time():
    d = backup_dir()
    times = [f.stat().st_mtime for f in d.iterdir() if BACKUP_RE.match(f.name)] if d.is_dir() else []
    return max(times, default=0.0)


def maybe_auto_backup():
    if time.time() - max(_last_backup[0], newest_backup_time()) > AUTO_BACKUP_SECONDS:
        backup_db("auto")


def list_backups():
    d = backup_dir()
    out = []
    if d.is_dir():
        for f in sorted(d.iterdir(), key=lambda f: f.name, reverse=True):
            if BACKUP_RE.match(f.name):
                st = f.stat()
                out.append({"name": f.name, "size": st.st_size, "time": int(st.st_mtime)})
    return out


def restore_backup(name):
    if not isinstance(name, str) or not BACKUP_RE.match(name):
        raise ValidationError("Bad backup name")
    src = backup_dir() / name
    if not src.is_file():
        raise ValidationError("Backup not found")
    probe = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        tables = {r[0] for r in probe.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"tools", "recipes", "settings"} <= tables or probe.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValidationError("That file is not a usable backup")
    except sqlite3.DatabaseError:
        raise ValidationError("That file is not a usable backup")
    finally:
        probe.close()
    with _db_lock:
        backup_db("prerestore")
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        t = sqlite3.connect(db_path(), timeout=10)
        try:
            s.backup(t)
        finally:
            t.close()
            s.close()
        init_db(backup=False)


# -- validation --------------------------------------------------------------
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def coerce(f, v):
    name, kind = f["name"], f["kind"]
    if kind == "str":
        v = "" if v is None else v
        if not isinstance(v, (str, int, float)) or isinstance(v, bool):
            raise ValidationError(f"{name}: must be text")
        v = _CTRL.sub("", str(v)).strip()
        if not (f["lo"] <= len(v) <= f["hi"]):
            raise ValidationError(f"{name}: length must be {f['lo']}-{f['hi']}")
        return v
    if kind == "enum":
        if v not in f["options"]:
            raise ValidationError(f"{name}: must be one of {', '.join(f['options'])}")
        return v
    if kind == "date":
        if v in (None, ""):
            return ""
        text = str(v)
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
                raise ValueError
            datetime.date.fromisoformat(text)
        except ValueError:
            raise ValidationError(f"{name}: must be a date like 2026-01-31")
        return text
    if isinstance(v, bool) or v is None or v == "":
        raise ValidationError(f"{name}: must be a number")
    try:
        x = int(v) if kind in ("int", "ref") else float(v)
        if kind in ("int", "ref") and isinstance(v, float) and v != int(v):
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise ValidationError(f"{name}: must be a {'whole ' if kind in ('int', 'ref') else ''}number")
    if kind == "ref":
        if x < (0 if f["optional"] else 1):
            raise ValidationError(f"{name}: pick one")
        return x
    if not math.isfinite(x) or not (f["lo"] <= x <= f["hi"]):
        raise ValidationError(f"{name}: must be between {f['lo']:g} and {f['hi']:g}")
    return x


def clean(table, data, base=None):
    """Validate/normalise a payload against the table's field specs. `base` supplies values for omitted fields (PUT)."""
    if not isinstance(data, dict):
        raise ValidationError("Expected an object")
    fields = ENTITIES[table]["fields"]
    extra = set(data) - {f["name"] for f in fields} - IGNORED_KEYS
    if extra:
        raise ValidationError("Unknown field: " + ", ".join(sorted(map(str, extra))[:3]))
    out = {}
    for f in fields:
        n = f["name"]
        out[n] = coerce(f, data[n] if n in data else (base[n] if base and n in base else f["default"]))
    if table == "tools":
        if not 0.5 * out["nominal_mm"] <= out["actual_mm"] <= 1.5 * out["nominal_mm"]:
            raise ValidationError("actual_mm: should be within 50-150% of the nominal size")
        if out["overall_mm"] and out["flute_len_mm"] > out["overall_mm"]:
            raise ValidationError("flute_len_mm: can't be longer than the overall length")
    if table in ("joblog",) and not out["date"]:
        out["date"] = datetime.date.today().isoformat()
    return out


def clean_settings(data, base=None):
    if not isinstance(data, dict):
        raise ValidationError("Expected an object")
    extra = set(data) - set(SETTINGS_DEFAULTS)
    if extra:
        raise ValidationError("Unknown setting: " + ", ".join(sorted(map(str, extra))[:3]))
    out = {}
    for k, default in SETTINGS_DEFAULTS.items():
        v = data.get(k, (base or {}).get(k, default))
        if k == "units":
            if v not in ("mm", "in"):
                raise ValidationError("units: must be mm or in")
        else:
            if isinstance(v, bool):
                raise ValidationError(f"{k}: must be a number")
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise ValidationError(f"{k}: must be a number")
            lo, hi = SETTINGS_LIMITS[k]
            if not math.isfinite(v) or not (lo <= v <= hi):
                raise ValidationError(f"{k}: must be between {lo} and {hi}")
        out[k] = v
    if out["min_rpm"] >= out["max_rpm"]:
        raise ValidationError("min_rpm must be below max_rpm")
    return out


def insert(con, table, row, rid=None):
    cols = list(row) + (["id"] if rid else [])
    vals = list(row.values()) + ([rid] if rid else [])
    cur = con.execute(f"INSERT INTO {table} ({','.join(cols)},updated_at) VALUES ({','.join('?' * len(cols))},?)",
                      vals + [time.time()])
    return cur.lastrowid


def rows(con, table, limit=None, offset=0):
    sql = f"SELECT * FROM {table} ORDER BY id"
    if limit is not None:
        return [dict(r) for r in con.execute(sql + " LIMIT ? OFFSET ?", (limit, offset))]
    return [dict(r) for r in con.execute(sql)]


def get_settings(con):
    s = dict(SETTINGS_DEFAULTS)
    for r in con.execute("SELECT key,value FROM settings"):
        if r["key"] in s:
            try:
                s[r["key"]] = r["value"] if r["key"] == "units" else float(r["value"])
            except ValueError:
                pass
    return s


def snapshot(con, tables=None):
    data = {t: rows(con, t) for t in (tables or ENTITIES)}
    data["settings"] = get_settings(con)
    return data


def check_refs(con, table, row):
    if table == "recipes" and not con.execute("SELECT 1 FROM tools WHERE id=?", (row["tool_id"],)).fetchone():
        raise ValidationError("tool_id: unknown tool")
    if table == "joblog" and row["tool_id"] and not con.execute("SELECT 1 FROM tools WHERE id=?", (row["tool_id"],)).fetchone():
        raise ValidationError("tool_id: unknown tool")


def check_cap(con, table, adding=1):
    n = con.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"]
    if n + adding > ENTITIES[table]["cap"]:
        raise ValidationError(f"{table} is full (max {ENTITIES[table]['cap']}). Delete old entries first.")


def import_all(con, data):
    """Replace everything with a backup file's contents (all-or-nothing). Understands version-1 exports too."""
    if not isinstance(data, dict):
        raise ValidationError("Expected a backup object")
    names = {}
    if isinstance(data.get("materials"), list):
        names = {m.get("id"): m.get("name", "") for m in data["materials"] if isinstance(m, dict)}
    parsed = {}
    for table, spec in ENTITIES.items():
        raw = data.get(table, [])
        if not isinstance(raw, list):
            raise ValidationError(f"{table}: expected a list")
        if len(raw) > spec["cap"]:
            raise ValidationError(f"{table}: too many rows (max {spec['cap']})")
        out, seen = [], set()
        for item in raw:
            if not isinstance(item, dict):
                raise ValidationError(f"{table}: expected objects")
            item = dict(item)
            if table == "recipes" and "material_id" in item:
                mat = material_key(names.get(item.pop("material_id"), ""))
                if not mat:
                    continue
                item["material"] = mat
            rid = item.get("id")
            if (rid is None and table == "tools") or (rid is not None and (
                    not isinstance(rid, int) or isinstance(rid, bool) or rid < 1 or rid in seen)):
                raise ValidationError(f"{table}: bad, missing or duplicate id")
            seen.add(rid)
            out.append((rid, clean(table, item)))
        parsed[table] = out
    tool_ids = {rid for rid, _ in parsed["tools"] if rid}
    for table in ("recipes", "joblog"):
        for _, row in parsed[table]:
            if row["tool_id"] and row["tool_id"] not in tool_ids:
                raise ValidationError(f"{table}: refers to a tool that is not in the file")
    settings = clean_settings(data["settings"]) if isinstance(data.get("settings"), dict) else None
    backup_db("preimport")
    for table in ENTITIES:
        con.execute(f"DELETE FROM {table}")
        con.execute("DELETE FROM sqlite_sequence WHERE name=?", (table,))
    for table in ENTITIES:  # tools first so references resolve
        for rid, row in parsed[table]:
            insert(con, table, row, rid)
    if settings:
        for k, v in settings.items():
            set_setting(con, k, v)
    touch(con)


# --------------------------------------------------------------------------
# Rate limit (per IP, writes only)
# --------------------------------------------------------------------------
_rate = {}
_rate_lock = threading.Lock()


def allow_write(ip):
    now = time.time()
    with _rate_lock:
        if len(_rate) > 5000:
            _rate.clear()
        tokens, last = _rate.get(ip, (RATE_CAP, now))
        tokens = min(RATE_CAP, tokens + (now - last) * RATE_REFILL)
        if tokens < 1:
            _rate[ip] = (tokens, now)
            return False
        _rate[ip] = (tokens - 1, now)
        return True


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
_static_cache = {}


def client_ip(peer, forwarded):
    """The address to rate-limit. X-Real-IP is believed only when the connection comes from a private/loopback address
    (a reverse proxy), so a direct client can't dodge the limit by inventing the header."""
    try:
        if forwarded and not ipaddress.ip_address(peer).is_global:   # loopback, private, link-local, CGNAT: a proxy on our own network
            return str(ipaddress.ip_address(forwarded.strip()))
    except ValueError:
        pass
    return peer


def _no_constants(c):
    raise ValueError("bad JSON constant " + c)


class Handler(BaseHTTPRequestHandler):
    server_version = "ShopToolkit"
    protocol_version = "HTTP/1.1"
    timeout = 15  # seconds; drops stalled/slow clients

    def log_message(self, fmt, *args):
        if "timed out" in fmt:
            return
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    # -- helpers --
    sys_version = ""  # don't announce the Python version in the Server header

    def version_string(self):
        return self.server_version

    def ip(self):
        return client_ip(self.client_address[0], self.headers.get("X-Real-IP"))

    def https(self):
        return self.headers.get("X-Forwarded-Proto") == "https"

    def send(self, code, body=b"", ctype="application/json", extra=None, gz=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(",", ":")).encode()
        elif isinstance(body, str):
            body = body.encode()
        headers = dict(extra or {})
        if "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024:
            body = gz if gz is not None else gzip.compress(body, 6, mtime=0)
            headers["Content-Encoding"] = "gzip"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                         "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if self.https():
            self.send_header("Strict-Transport-Security", "max-age=15552000")
        self.send_header("Cache-Control", "no-store" if ctype.startswith("application/json") else "no-cache")
        if self.close_connection:
            self.send_header("Connection", "close")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def err(self, code, msg, extra=None):
        self.send(code, {"error": msg}, extra=extra)

    def guard(self, fn):
        """Run a handler; never let an exception kill the connection silently."""
        self.close_connection = False
        try:
            fn()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            self.close_connection = True
            try:
                self.err(500, "Server error")
            except Exception:
                pass

    def drain(self, n):
        """Discard up to n bytes of an unwanted body so the error reply isn't lost to a connection reset."""
        try:
            while n > 0:
                chunk = self.rfile.read(min(n, 65536))
                if not chunk:
                    break
                n -= len(chunk)
        except (OSError, TimeoutError):
            pass

    def read_body(self, limit=MAX_BODY):
        """Read the request body up front so error replies never leave unread bytes on a keep-alive connection."""
        self._raw = b""
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return self.err(411, "Content-Length required")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0:
            self.close_connection = True
            return self.err(400, "Bad Content-Length")
        if n > limit:
            self.close_connection = True
            self.drain(min(n, 2 * 1024 * 1024))
            return self.err(413, "Request too large")
        self._raw = self.rfile.read(n) if n else b""
        return None

    def json_body(self):
        # exactly application/json (parameters like charset are fine). A substring match would let a cross-site form
        # smuggle the words into a "simple" content type such as text/plain; application/json.
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise ValidationError("Content-Type must be application/json")
        try:
            return json.loads(self._raw or b"null", parse_constant=_no_constants)
        except (ValueError, RecursionError):
            raise ValidationError("Invalid JSON")

    def host_ok(self):
        if not ALLOWED_HOSTS:
            return True
        host = (self.headers.get("Host") or "").lower()
        return host in ALLOWED_HOSTS or host.split(":")[0] in ALLOWED_HOSTS

    def same_origin(self):
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urlsplit(origin).netloc.lower()
        allowed = {(self.headers.get("Host") or "").lower(), (self.headers.get("X-Forwarded-Host") or "").lower()} - {""}
        return bool(host) and host in allowed

    # -- routing --
    def do_HEAD(self):
        self.guard(self.get)

    def do_GET(self):
        self.guard(self.get)

    def do_OPTIONS(self):
        self.guard(lambda: self.send(204, b"", extra={"Allow": "GET, HEAD, POST, PUT, DELETE"}))

    def do_POST(self):
        self.guard(lambda: self.mutate("POST"))

    def do_PUT(self):
        self.guard(lambda: self.mutate("PUT"))

    def do_DELETE(self):
        self.guard(lambda: self.mutate("DELETE"))

    def do_PATCH(self):
        self.guard(lambda: self.mutate("PATCH"))

    def get(self):
        if self.headers.get("Content-Length", "0") not in ("", "0") or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
        if not self.host_ok():
            return self.err(400, "Unknown host")
        url = urlsplit(self.path)
        path = url.path
        if path == "/api/health":
            return self.send(200, {"ok": True, "version": APP_VERSION})
        if path == "/api/rev":
            with _db_lock, connect() as con:
                return self.send(200, {"rev": int(get_raw_setting(con, "rev", "0"))})
        if path == "/api/state":
            with _db_lock, connect() as con:
                state = snapshot(con, [t for t in ENTITIES if t != "joblog"])
                state["joblog_count"] = con.execute("SELECT COUNT(*) c FROM joblog").fetchone()["c"]
                state["rev"] = int(get_raw_setting(con, "rev", "0"))
            state["version"] = APP_VERSION
            return self.send(200, state)
        if path == "/api/export":
            with _db_lock, connect() as con:
                data = snapshot(con)
            data.update(app="shop-toolkit", version=APP_VERSION, exported=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
            return self.send(200, data, extra={"Content-Disposition": 'attachment; filename="shop-data.json"'})
        if path == "/api/backups":
            return self.send(200, {"backups": list_backups()})
        m = re.fullmatch(r"/api/(\w+)", path)
        if m and m.group(1) in ENTITIES:
            q = parse_qs(url.query)
            try:
                limit = min(int(q.get("limit", ["5000"])[0]), 5000)
                offset = max(int(q.get("offset", ["0"])[0]), 0)
            except ValueError:
                return self.err(400, "Bad limit/offset")
            with _db_lock, connect() as con:
                return self.send(200, rows(con, m.group(1), max(limit, 0), offset))
        if path.startswith("/api/"):
            return self.err(404, "Not found")
        self.static(path)

    def static(self, path):
        path = unquote(path)
        if "\x00" in path or "\\" in path:
            return self.err(404, "Not found")
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self.err(404, "Not found")
        st = f.stat()
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        if self.headers.get("If-None-Match") == etag:
            return self.send(304, b"", extra={"ETag": etag})
        hit = _static_cache.get(f)
        if not hit or hit[0] != etag:
            raw = f.read_bytes()
            hit = _static_cache[f] = (etag, raw, gzip.compress(raw, 9, mtime=0) if len(raw) > 1024 else None)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml", "application/json"):
            ctype += "; charset=utf-8"
        self.send(200, hit[1], ctype, extra={"ETag": etag}, gz=hit[2])

    def mutate(self, method):
        path_only = urlsplit(self.path).path
        if self.read_body(MAX_IMPORT if path_only == "/api/import" else MAX_BODY) is not None or self.close_connection:
            return
        if not self.host_ok():
            return self.err(400, "Unknown host")
        if not self.same_origin():
            return self.err(403, "Cross-origin request blocked")
        if not allow_write(self.ip()):
            return self.err(429, "Too many changes too quickly. Wait a few seconds.", extra={"Retry-After": "5"})
        path = path_only.strip("/").split("/")
        try:
            if path[:1] != ["api"] or len(path) < 2:
                return self.err(404, "Not found")
            code, obj = self.api_write(method, path[1], path[2:])
            maybe_auto_backup()
            return self.send(code, obj)
        except ValidationError as e:
            return self.err(400, str(e))
        except sqlite3.IntegrityError as e:
            return self.err(409, str(e))

    def api_write(self, method, head, rest):
        if head == "settings" and method == "PUT" and not rest:
            body = self.json_body()
            with _db_lock, connect() as con:
                data = clean_settings(body, get_settings(con))
                for k, v in data.items():
                    set_setting(con, k, v)
                touch(con)
            return 200, data
        if head == "import" and method == "POST" and not rest:
            body = self.json_body()
            with _db_lock, connect() as con:
                import_all(con, body)
            return 200, {"ok": True}
        if head == "restore-defaults" and method == "POST" and not rest:
            with _db_lock, connect() as con:
                seed_defaults(con)
                touch(con)
            return 200, {"ok": True}
        if head == "backups" and method == "POST" and rest == ["restore"]:
            body = self.json_body()
            restore_backup(body.get("name") if isinstance(body, dict) else None)
            return 200, {"ok": True}
        if head == "backups" and method == "POST" and not rest:
            with _db_lock:
                return 201, {"name": backup_db("manual")}
        if head in ENTITIES:
            return self.entity(method, head, rest)
        return 404, {"error": "Not found"}

    def entity(self, method, table, rest):
        """Returns (status, payload). The DB lock is released before anything is written to the socket."""
        with _db_lock, connect() as con:
            if method == "POST" and not rest:
                data = self.json_body()
                items = data if isinstance(data, list) else [data]
                if len(items) > 500:
                    raise ValidationError("Too many rows (max 500)")
                check_cap(con, table, len(items))
                ids = []
                for item in items:
                    row = clean(table, item)
                    check_refs(con, table, row)
                    ids.append(insert(con, table, row))
                touch(con)
                return 201, ({"ids": ids} if isinstance(data, list) else {"id": ids[0]})
            if len(rest) == 1 and rest[0].isdigit() and len(rest[0]) < 12:
                rid = int(rest[0])
                cur = con.execute(f"SELECT * FROM {table} WHERE id=?", (rid,)).fetchone()
                if not cur:
                    return 404, {"error": "Not found"}
                if method in ("PUT", "PATCH"):
                    row = clean(table, self.json_body(), dict(cur))
                    check_refs(con, table, row)
                    sets = ",".join(f"{c}=?" for c in row)
                    con.execute(f"UPDATE {table} SET {sets},updated_at=? WHERE id=?", list(row.values()) + [time.time(), rid])
                    touch(con)
                    return 200, {"id": rid}
                if method == "DELETE":
                    removed = 0
                    if table == "tools":  # saved settings for a deleted tool make no sense; old log entries just forget it
                        removed = con.execute("DELETE FROM recipes WHERE tool_id=?", (rid,)).rowcount
                        con.execute("UPDATE joblog SET tool_id=0 WHERE tool_id=?", (rid,))
                    con.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
                    touch(con)
                    return 200, {"ok": True, "removed_recipes": removed}
        return 405, {"error": "Method not allowed"}


class Server(ThreadingHTTPServer):
    """Threaded server with a cap on simultaneous connections, so a pile of slow clients can't exhaust memory."""
    daemon_threads = True
    request_queue_size = 64
    max_connections = 128

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self._slots = threading.BoundedSemaphore(self.max_connections)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            with contextlib.suppress(OSError):
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n")
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def make_server(host, port):
    init_db()
    return Server((host, port), Handler)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    srv = make_server(host, port)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown).start())
    print(f"Shop Toolkit listening on {host}:{port}, data in {DATA_DIR}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
