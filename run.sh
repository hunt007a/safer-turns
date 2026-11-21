#!/usr/bin/env sh
# Safer Turns: build the Toronto road file (first run only) and serve the app.
cd "$(dirname "$0")"
if [ ! -f web/roads/toronto.json ]; then
  echo "First run: downloading Toronto roads from OpenStreetMap (5 to 15 minutes)."
  python3 -m pip install --quiet requests && python3 build_roads.py || exit 1
fi
echo "Safer Turns is running at http://localhost:8765"
python3 -m http.server 8765 --directory web
