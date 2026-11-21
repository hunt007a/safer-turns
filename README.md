# Safer Turns

Toronto driving routes that turn left at traffic signals instead of across oncoming
traffic where there is no signal. You pick a destination, see which risky turns the
route skips and what that costs in time, then open the trip in Google Maps.

Free version: everything runs in the browser. There is no server, no account and no API key.

## Run it on your PC (Windows)

1. Install Python 3 from python.org if you don't have it (tick "Add python.exe to PATH").
2. Double-click `run.bat`.
   - The first run downloads Toronto roads and traffic signals from OpenStreetMap and builds
     `web/roads/toronto.json`. That takes about 5 to 15 minutes.
   - Then it opens http://localhost:8765 in your browser.
3. To try it on your phone, join the same Wi-Fi and open `http://<your PC's IP>:8765`.
   Windows may ask to allow Python through the firewall. "Use my location" only works on
   the PC or on a published (https) site, so type the start address on the phone.

To refresh the map data, delete `web/roads/toronto.json` and run `run.bat` again.
To merge the City of Toronto signal list: `python build_roads.py --signals-csv signals.csv`.

## Address search

By default it uses Photon, komoot's free public server (light use only). To use Geoapify,
paste your key into `web/config.js`. You can also type coordinates as `43.6629,-79.3957`.

## What's in here

| Path | What it is |
| --- | --- |
| `build_roads.py` | Downloads Toronto from OpenStreetMap and writes the compact road file |
| `safer_route.py` | The original prototype; the builder reuses its road and signal logic |
| `web/` | The app: `index.html`, `app.js` (screens), `router.js` (routing), `worker.js` |
| `web/vendor/leaflet/` | Map library (BSD-2 licence) |
| `tests/` | Sample street grid, router test against the prototype, headless browser test |
| `.github/workflows/pages.yml` | For later: weekly data rebuild and free GitHub Pages hosting |

## Tests

```
python tests/make_sample_osm.py tests/sample_osm.json
python build_roads.py --osm-file tests/sample_osm.json --out tests/sample_roads.json
node tests/test_router.js     # JS router matches the Python prototype's times
node tests/test_ui.js         # needs Playwright; checks the screens in light and dark
```

Map data (c) OpenStreetMap contributors, ODbL. Signal data can be missing or out of date:
the driver is always responsible for the route.
