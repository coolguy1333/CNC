#!/usr/bin/env python3
"""CNC Feeds & Speeds: tiny stdlib-only web app (HTTP + SQLite).

Runs under WebManager app hosting: listens on $HOST:$PORT, keeps data in
$DATA_DIR, answers /api/health, and stops cleanly on SIGTERM.
Reading is public; changing tools/materials/recipes/settings needs the
ADMIN_PASSWORD.
"""
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
    "min_rpm": 6000.0,
    "max_rpm": 24000.0,
    "max_feed_mm": 6000.0,
    "spindle_w": 1000.0,
    "defl_limit_mm": 0.02,
    "units": "mm",
}
SETTINGS_LIMITS = {
    "min_rpm": (0, 100000), "max_rpm": (100, 100000), "max_feed_mm": (10, 100000),
    "spindle_w": (10, 100000), "defl_limit_mm": (0.001, 1),
}

SEED_TOOLS = [
    dict(name="Thrifty Bot 5 mm (undersized)", vendor="Thrifty Bot", kind="flat", nominal_mm=5.0, actual_mm=4.6,
         flutes=1, flute_len_mm=20, overall_mm=50, shank_mm=5.0, mat="carbide",
         notes="Measured/real cutting diameter is 4.6 mm. Use 4.6 mm in CAM."),
    dict(name="Thrifty Bot 4 mm (undersized)", vendor="Thrifty Bot", kind="flat", nominal_mm=4.0, actual_mm=3.7,
         flutes=1, flute_len_mm=20, overall_mm=50, shank_mm=4.0, mat="hss",
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
    ("Aluminum 6061",        "metal",   800, 250, 0.017, 0.30, 1.0, 0.15, 0.30, 700),
    ("Brass / Bronze",       "metal",   400, 150, 0.010, 0.20, 0.6, 0.10, 0.30, 1200),
    ("Acrylic (cast)",       "plastic", 1000, 400, 0.020, 0.50, 1.0, 0.30, 0.40, 300),
    ("Polycarbonate",        "plastic", 900, 400, 0.020, 0.50, 1.0, 0.30, 0.40, 250),
    ("HDPE / UHMW",          "plastic", 1200, 500, 0.030, 0.60, 1.5, 0.40, 0.50, 150),
    ("Delrin / Acetal",      "plastic", 1000, 400, 0.025, 0.50, 1.2, 0.30, 0.40, 250),
    ("Hardwood",             "wood",    1000, 600, 0.020, 0.60, 1.5, 0.40, 0.50, 60),
    ("Softwood / Plywood",   "wood",    1200, 700, 0.025, 0.75, 1.5, 0.50, 0.50, 40),
    ("MDF / Spoilboard",     "wood",    1000, 600, 0.030, 1.00, 1.5, 0.60, 0.50, 50),
    ("Foam (XPS / EVA)",     "wood",    1500, 800, 0.050, 2.00, 3.0, 0.80, 0.60, 5),
]

_db_lock = threading.Lock()


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DATA_DIR / "cnc.sqlite3", timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def sql_type(kind):
    return {"str": "TEXT", "enum": "TEXT", "int": "INTEGER", "float": "REAL"}[kind]


def init_db():
    with _db_lock, connect() as con:
        for table, spec in ENTITIES.items():
            cols = ",".join(f"{f[0]} {sql_type(f[1])} NOT NULL DEFAULT {json.dumps(f[2]) if f[1] in ('str', 'enum') else f[2]}"
                            for f in spec["fields"])
            con.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY AUTOINCREMENT, {cols},"
                        " updated_at REAL NOT NULL DEFAULT 0)")
        con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        seeded = con.execute("SELECT 1 FROM settings WHERE key='seeded'").fetchone()
        if not seeded:
            for t in SEED_TOOLS:
                insert(con, "tools", clean("tools", t))
            for m in SEED_MATERIALS:
                keys = ["name", "heat", "sfm_carbide", "sfm_hss", "fz_ratio", "doc_slot", "doc_side", "woc", "plunge", "kc"]
                insert(con, "materials", clean("materials", dict(zip(keys, m))))
            con.execute("INSERT INTO settings(key,value) VALUES('seeded','1')")
        con.commit()


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
    for r in con.execute("SELECT key,value FROM settings WHERE key != 'seeded'"):
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
        n, _ = _fail.get(ip, (0, 0))
        n += 1
        _fail[ip] = (n, time.time() + min(2 ** n, 300) if n >= 5 else 0)


# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "CNCCalc"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
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
                         "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store" if ctype == "application/json" else "no-cache")
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

    def body(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValidationError("Content-Type must be application/json")
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValidationError("Request too large")
        try:
            return json.loads(self.rfile.read(n) or b"null")
        except ValueError:
            raise ValidationError("Invalid JSON")

    def secure_flag(self):
        return "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""

    # -- routing --
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
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
            ctype += "; charset=utf-8" if "charset" not in ctype else ""
        self.send(200, f.read_bytes(), ctype)

    def do_POST(self):
        self.mutate("POST")

    def do_PUT(self):
        self.mutate("PUT")

    def do_DELETE(self):
        self.mutate("DELETE")

    def mutate(self, method):
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
                data = clean_settings(self.body())
                with _db_lock, connect() as con:
                    for k, v in data.items():
                        con.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                    (k, str(v)))
                    con.commit()
                return self.send(200, data)
            table = path[1]
            if table not in ENTITIES:
                return self.err(404, "Not found")
            return self.entity(method, table, path[2:])
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
        data = self.body()
        pw = str(data.get("password", "")) if isinstance(data, dict) else ""
        ok = hmac.compare_digest(hashlib.sha256(pw.encode()).digest(), hashlib.sha256(ADMIN_PASSWORD.encode()).digest())
        record_login(ip, ok)
        if not ok:
            time.sleep(0.5)
            return self.err(401, "Wrong password")
        cookie = f"{COOKIE}={make_token()}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict{self.secure_flag()}"
        return self.send(200, {"ok": True}, extra={"Set-Cookie": cookie})

    def entity(self, method, table, rest):
        with _db_lock, connect() as con:
            if method == "POST" and not rest:
                data = self.body()
                if isinstance(data, list):  # bulk import
                    if len(data) > 500:
                        raise ValidationError("Too many rows (max 500)")
                    ids = [insert(con, table, self.check(con, table, d)) for d in data]
                    con.commit()
                    return self.send(201, {"ids": ids})
                new_id = insert(con, table, self.check(con, table, data))
                con.commit()
                return self.send(201, {"id": new_id})
            if len(rest) == 1 and rest[0].isdigit():
                rid = int(rest[0])
                if not con.execute(f"SELECT 1 FROM {table} WHERE id=?", (rid,)).fetchone():
                    return self.err(404, "Not found")
                if method == "PUT":
                    row = self.check(con, table, self.body())
                    sets = ",".join(f"{c}=?" for c in row)
                    con.execute(f"UPDATE {table} SET {sets},updated_at=? WHERE id=?", list(row.values()) + [time.time(), rid])
                    con.commit()
                    return self.send(200, {"id": rid})
                if method == "DELETE":
                    if table in ("tools", "materials"):  # remove dependent recipes
                        col = "tool_id" if table == "tools" else "material_id"
                        con.execute(f"DELETE FROM recipes WHERE {col}=?", (rid,))
                    con.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
                    con.commit()
                    return self.send(200, {"ok": True})
        return self.err(405, "Method not allowed")

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
