# CNC Feeds & Speeds

Feeds-and-speeds calculator for an OMIO X8 router, with tools, materials and
proven settings stored in a SQLite database. Python standard library only.

- **Tools**: seeded with the Thrifty Bot 5 mm (4.6 mm actual) and 4 mm (3.7 mm actual)
  undersized endmills plus the rest of the Fusion library. The calculator uses the
  *actual* cutting diameter. Fusion `.tools` files can be imported.
- **Calculator**: surface speed, chipload with chip thinning, depth/width of cut,
  plunge/ramp, then checks predicted spindle load and tool deflection and reduces
  depth if either is too high.
- **Saved settings**: record "known-good" cuts and compare them with the calculation.
- **Machine**: min/max RPM, max feed, spindle power, deflection limit.

Anyone can use the calculator. Editing needs `ADMIN_PASSWORD`. The Machine tab can download a JSON backup.

## Deploy with WebManager

Add this repo as a source, deploy it **as an app**, and set `ADMIN_PASSWORD`
on the Variables page. Data lives in the app's `/data` volume
(`cnc.sqlite3`), which WebManager backs up before each restart.

## Run locally

```bash
ADMIN_PASSWORD=secret DATA_DIR=./data python3 server.py   # http://localhost:8080
python3 -m unittest discover tests
```

All numbers are conservative starting points, not guarantees; tune materials on
the Materials tab.
