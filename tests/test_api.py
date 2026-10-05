import http.client
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATA_DIR"] = tempfile.mkdtemp()
import server  # noqa: E402

server.RATE_CAP, server.RATE_REFILL = 100000, 100000


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_dir = server.DATA_DIR
        server.DATA_DIR = Path(tempfile.mkdtemp())  # every test class gets its own pristine database
        cls.srv = server.make_server("127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        server.DATA_DIR = cls._old_dir

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        data = raw if raw is not None else (json.dumps(body) if body is not None else None)
        c.request(method, path, data, h)
        r = c.getresponse()
        out = r.read()
        hdrs = dict(r.getheaders())
        c.close()
        try:
            out = json.loads(out)
        except ValueError:
            pass
        return r.status, out, hdrs

    def state(self):
        return self.req("GET", "/api/state")[1]

    def tool(self, **kw):
        body = dict(name="Test tool", kind="flat", nominal_mm=5, actual_mm=4.6, flutes=1, flute_len_mm=12, overall_mm=50)
        body.update(kw)
        st, out, _ = self.req("POST", "/api/tools", body)
        self.assertEqual(st, 201, out)
        return out["id"]


class SeedAndStateTest(Base):
    def setUp(self):
        for suffix in ("", "-wal", "-shm"):
            Path(str(server.db_path()) + suffix).unlink(missing_ok=True)
        server.init_db()

    def test_health_and_seed(self):
        self.assertEqual(self.req("GET", "/api/health")[1]["ok"], True)
        st = self.state()
        names = [t["name"] for t in st["tools"]]
        self.assertIn("Thrifty Bot 5 mm", names)
        self.assertIn('2.5" facemill', names)
        self.assertNotIn("materials", st)
        self.assertEqual(len(st["tools"]), 6)
        self.assertEqual(len(st["recipes"]), 12)
        self.assertEqual(len(st["maintenance"]), 6)
        self.assertEqual(st["settings"]["max_rpm"], 24000)
        self.assertEqual(st["settings"]["max_feed_mm"], 4000)
        self.assertEqual(st["settings"]["units"], "in")

    def test_tested_settings_match_the_team_file(self):
        st = self.state()
        tools = {t["id"]: t for t in st["tools"]}
        by = {(tools[r["tool_id"]]["name"], r["material"], r["label"]): r for r in st["recipes"]}
        r = by[("Thrifty Bot 5 mm", "aluminum", "Aluminum")]
        self.assertEqual((r["rpm"], r["feed_mm"], r["plunge_mm"], r["ramp_mm"]), (24000, 1727.2, 508, 1143))
        r = by[("Thrifty Bot 5 mm", "polycarbonate", "Poly")]
        self.assertEqual((r["rpm"], r["feed_mm"]), (24000, 3937))
        r = by[('2.5" facemill', "spoilboard", "Default preset")]
        self.assertEqual((r["rpm"], r["feed_mm"]), (5000, 762))
        mats = {r["material"] for r in st["recipes"]}
        self.assertEqual(mats, {"aluminum", "polycarbonate", "spoilboard"})
        t4 = next(t for t in st["tools"] if t["name"] == "Thrifty Bot 4 mm")
        self.assertEqual((t4["mat"], t4["overall_mm"], t4["flute_len_mm"]), ("carbide", 45, 12))

    def test_rev_changes_on_write(self):
        a = self.req("GET", "/api/rev")[1]["rev"]
        self.tool(name="rev tool")
        self.assertGreater(self.req("GET", "/api/rev")[1]["rev"], a)


class CrudTest(Base):
    def test_tool_crud_and_cascade(self):
        tid = self.tool(name="Cascade")
        st, out, _ = self.req("POST", "/api/recipes", dict(tool_id=tid, material="aluminum", op="slot", rpm=24000, feed_mm=1500))
        self.assertEqual(st, 201, out)
        rid = out["id"]
        # partial PUT keeps the other fields
        self.assertEqual(self.req("PUT", f"/api/tools/{tid}", {"notes": "hi"})[0], 200)
        t = next(t for t in self.state()["tools"] if t["id"] == tid)
        self.assertEqual((t["notes"], t["actual_mm"], t["name"]), ("hi", 4.6, "Cascade"))
        st, out, _ = self.req("DELETE", f"/api/tools/{tid}")
        self.assertEqual((st, out["removed_recipes"]), (200, 1))
        self.assertFalse([r for r in self.state()["recipes"] if r["id"] == rid])
        self.assertEqual(self.req("DELETE", f"/api/tools/{tid}")[0], 404)

    def test_bulk_create_is_all_or_nothing(self):
        before = len(self.state()["tools"])
        good = dict(name="a", nominal_mm=3, actual_mm=3)
        bad = dict(name="b", nominal_mm=3, actual_mm=300)
        self.assertEqual(self.req("POST", "/api/tools", [good, bad])[0], 400)
        self.assertEqual(len(self.state()["tools"]), before)
        st, out, _ = self.req("POST", "/api/tools", [good, dict(good, name="c")])
        self.assertEqual((st, len(out["ids"])), (201, 2))

    def test_validation(self):
        base = dict(name="x", nominal_mm=3, actual_mm=3)
        for bad in (dict(base, kind="laser"), dict(base, nominal_mm=-1), dict(base, flutes=0), dict(base, flutes=1.5),
                    dict(base, name=""), dict(base, name="x" * 500), dict(base, bogus=1), dict(base, actual_mm="abc"),
                    dict(base, nominal_mm=True), dict(base, actual_mm=9), dict(base, flute_len_mm=60, overall_mm=40)):
            self.assertEqual(self.req("POST", "/api/tools", bad)[0], 400, bad)
        self.assertEqual(self.req("POST", "/api/tools", raw='{"name":"x","nominal_mm":NaN}')[0], 400)
        self.assertEqual(self.req("POST", "/api/tools", raw="not json")[0], 400)
        self.assertEqual(self.req("POST", "/api/tools", raw="[1,2]")[0], 400)
        self.assertEqual(self.req("POST", "/api/tools", base, headers={"Content-Type": "text/plain"})[0], 400)

    def test_recipes_only_allow_the_three_materials(self):
        tid = self.tool(name="mats")
        for mat in ("steel", "mdf", "srpp", ""):
            self.assertEqual(self.req("POST", "/api/recipes", dict(tool_id=tid, material=mat, op="slot"))[0], 400, mat)
        self.assertEqual(self.req("POST", "/api/recipes", dict(tool_id=99999, material="aluminum", op="slot"))[0], 400)
        self.assertEqual(self.req("POST", "/api/recipes", dict(tool_id=0, material="aluminum", op="slot"))[0], 400)
        self.assertEqual(self.req("POST", "/api/recipes", dict(tool_id=tid, material="spoilboard", op="surface"))[0], 201)

    def test_joblog_inventory_maintenance(self):
        st, out, _ = self.req("POST", "/api/joblog", dict(name="Gusset", material="aluminum", result="great", minutes=12.5))
        self.assertEqual(st, 201)
        log = self.req("GET", "/api/joblog")[1]
        self.assertEqual(len(log), 1)
        self.assertRegex(log[0]["date"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(self.req("POST", "/api/joblog", dict(name="x", date="2026-13-45"))[0], 400)
        self.assertEqual(self.req("POST", "/api/joblog", dict(name="x", date="Jan 3"))[0], 400)
        self.assertEqual(self.req("POST", "/api/joblog", dict(name="x", tool_id=424242))[0], 400)
        tid = self.tool(name="logged")
        lid = self.req("POST", "/api/joblog", dict(name="uses tool", tool_id=tid))[1]["id"]
        self.req("DELETE", f"/api/tools/{tid}")
        self.assertEqual(next(j for j in self.req("GET", "/api/joblog")[1] if j["id"] == lid)["tool_id"], 0)
        st, out, _ = self.req("POST", "/api/inventory", dict(name="1/4-20 x 1/2 SHCS", category="hardware", qty=100, min_qty=20, unit="ea"))
        self.assertEqual(st, 201)
        self.assertEqual(self.req("POST", "/api/inventory", dict(name="x", category="gold"))[0], 400)
        self.assertEqual(self.req("POST", "/api/inventory", dict(name="x", qty=-1))[0], 400)
        mid = self.state()["maintenance"][0]["id"]
        self.assertEqual(self.req("PUT", f"/api/maintenance/{mid}", {"last_done": "2026-01-31"})[0], 200)
        self.assertEqual(next(m for m in self.state()["maintenance"] if m["id"] == mid)["last_done"], "2026-01-31")

    def test_settings(self):
        st, out, _ = self.req("PUT", "/api/settings", {"max_rpm": 18000, "units": "mm"})
        self.assertEqual(st, 200, out)
        s = self.state()["settings"]
        self.assertEqual((s["max_rpm"], s["units"], s["max_feed_mm"]), (18000, "mm", 4000))  # partial update keeps the rest
        for bad in ({"max_rpm": 100, "min_rpm": 200}, {"units": "cubits"}, {"max_feed_mm": -5}, {"nope": 1}, {"max_rpm": "fast"}):
            self.assertEqual(self.req("PUT", "/api/settings", bad)[0], 400, bad)
        self.req("PUT", "/api/settings", {"max_rpm": 24000, "units": "in"})

    def test_row_cap(self):
        old = server.ENTITIES["inventory"]["cap"]
        n = len(self.req("GET", "/api/inventory")[1])
        server.ENTITIES["inventory"]["cap"] = n + 1
        try:
            self.assertEqual(self.req("POST", "/api/inventory", dict(name="one"))[0], 201)
            st, out, _ = self.req("POST", "/api/inventory", dict(name="two"))
            self.assertEqual(st, 400)
            self.assertIn("full", out["error"])
        finally:
            server.ENTITIES["inventory"]["cap"] = old


class BackupTest(Base):
    def test_export_import_roundtrip(self):
        self.tool(name="Roundtrip")
        st, data, hdr = self.req("GET", "/api/export")
        self.assertEqual(st, 200)
        self.assertIn("attachment", hdr["Content-Disposition"])
        self.assertEqual(self.req("POST", "/api/import", data)[0], 200)
        after = self.req("GET", "/api/export")[1]
        for k in ("tools", "recipes", "inventory", "maintenance", "settings"):
            self.assertEqual([{**r, "updated_at": 0} if isinstance(r, dict) else r for r in data[k]] if k != "settings" else data[k],
                             [{**r, "updated_at": 0} if isinstance(r, dict) else r for r in after[k]] if k != "settings" else after[k], k)

    def test_bad_import_changes_nothing(self):
        before = self.req("GET", "/api/export")[1]["tools"]
        bad = self.req("GET", "/api/export")[1]
        bad["tools"][0]["flutes"] = 99
        self.assertEqual(self.req("POST", "/api/import", bad)[0], 400)
        self.assertEqual(self.req("POST", "/api/import", {"tools": "nope"})[0], 400)
        orphan = {"tools": [], "recipes": [dict(tool_id=5, material="aluminum", op="slot")]}
        self.assertEqual(self.req("POST", "/api/import", orphan)[0], 400)
        self.assertEqual(self.req("GET", "/api/export")[1]["tools"], before)

    def test_import_version1_export(self):
        v1 = {"tools": [dict(id=3, name="Old tool", nominal_mm=5, actual_mm=4.6)],
              "materials": [dict(id=1, name="Aluminum 6061"), dict(id=2, name="Brass / Bronze")],
              "recipes": [dict(tool_id=3, material_id=1, op="slot", rpm=24000, feed_mm=1700),
                          dict(tool_id=3, material_id=2, op="slot", rpm=9000, feed_mm=300)],
              "settings": {"max_rpm": 24000, "min_rpm": 5000, "max_feed_mm": 4000, "spindle_w": 2200, "defl_limit_mm": 0.02, "units": "mm"}}
        keep = self.req("GET", "/api/export")[1]
        try:
            self.assertEqual(self.req("POST", "/api/import", v1)[0], 200)
            st = self.state()
            self.assertEqual([t["name"] for t in st["tools"]], ["Old tool"])
            self.assertEqual([(r["material"], r["rpm"]) for r in st["recipes"]], [("aluminum", 24000)])
        finally:
            self.req("POST", "/api/import", keep)

    def test_backups_list_create_restore(self):
        st, out, _ = self.req("POST", "/api/backups")
        self.assertEqual(st, 201)
        name = out["name"]
        self.assertRegex(name, server.BACKUP_RE.pattern)
        self.assertIn(name, [b["name"] for b in self.req("GET", "/api/backups")[1]["backups"]])
        marker = self.tool(name="after-backup")
        self.assertEqual(self.req("POST", "/api/backups/restore", {"name": name})[0], 200)
        self.assertFalse([t for t in self.state()["tools"] if t["id"] == marker])
        for bad in ("../cnc.sqlite3", "/etc/passwd", "shop-20200101-000000-x.sqlite3", "", None, 5):
            self.assertEqual(self.req("POST", "/api/backups/restore", {"name": bad})[0], 400, bad)

    def test_restore_defaults_adds_missing_but_keeps_edits(self):
        st = self.state()
        facemill = next(t for t in st["tools"] if t["name"] == '2.5" facemill')
        self.req("PUT", f"/api/tools/{facemill['id']}", {"notes": "ours"})
        self.req("DELETE", f"/api/tools/{next(t for t in st['tools'] if t['name'] == '6 mm endmill')['id']}")
        self.assertEqual(self.req("POST", "/api/restore-defaults", {})[0], 200)
        st = self.state()
        self.assertTrue([t for t in st["tools"] if t["name"] == "6 mm endmill"])
        self.assertEqual(next(t for t in st["tools"] if t["name"] == '2.5" facemill')["notes"], "ours")


class MigrationTest(unittest.TestCase):
    def test_version1_database_is_converted_without_losing_tools(self):
        old_dir = server.DATA_DIR
        server.DATA_DIR = Path(tempfile.mkdtemp())
        try:
            con = sqlite3.connect(server.DATA_DIR / server.DB_FILE)
            con.executescript("""
CREATE TABLE tools (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL DEFAULT 'flat', nominal_mm REAL NOT NULL DEFAULT 3, actual_mm REAL NOT NULL DEFAULT 3,
 flutes INTEGER NOT NULL DEFAULT 1, flute_len_mm REAL NOT NULL DEFAULT 10, overall_mm REAL NOT NULL DEFAULT 40,
 shank_mm REAL NOT NULL DEFAULT 0, mat TEXT NOT NULL DEFAULT 'carbide', coating TEXT NOT NULL DEFAULT '',
 feed_factor REAL NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL DEFAULT 0);
CREATE TABLE materials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', heat TEXT DEFAULT 'metal',
 notes TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL DEFAULT 0);
CREATE TABLE recipes (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id INTEGER NOT NULL DEFAULT 0, material_id INTEGER NOT NULL DEFAULT 0,
 op TEXT NOT NULL DEFAULT 'profile', rpm REAL NOT NULL DEFAULT 0, feed_mm REAL NOT NULL DEFAULT 0, plunge_mm REAL NOT NULL DEFAULT 0,
 doc_mm REAL NOT NULL DEFAULT 0, woc_mm REAL NOT NULL DEFAULT 0, rating INTEGER NOT NULL DEFAULT 3, notes TEXT NOT NULL DEFAULT '',
 updated_at REAL NOT NULL DEFAULT 0);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO tools(name,nominal_mm,actual_mm,flute_len_mm,overall_mm,mat,notes) VALUES ('Thrifty Bot 5 mm (undersized)',5,4.6,12,50,'carbide','mine');
INSERT INTO tools(name,nominal_mm,actual_mm,flute_len_mm,overall_mm,mat) VALUES ('Thrifty Bot 4 mm (undersized)',4,3.7,12,50,'hss');
INSERT INTO tools(name,nominal_mm,actual_mm,mat) VALUES ('My custom 3 mm',3,2.9,'carbide');
INSERT INTO materials(name) VALUES ('Aluminum 6061'),('Brass / Bronze'),('Polycarbonate');
INSERT INTO recipes(tool_id,material_id,op,rpm,feed_mm,notes) VALUES (1,1,'slot',24000,1727.2,'Your run: 24,000 rpm');
INSERT INTO recipes(tool_id,material_id,op,rpm,feed_mm,notes) VALUES (3,1,'profile',18000,900,'my own');
INSERT INTO recipes(tool_id,material_id,op,rpm,feed_mm,notes) VALUES (3,2,'profile',9000,300,'brass, unsupported now');
INSERT INTO recipes(tool_id,material_id,op,rpm,feed_mm,notes) VALUES (3,3,'slot',20000,2000,'poly');
INSERT INTO settings VALUES ('seeded','1'),('seed_version','5'),('max_rpm','20000');
""")
            con.commit()
            con.close()
            server.init_db()
            with server.connect() as c:
                tools = {r["name"]: dict(r) for r in c.execute("SELECT * FROM tools")}
                recipes = [dict(r) for r in c.execute("SELECT * FROM recipes")]
                tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                s = server.get_settings(c)
            self.assertNotIn("materials", tables)
            self.assertIn("My custom 3 mm", tools)
            self.assertEqual(tools["Thrifty Bot 5 mm"]["notes"], "mine")          # renamed, not duplicated
            self.assertNotIn("Thrifty Bot 5 mm (undersized)", tools)
            self.assertEqual((tools["Thrifty Bot 4 mm"]["mat"], tools["Thrifty Bot 4 mm"]["overall_mm"]), ("carbide", 45))
            self.assertEqual(sum(1 for t in tools if t.startswith("Thrifty Bot 5")), 1)
            mine = [r for r in recipes if r["notes"] in ("my own", "poly")]
            self.assertEqual(sorted((r["material"], r["rpm"]) for r in mine), [("aluminum", 18000), ("polycarbonate", 20000)])
            self.assertFalse([r for r in recipes if r["notes"] == "brass, unsupported now"])
            t5 = tools["Thrifty Bot 5 mm"]["id"]
            seeded = [r for r in recipes if r["tool_id"] == t5]
            self.assertEqual(sorted(r["material"] for r in seeded), ["aluminum", "polycarbonate"])
            self.assertEqual(s["max_rpm"], 20000)  # their machine setting survives
            self.assertTrue(server.list_backups())  # a snapshot was taken before converting
        finally:
            server.DATA_DIR = old_dir


class SecurityTest(Base):
    def test_cross_origin_writes_are_blocked(self):
        body = dict(name="evil", nominal_mm=3, actual_mm=3)
        before = len(self.state()["tools"])
        self.assertEqual(self.req("POST", "/api/tools", body, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/tools", body, headers={"Origin": "null"})[0], 403)
        self.assertEqual(self.req("POST", "/api/tools", body, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.req("DELETE", "/api/tools/1", headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(len(self.state()["tools"]), before)
        ok = self.req("POST", "/api/tools", body, headers={"Origin": f"http://127.0.0.1:{self.port}", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(ok[0], 201)

    def test_no_cors_and_no_cookies(self):
        st, _, hdr = self.req("OPTIONS", "/api/tools", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(st, 204)
        self.assertNotIn("Access-Control-Allow-Origin", hdr)
        st, _, hdr = self.req("GET", "/api/state")
        self.assertNotIn("Set-Cookie", hdr)
        self.assertNotIn("Access-Control-Allow-Origin", hdr)

    def test_security_headers(self):
        for path in ("/", "/api/state", "/app.js"):
            st, _, h = self.req("GET", path)
            self.assertEqual(st, 200, path)
            self.assertIn("script-src 'self'", h["Content-Security-Policy"])
            self.assertNotIn("unsafe-inline", h["Content-Security-Policy"])
            self.assertEqual(h["X-Content-Type-Options"], "nosniff")
            self.assertEqual(h["X-Frame-Options"], "DENY")

    def test_body_limits(self):
        big = json.dumps(dict(name="x", notes="y" * (server.MAX_BODY + 10)))
        self.assertEqual(self.req("POST", "/api/tools", raw=big)[0], 413)
        self.assertEqual(self.req("POST", "/api/tools", raw="{", headers={"Content-Length": "-5"})[0], 400)

    def test_static_path_traversal(self):
        for p in ("/../server.py", "/..%2fserver.py", "/%2e%2e/server.py", "/static/../server.py", "/..\\server.py",
                  "/%00", "//etc/passwd", "/js/../../server.py", "/api/../server.py"):
            st, out, _ = self.req("GET", p)
            self.assertIn(st, (400, 404), p)
            self.assertNotIn(b"ThreadingHTTPServer", out if isinstance(out, bytes) else b"", p)
        self.assertEqual(self.req("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.req("GET", "/static")[0], 404)

    def test_rate_limit(self):
        server.RATE_CAP, server.RATE_REFILL = 3, 0.0001
        server._rate.clear()
        try:
            codes = [self.req("POST", "/api/inventory", dict(name=f"r{i}"))[0] for i in range(6)]
            self.assertEqual(codes[:3], [201, 201, 201])
            self.assertEqual(set(codes[3:]), {429})
            self.assertEqual(self.req("GET", "/api/state")[0], 200)  # reads are not limited
        finally:
            server.RATE_CAP, server.RATE_REFILL = 100000, 100000
            server._rate.clear()

    def test_allowed_hosts(self):
        server.ALLOWED_HOSTS = {"shop.example"}
        try:
            self.assertEqual(self.req("GET", "/api/state")[0], 400)
            self.assertEqual(self.req("GET", "/api/state", headers={"Host": "shop.example"})[0], 200)
        finally:
            server.ALLOWED_HOSTS = set()

    def test_sql_injection_is_just_text(self):
        evil = "x'); DROP TABLE tools;--"
        st, out, _ = self.req("POST", "/api/inventory", dict(name=evil))
        self.assertEqual(st, 201)
        self.assertTrue(self.state()["tools"])
        self.assertIn(evil, [i["name"] for i in self.state()["inventory"]])
        self.assertEqual(self.req("DELETE", "/api/tools/1;DROP")[0], 405)


class StaticTest(Base):
    def test_index_etag_gzip_and_head(self):
        st, html, h = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn("text/html", h["Content-Type"])
        etag = h["ETag"]
        self.assertEqual(self.req("GET", "/", headers={"If-None-Match": etag})[0], 304)
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("HEAD", "/")
        r = c.getresponse()
        self.assertEqual((r.status, r.read()), (200, b""))
        c.close()
        self.assertEqual(self.req("GET", "/api/state", headers={"Accept-Encoding": "gzip"})[2].get("Content-Encoding"), "gzip")


if __name__ == "__main__":
    unittest.main()
