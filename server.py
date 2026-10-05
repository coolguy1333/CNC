#!/usr/bin/env python3
"""CNC Feeds & Speeds: tiny stdlib-only web app (HTTP + SQLite).

Runs under WebManager app hosting: listens on $HOST:$PORT, keeps data in
$DATA_DIR, answers /api/health, and stops cleanly on SIGTERM.
Reading is public; changing tools/materials/recipes/settings needs the
ADMIN_PASSWORD.
"""
import contextlib
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import signal
import sqlite3
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE / "data"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
COOKIE = "cnc_session"
SESSION_SECONDS = 7 * 24 * 3600
MAX_BODY = 1_000_000

# --------------------------------------------------------------------------
# Schema. Each field: (name, kind, default, min, max / choices)
# kinds: str, int, float, enum
# --------------------------------------------------------------------------
KINDS = ["flat", "ball", "face", "bull", "other"]
HEAT = ["metal", "plastic", "wood"]
OPS = ["slot", "profile", "pocket", "adaptive", "finish"]

ENTITIES = {
    "tools": {
        "fields": [
            ("name", "str", "", 1, 120),
            ("vendor", "str", "", 0, 120),
            ("kind", "enum", "flat", KINDS, None),
            ("nominal_mm", "float", 3.0, 0.1, 200),
            ("actual_mm", "float", 3.0, 0.1, 200),
            ("flutes", "int", 1, 1, 12),
            ("flute_len_mm", "float", 10.0, 0.1, 300),
            ("overall_mm", "float", 40.0, 0, 500),
            ("shank_mm", "float", 0.0, 0, 50),
            ("mat", "enum", "carbide", ["carbide", "hss"], None),
            ("coating", "str", "", 0, 60),
            ("feed_factor", "float", 1.0, 0.2, 2.0),
            ("notes", "str", "", 0, 1000),
        ],
    },
    "materials": {
        "fields": [
            ("name", "str", "", 1, 120),
            ("heat", "enum", "metal", HEAT, None),
            ("sfm_carbide", "float", 500, 10, 5000),
            ("sfm_hss", "float", 200, 10, 3000),
            ("fz_ratio", "float", 0.015, 0.001, 0.2),
            ("doc_slot", "float", 0.3, 0.02, 5),
            ("doc_side", "float", 1.0, 0.02, 6),
            ("woc", "float", 0.15, 0.01, 1),
            ("plunge", "float", 0.3, 0.05, 1),
            ("kc", "float", 700, 5, 4000),
            ("notes", "str", "", 0, 1000),
        ],
    },
    "recipes": {
        "fields": [
            ("tool_id", "int", 0, 1, 10**9),
            ("material_id", "int", 0, 1, 10**9),
            ("op", "enum", "profile", OPS, None),
            ("rpm", "float", 0, 0, 100000),
            ("feed_mm", "float", 0, 0, 100000),
            ("plunge_mm", "float", 0, 0, 100000),
            ("doc_mm", "float", 0, 0, 500),
            ("woc_mm", "float", 0, 0, 500),
            ("rating", "int", 3, 1, 5),
            ("notes", "str", "", 0, 1000),
        ],
    },
}

SETTINGS_DEFAULTS = {
    "min_rpm": 5000.0,
    "max_rpm": 24000.0,
    "max_feed_mm": 4000.0,
    "spindle_w": 2200.0,
    "defl_limit_mm": 0.02,
    "units": "mm",
}
SETTINGS_LIMITS = {
    "min_rpm": (0, 100000), "max_rpm": (100, 100000), "max_feed_mm": (10, 100000),
    "spindle_w": (10, 100000), "defl_limit_mm": (0.001, 1),
}

SEED_TOOLS = [
    dict(name="Thrifty Bot 5 mm (undersized)", vendor="Thrifty Bot", kind="flat", nominal_mm=5.0, actual_mm=4.6,
         flutes=1, flute_len_mm=12, overall_mm=50, shank_mm=5.0, mat="carbide", coating="Diamond grit",
         notes="Measured/real cutting diameter is 4.6 mm. Use 4.6 mm in CAM."),
    dict(name="Thrifty Bot 4 mm (undersized)", vendor="Thrifty Bot", kind="flat", nominal_mm=4.0, actual_mm=3.7,
         flutes=1, flute_len_mm=12, overall_mm=50, shank_mm=4.0, mat="hss", coating="Diamond grit",
         notes="Real cutting diameter 3.7 mm. Listed as HSS in the original library; change to carbide if it is."),
    dict(name='1/8" endmill', vendor="", kind="flat", nominal_mm=3.175, actual_mm=2.845,
         flutes=1, flute_len_mm=20, overall_mm=50, shank_mm=3.175, mat="hss"),
    dict(name='1/8" endmill (undersized, careful)', vendor="", kind="flat", nominal_mm=3.175, actual_mm=3.124,
         flutes=1, flute_len_mm=20, overall_mm=50, shank_mm=3.175, mat="hss"),
    dict(name="6 mm endmill", vendor="", kind="flat", nominal_mm=6.0, actual_mm=6.0,
         flutes=1, flute_len_mm=20, overall_mm=50, shank_mm=6.0, mat="carbide"),
    dict(name='2.5" facemill', vendor="", kind="face", nominal_mm=63.5, actual_mm=63.5,
         flutes=4, flute_len_mm=12.7, overall_mm=50, shank_mm=0, mat="hss"),
]
#           name,                 heat,      sfmC, sfmH, fz,    slot, side, woc,  plunge, kc
SEED_MATERIALS = [
    ("Aluminum 6061",        "metal",   1100, 250, 0.019, 0.34, 1.0, 0.15, 0.30, 700),
    ("Brass / Bronze",       "metal",   400, 150, 0.010, 0.20, 0.6, 0.10, 0.30, 1200),
    ("Acrylic (cast)",       "plastic", 1000, 400, 0.020, 0.50, 1.0, 0.30, 0.40, 300),
    ("Polycarbonate",        "plastic", 1100, 400, 0.045, 0.70, 1.0, 0.30, 0.40, 250),
    ("HDPE / UHMW",          "plastic", 1200, 500, 0.030, 0.60, 1.5, 0.40, 0.50, 150),
    ("Delrin / Acetal",      "plastic", 1000, 400, 0.025, 0.50, 1.2, 0.30, 0.40, 250),
    ("Hardwood",             "wood",    1000, 600, 0.020, 0.60, 1.5, 0.40, 0.50, 60),
    ("Softwood / Plywood",   "wood",    1200, 700, 0.025, 0.75, 1.5, 0.50, 0.50, 40),
    ("MDF / Spoilboard",     "wood",    1000, 600, 0.030, 1.00, 1.5, 0.60, 0.50, 50),
    ("Foam (XPS / EVA)",     "wood",    1500, 800, 0.050, 2.00, 3.0, 0.80, 0.60, 5),
    ("Polypropylene (SRPP)", "plastic", 1200, 500, 0.030, 0.60, 1.5, 0.40, 0.50, 150),
]

MAT_KEYS = ["name", "heat", "sfm_carbide", "sfm_hss", "fz_ratio", "doc_slot", "doc_side", "woc", "plunge", "kc"]
SEED_VERSION = 5
# Earlier seed rows -> current ones. Applied only to rows the user never edited.
MATERIAL_UPGRADES = [
    ("Aluminum 6061", "metal", 800, 250, 0.017, 0.30, 1.0, 0.15, 0.30, 700),
    ("Polycarbonate", "plastic", 900, 400, 0.020, 0.50, 1.0, 0.30, 0.40, 250),
]
# Settings the user reported working: (tool name prefix, material, op, fields)
KNOWN_GOOD = [
    ("Thrifty Bot 5 mm", "Aluminum 6061", "slot", dict(
        rpm=24000, feed_mm=1727.2, plunge_mm=508, doc_mm=1.5875, woc_mm=4.6, rating=3,
        notes='Your run: 24,000 rpm, 68 in/min, 0.0625" depth, full slot (0.0028"/tooth).')),
    ("Thrifty Bot 5 mm", "Polycarbonate", "slot", dict(
        rpm=24000, feed_mm=3937, plunge_mm=0, doc_mm=3.175, woc_mm=4.6, rating=3,
        notes='Your run: 24,000 rpm, 155 in/min, 1/8" depth, full slot (0.0065"/tooth). Near the X8 max feed.')),
]

IN_MM = 25.4


def _preset(tool, mat, rpm, feed, plunge, woc, note, ipm=False):
    k = IN_MM if ipm else 1
    return (tool, mat, "slot", dict(rpm=rpm, feed_mm=round(feed * k, 1), plunge_mm=round(plunge * k, 1), doc_mm=0,
                                    woc_mm=woc, rating=3, notes="From omio-tools.tools preset (tested). " + note))


_NODOC = "Depth of cut not recorded in the file."
KNOWN_GOOD += [
    _preset("Thrifty Bot 5 mm", "Polypropylene (SRPP)", 22000, 2032, 1016, 4.6, _NODOC),
    _preset("Thrifty Bot 4 mm", "Aluminum 6061", 20000, 1320.8, 508, 3.7, _NODOC),
    _preset("Thrifty Bot 4 mm", "Polycarbonate", 20000, 2286, 1016, 3.7, _NODOC),
    _preset("6 mm endmill", "Aluminum 6061", 11000, 254, 254, 6.0, _NODOC),
    _preset("6 mm endmill", "Polycarbonate", 22000, 3937, 254, 6.0, _NODOC),
    _preset('1/8" endmill', "Aluminum 6061", 9500, 10, 10, 2.845, _NODOC, ipm=True),
    _preset('1/8" endmill', "Polycarbonate", 20000, 40, 10, 2.845, _NODOC, ipm=True),
    _preset('1/8" endmill (undersized', "Aluminum 6061", 9500, 10, 10, 3.124, _NODOC, ipm=True),
    _preset('1/8" endmill (undersized', "Polycarbonate", 20000, 40, 10, 3.124, _NODOC, ipm=True),
]

_db_lock = threading.Lock()


@contextlib.contextmanager
def connect():
    """Open the DB; commit on success, roll back on error, always close."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DATA_DIR / "cnc.sqlite3", timeout=10)
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
    return {"str": "TEXT", "enum": "TEXT", "int": "INTEGER", "float": "REAL"}[kind]


def sql_default(f):
    if f[1] in ("str", "enum"):
        return "'" + str(f[2]).replace("'", "''") + "'"
    return repr(f[2])


def init_db():
    with _db_lock, connect() as con:
        for table, spec in ENTITIES.items():
            cols = ",".join(f"{f[0]} {sql_type(f[1])} NOT NULL DEFAULT {sql_default(f)}"
                            for f in spec["fields"])
            con.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols},"
                        " updated_at REAL NOT NULL DEFAULT 0)")
        con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        seeded = con.execute("SELECT 1 FROM settings WHERE key='seeded'").fetchone()
        if not seeded:
            for t in SEED_TOOLS:
                insert(con, "tools", clean("tools", t))
            for m in SEED_MATERIALS:
                insert(con, "materials", clean("materials", dict(zip(MAT_KEYS, m))))
            con.execute("INSERT INTO settings(key,value) VALUES('seeded','1')")
        upgrade_seed(con)
        con.commit()


def upgrade_seed(con):
    """Bring seeded materials and known-good settings up to date without overwriting the user's edits."""
    row = con.execute("SELECT value FROM settings WHERE key='seed_version'").fetchone()
    if row and int(row["value"]) >= SEED_VERSION:
        return
    cond = " AND ".join(f"{k}=?" for k in MAT_KEYS)
    for old in MATERIAL_UPGRADES:
        new = next(m for m in SEED_MATERIALS if m[0] == old[0])
        sets = ",".join(f"{k}=?" for k in MAT_KEYS[1:])
        for r in con.execute(f"SELECT id FROM materials WHERE {cond}", old).fetchall():
            con.execute(f"UPDATE materials SET {sets},updated_at=? WHERE id=?", list(new[1:]) + [time.time(), r["id"]])
    # Thrifty Bot endmills: 12 mm cutting length, diamond grit coating (only rows still at the old seed values).
    con.execute("UPDATE tools SET flute_len_mm=12, coating='Diamond grit', updated_at=? WHERE name LIKE 'Thrifty Bot%'"
                " AND flute_len_mm=20 AND overall_mm=50 AND coating=''", (time.time(),))
    for m in SEED_MATERIALS:
        if not con.execute("SELECT 1 FROM materials WHERE name=?", (m[0],)).fetchone():
            insert(con, "materials", clean("materials", dict(zip(MAT_KEYS, m))))
    for tool_prefix, mat_name, op, fields in KNOWN_GOOD:
        tool = con.execute("SELECT id FROM tools WHERE name LIKE ? ORDER BY id LIMIT 1", (tool_prefix + "%",)).fetchone()
        mat = con.execute("SELECT id FROM materials WHERE name=? ORDER BY id LIMIT 1", (mat_name,)).fetchone()
        if tool and mat and not con.execute("SELECT 1 FROM recipes WHERE tool_id=? AND material_id=? AND op=?",
                                            (tool["id"], mat["id"], op)).fetchone():
            insert(con, "recipes", clean("recipes", dict(fields, tool_id=tool["id"], material_id=mat["id"], op=op)))
    con.execute("INSERT INTO settings(key,value) VALUES('seed_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SEED_VERSION),))


class ValidationError(ValueError):
    pass


def clean(table, data):
    """Validate/normalise a payload against the table's field specs."""
    if not isinstance(data, dict):
        raise ValidationError("Expected an object")
    out = {}
    for name, kind, default, a, b in ENTITIES[table]["fields"]:
        v = data.get(name, default)
        if kind == "str":
            v = str(v if v is not None else "").strip()
            if not (a <= len(v) <= b):
                raise ValidationError(f"{name}: length must be {a}-{b}")
        elif kind == "enum":
            if v not in a:
                raise ValidationError(f"{name}: must be one of {', '.join(a)}")
        else:
            try:
                v = int(v) if kind == "int" else float(v)
            except (TypeError, ValueError):
                raise ValidationError(f"{name}: must be a number")
            if v != v or not (a <= v <= b):
                raise ValidationError(f"{name}: must be between {a} and {b}")
        out[name] = v
    return out


def insert(con, table, row):
    cols = list(row)
    cur = con.execute(
        f"INSERT INTO {table} ({','.join(cols)},updated_at) VALUES ({','.join('?' * len(cols))},?)",
        [row[c] for c in cols] + [time.time()])
    return cur.lastrowid


def rows(con, table):
    return [dict(r) for r in con.execute(f"SELECT * FROM {table} ORDER BY id")]


def get_settings(con):
    s = dict(SETTINGS_DEFAULTS)
    for r in con.execute("SELECT key,value FROM settings WHERE key NOT IN ('seeded','seed_version')"):
        if r["key"] in s:
            s[r["key"]] = r["value"] if r["key"] == "units" else float(r["value"])
    return s


def clean_settings(data):
    if not isinstance(data, dict):
        raise ValidationError("Expected an object")
    out = {}
    for k, default in SETTINGS_DEFAULTS.items():
        v = data.get(k, default)
        if k == "units":
            if v not in ("mm", "in"):
                raise ValidationError("units: must be mm or in")
        else:
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise ValidationError(f"{k}: must be a number")
            lo, hi = SETTINGS_LIMITS[k]
            if not (lo <= v <= hi):
                raise ValidationError(f"{k}: must be between {lo} and {hi}")
        out[k] = v
    if out["min_rpm"] >= out["max_rpm"]:
        raise ValidationError("min_rpm must be below max_rpm")
    return out


# --------------------------------------------------------------------------
# Auth: signed cookie after logging in with ADMIN_PASSWORD
# --------------------------------------------------------------------------
def _key():
    f = DATA_DIR / "session.key"
    if not f.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        f.write_text(secrets.token_hex(32))
        os.chmod(f, 0o600)
    return hashlib.sha256((f.read_text() + "|" + ADMIN_PASSWORD).encode()).digest()


def make_token():
    exp = str(int(time.time()) + SESSION_SECONDS)
    return exp + "." + hmac.new(_key(), exp.encode(), "sha256").hexdigest()


def valid_token(token):
    if not ADMIN_PASSWORD or not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, hmac.new(_key(), exp.encode(), "sha256").hexdigest())


_fail = {}
_fail_lock = threading.Lock()


def throttled(ip):
    with _fail_lock:
        n, until = _fail.get(ip, (0, 0))
        return until > time.time()


def record_login(ip, ok):
    with _fail_lock:
        if ok:
            _fail.pop(ip, None)
            return
        if len(_fail) > 1000:
            _fail.clear()
        n, _ = _fail.get(ip, (0, 0))
        n += 1
        _fail[ip] = (n, time.time() + min(2 ** n, 300) if n >= 5 else 0)


# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "CNCCalc"
    protocol_version = "HTTP/1.1"
    timeout = 15  # seconds; drops stalled/slow clients

    def log_message(self, fmt, *args):
        if "timed out" in fmt:  # idle keep-alive connections closing; not interesting
            return
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    # -- helpers --
    def ip(self):
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header("Cache-Control", "no-store" if ctype.startswith("application/json") else "no-cache")
        if self.close_connection:
            self.send_header("Connection", "close")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def err(self, code, msg):
        self.send(code, {"error": msg})

    def cookie(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def is_admin(self):
        return valid_token(self.cookie())

    def secure_flag(self):
        return "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""

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

    def read_body(self):
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
        if n > MAX_BODY:
            self.close_connection = True
            return self.err(413, "Request too large")
        self._raw = self.rfile.read(n) if n else b""
        return None

    def json_body(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValidationError("Content-Type must be application/json")
        try:
            return json.loads(self._raw or b"null")
        except ValueError:
            raise ValidationError("Invalid JSON")

    def same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urlparse(origin).netloc
        return host in (self.headers.get("Host"), self.headers.get("X-Forwarded-Host"))

    # -- routing --
    def do_HEAD(self):
        self.guard(self.get)

    def do_GET(self):
        self.guard(self.get)

    def get(self):
        if self.headers.get("Content-Length", "0") not in ("", "0") or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send(200, {"ok": True})
        if path == "/api/state":
            with _db_lock, connect() as con:
                state = {t: rows(con, t) for t in ENTITIES}
                state["settings"] = get_settings(con)
            state["admin"] = self.is_admin()
            state["admin_configured"] = bool(ADMIN_PASSWORD)
            return self.send(200, state)
        if path == "/api/export":
            if not self.is_admin():
                return self.err(401, "Admin login required")
            with _db_lock, connect() as con:
                data = {t: rows(con, t) for t in ENTITIES}
                data["settings"] = get_settings(con)
            return self.send(200, data, extra={"Content-Disposition": 'attachment; filename="cnc-data.json"'})
        if path.startswith("/api/"):
            return self.err(404, "Not found")
        self.static(path)

    def static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self.err(404, "Not found")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self.send(200, f.read_bytes(), ctype)

    def do_POST(self):
        self.guard(lambda: self.mutate("POST"))

    def do_PUT(self):
        self.guard(lambda: self.mutate("PUT"))

    def do_DELETE(self):
        self.guard(lambda: self.mutate("DELETE"))

    def mutate(self, method):
        if self.read_body() is not None or self.close_connection:
            return
        if not self.same_origin():
            return self.err(403, "Cross-origin request blocked")
        path = urlparse(self.path).path.strip("/").split("/")
        try:
            if path == ["api", "login"] and method == "POST":
                return self.login()
            if path == ["api", "logout"] and method == "POST":
                return self.send(200, {"ok": True},
                                 extra={"Set-Cookie": f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{self.secure_flag()}"})
            if path[:1] != ["api"] or len(path) < 2:
                return self.err(404, "Not found")
            if not self.is_admin():
                return self.err(401, "Admin login required")
            if path[1] == "settings" and method == "PUT" and len(path) == 2:
                data = clean_settings(self.json_body())
                with _db_lock, connect() as con:
                    for k, v in data.items():
                        con.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                    (k, str(v)))
                return self.send(200, data)
            table = path[1]
            if table not in ENTITIES:
                return self.err(404, "Not found")
            code, obj = self.entity(method, table, path[2:])
            return self.send(code, obj)
        except ValidationError as e:
            return self.err(400, str(e))
        except sqlite3.IntegrityError as e:
            return self.err(409, str(e))

    def login(self):
        ip = self.ip()
        if not ADMIN_PASSWORD:
            return self.err(403, "ADMIN_PASSWORD is not set on the server")
        if throttled(ip):
            return self.err(429, "Too many attempts; wait a bit")
        data = self.json_body()
        pw = str(data.get("password", "")) if isinstance(data, dict) else ""
        ok = hmac.compare_digest(hashlib.sha256(pw.encode()).digest(), hashlib.sha256(ADMIN_PASSWORD.encode()).digest())
        record_login(ip, ok)
        if not ok:
            time.sleep(0.5)
            return self.err(401, "Wrong password")
        cookie = f"{COOKIE}={make_token()}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict{self.secure_flag()}"
        return self.send(200, {"ok": True}, extra={"Set-Cookie": cookie})

    def entity(self, method, table, rest):
        """Returns (status, payload). The DB lock is released before anything is written to the socket."""
        with _db_lock, connect() as con:
            if method == "POST" and not rest:
                data = self.json_body()
                if isinstance(data, list):  # bulk import (all-or-nothing)
                    if len(data) > 500:
                        raise ValidationError("Too many rows (max 500)")
                    return 201, {"ids": [insert(con, table, self.check(con, table, d)) for d in data]}
                return 201, {"id": insert(con, table, self.check(con, table, data))}
            if len(rest) == 1 and rest[0].isdigit():
                rid = int(rest[0])
                if not con.execute(f"SELECT 1 FROM {table} WHERE id=?", (rid,)).fetchone():
                    return 404, {"error": "Not found"}
                if method == "PUT":
                    row = self.check(con, table, self.json_body())
                    sets = ",".join(f"{c}=?" for c in row)
                    con.execute(f"UPDATE {table} SET {sets},updated_at=? WHERE id=?", list(row.values()) + [time.time(), rid])
                    return 200, {"id": rid}
                if method == "DELETE":
                    if table in ("tools", "materials"):  # remove dependent saved settings
                        col = "tool_id" if table == "tools" else "material_id"
                        con.execute(f"DELETE FROM recipes WHERE {col}=?", (rid,))
                    con.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
                    return 200, {"ok": True}
        return 405, {"error": "Method not allowed"}

    def check(self, con, table, data):
        row = clean(table, data)
        if table == "recipes":
            for col, ref in (("tool_id", "tools"), ("material_id", "materials")):
                if not con.execute(f"SELECT 1 FROM {ref} WHERE id=?", (row[col],)).fetchone():
                    raise ValidationError(f"{col}: unknown id")
        return row


def make_server(host, port):
    init_db()
    return ThreadingHTTPServer((host, port), Handler)


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    srv = make_server(host, port)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=srv.shutdown).start())
    print(f"Listening on {host}:{port}, data in {DATA_DIR}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
