import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["ADMIN_PASSWORD"] = "pw"
import server  # noqa: E402


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.make_server("127.0.0.1", 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, cookie=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        h = {"Content-Type": "application/json"}
        if cookie:
            h["Cookie"] = cookie
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        data = r.read()
        try:
            data = json.loads(data)
        except ValueError:
            pass
        return r.status, data, r.getheader("Set-Cookie")

    def login(self):
        s, _, sc = self.req("POST", "/api/login", {"password": "pw"})
        self.assertEqual(s, 200)
        return sc.split(";")[0]

    def test_health_and_seed(self):
        self.assertEqual(self.req("GET", "/api/health")[0], 200)
        s, st, _ = self.req("GET", "/api/state")
        names = [t["name"] for t in st["tools"]]
        self.assertTrue(any("Thrifty Bot 5 mm" in n for n in names))
        self.assertEqual(len(st["materials"]), 10)
        self.assertFalse(st["admin"])

    def test_write_needs_login(self):
        self.assertEqual(self.req("POST", "/api/tools", {"name": "x"})[0], 401)
        self.assertEqual(self.req("POST", "/api/login", {"password": "bad"})[0], 401)

    def test_crud_and_validation(self):
        ck = self.login()
        s, r, _ = self.req("POST", "/api/tools", {"name": "Test", "actual_mm": 4.6, "nominal_mm": 5}, ck)
        self.assertEqual(s, 201)
        tid = r["id"]
        self.assertEqual(self.req("POST", "/api/tools", {"name": "", }, ck)[0], 400)
        self.assertEqual(self.req("POST", "/api/tools", {"name": "n", "flutes": 99}, ck)[0], 400)
        self.assertEqual(self.req("PUT", f"/api/tools/{tid}", {"name": "Renamed", "actual_mm": 3.7}, ck)[0], 200)
        mat = self.req("GET", "/api/state")[1]["materials"][0]["id"]
        s, rc, _ = self.req("POST", "/api/recipes", {"tool_id": tid, "material_id": mat, "op": "slot", "rpm": 20000, "feed_mm": 800}, ck)
        self.assertEqual(s, 201)
        self.assertEqual(self.req("POST", "/api/recipes", {"tool_id": 99999, "material_id": mat}, ck)[0], 400)
        self.assertEqual(self.req("DELETE", f"/api/tools/{tid}", None, ck)[0], 200)
        st = self.req("GET", "/api/state")[1]
        self.assertFalse(any(x["tool_id"] == tid for x in st["recipes"]))

    def test_settings(self):
        ck = self.login()
        self.assertEqual(self.req("PUT", "/api/settings", {"min_rpm": 9000, "max_rpm": 1000}, ck)[0], 400)
        self.assertEqual(self.req("PUT", "/api/settings", {"min_rpm": 8000, "max_rpm": 24000}, ck)[0], 200)
        self.assertEqual(self.req("GET", "/api/state")[1]["settings"]["min_rpm"], 8000)

    def test_static_traversal(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", "/../server.py")
        self.assertEqual(c.getresponse().status, 404)


if __name__ == "__main__":
    unittest.main()
