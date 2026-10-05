# Shop Toolkit

A web app for an FRC team shop: CNC router feeds & speeds for the **OMIO X8**, a spoilboard surfacing planner,
the usual shop calculators (drill/tap, weights, cut lists, bending, converters), FRC engineering calculators
(drivetrain, elevator, arm, flywheel, belts & chain, wiring, pneumatics, weight budget), and the shop's shared
records (tool library, tested settings, job log, inventory, maintenance) with written guides.

Python standard library only (HTTP server + SQLite). No login, no build step, no external services.

## What's in it

| Area | Pages |
| --- | --- |
| **CNC Router** | **Feeds & Speeds** (pick the material and endmill, get rpm, feed, depth, stepover, plunge/ramp), Spoilboard Surfacing (lines, time, sketch), Hole & Tool Size (toolpath circle, measure what an undersized tool really cuts, fits, FRC bearings) |
| **Machining** | Drill, Tap & Hardware (tap drill, clearance, socket-head counterbore, thread-forming holes); Mill, Drill, Lathe & Saw speeds and bandsaw blade choice |
| **Fabrication** | Weight & Stock, Cut List optimiser, Sheet Bending, Converter & Fractions (with nearest drill) |
| **FRC Engineering** | Drivetrain, Elevator, Arm, Flywheel, Belts & Chain, Wiring & Power, Pneumatics, Weight Budget |
| **Our Shop** | Tool Library, Tested Settings, Job Log, Inventory (low-stock flags), Maintenance (overdue flags) |
| **Guides** | Shop Safety, Running the OMIO X8 (checklists), Troubleshooting, Materials & Terms, Links |
| **Settings** | Machine limits, backups and restore |

Materials are deliberately limited to what the shop cuts: **aluminum (6061), polycarbonate, and the MDF spoilboard**
(surfaced with the facemill).

### How the feeds & speeds work

The model is calibrated to the team's own tested cuts, and those win whenever they exist:

| Cut | Tested |
| --- | --- |
| 5 mm Thrifty Bot (cuts 4.6 mm), aluminum slot | 24,000 rpm, 68 in/min (1,727 mm/min), 1/16 in per pass |
| same tool, polycarbonate slot | 24,000 rpm, 155 in/min (3,937 mm/min), 1/8 in per pass |
| 2.5 in facemill, MDF spoilboard | 5,000 rpm, 30 in/min (762 mm/min), 0.0015 in/tooth, 4 flutes |

For a tool and material with no tested setting, the calculator scales from those numbers (chipload and depth in
proportion to diameter, surface speed from the material, chip thinning for narrow cuts) and checks spindle load and
tool deflection. Other operations (pocket, side cut, adaptive, finish) scale from the tested slot. "Save as tested"
turns any run that worked into the shop's recommendation. `tests/calc.test.js` pins the calibration.

Everything is a starting point. Run a scrap test first.

## Run it

```bash
DATA_DIR=./data python3 server.py        # http://localhost:8080
python3 -m unittest discover tests       # server, calculator maths and (if Playwright is installed) browser tests
node --test tests/calc.test.js           # just the calculators
```

## Deploy with WebManager

Add this repo as a source and deploy it **as an app**. Nothing needs configuring: there is no password. Data lives
in the app's `/data` volume (`cnc.sqlite3`, plus a `backups/` folder).

Optional environment variables: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR`, and `ALLOWED_HOSTS` (comma-separated
host names; when set, requests for any other `Host` are refused, which blocks DNS-rebinding tricks).

## No password: how it stays safe

Anyone who can open the page can use and edit the shared data. That is a deliberate choice for shop notes, so the
server defends itself instead of asking for a login:

- Strict validation of every field, size limits on requests, row caps on every table, and a per-IP limit on writes.
- Same-origin checks (`Origin` / `Sec-Fetch-Site`) and JSON-only writes, so another website can't make your browser
  change shop data; no CORS headers are sent.
- A strict Content-Security-Policy (no inline scripts or styles) and all stored text is escaped when shown.
- Parameterised SQL only; static files are served from one folder with path-traversal checks.
- **Automatic backups** (on start, every few hours of edits, and before any restore/import) with one-click restore
  and a full JSON export on the Machine & Data page. Deleting something by mistake is recoverable.

If you ever need a locked-down copy, put it behind your reverse proxy's authentication.

## Upgrading from the old version

An existing `cnc.sqlite3` is converted in place on first start (a snapshot is taken first). Your tools, tested settings
and machine limits are kept; the materials table is gone because there are now exactly three materials; settings for
other materials (brass, SRPP, etc.) are dropped from the live data but remain in the pre-upgrade snapshot.

## Layout

```
server.py            HTTP + SQLite backend (no dependencies)
static/              the whole front end (plain JS, no build)
  js/cnc.js          router feeds & speeds model, spoilboard planner      (pure, unit-tested)
  js/shop.js         drills, threads, weights, cut list, bending, units   (pure, unit-tested)
  js/frc.js          motors, drivetrain, mechanisms, belts, wiring, air   (pure, unit-tested)
  js/core.js         safe templating, units, forms, dialogs
  js/page_*.js       the pages
tests/               unittest (server), node:test (calculators, browser via Playwright)
```

## Where the numbers come from

- **OMIO X8**: WCP's documentation (2.2 kW, 24,000 rpm, ER20, 100-4,000 mm/min, 565 x 770 x 85 mm, Mach3).
- **FRC rules**: 2025/2026 manuals (115 lb robot limit without bumpers and battery; R622 wire sizes; 60 psi working / 120 psi storage).
- **Motors**: CTRE (Kraken X60), WCP (Kraken X44), REV (NEO, NEO 550, Vortex), VEX/WPILib (Falcon, CIM family).
- **Tap, clearance and drill tables**: Machinery's Handbook values, checked in `tests/calc.test.js`.
- Handbook ranges for drilling/milling speeds, bandsaw tooth selection, bend radius and K-factor, and polycarbonate handling.
