"""Runs the Node test files (calculator maths and the browser smoke tests) as part of `python3 -m unittest discover tests`."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class JsTests(unittest.TestCase):
    def run_node(self, test_file):
        r = subprocess.run(["node", "--test", test_file], cwd=ROOT, capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout[-4000:] + r.stderr[-2000:])

    def test_calculators(self):
        self.run_node("tests/calc.test.js")

    def test_browser(self):  # skips itself when Playwright isn't available
        self.run_node("tests/browser.test.js")


if __name__ == "__main__":
    unittest.main()
