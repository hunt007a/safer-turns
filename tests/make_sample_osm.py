#!/usr/bin/env python3
"""Make a synthetic Overpass-style JSON street grid for offline tests.

13 x 13 grid, ~150 m blocks, near Toronto. Every 4th street is a two-way arterial
(primary, 50 km/h) with traffic signals where two arterials cross; the rest are
residential (40 km/h), two of them one-way. Each block has 2 mid-block points so the
road-file compaction gets exercised.
"""
import json
import sys

LAT0, LON0 = 43.6500, -79.4300
DLAT, DLON = 0.00135, 0.00185
N = 13
NS_NAMES = ["Lansdowne Ave", "Margueretta St", "Brock Ave", "Sheridan Ave", "Dufferin St", "Gladstone Ave",
            "Salem Ave", "Westmoreland Ave", "Ossington Ave", "Delaware Ave", "Dovercourt Rd", "Shaw St",
            "Christie St"]
EW_NAMES = ["Dupont St", "Geary Ave", "Hallam St", "Wallace Ave", "Davenport Rd", "Dewson St",
            "Harbord St", "Barton Ave", "Bloor St W", "Yarmouth Rd", "Essex Ave", "Bartlett Ave",
            "College St"]


def main(out):
    els, nid = [], [0]

    def node(lat, lon, tags=None):
        nid[0] += 1
        el = {"type": "node", "id": nid[0], "lat": round(lat, 7), "lon": round(lon, 7)}
        if tags:
            el["tags"] = tags
        els.append(el)
        return nid[0]

    grid = {}
    for i in range(N):
        for j in range(N):
            art = (i % 4 == 0) and (j % 4 == 0)
            grid[i, j] = node(LAT0 - i * DLAT, LON0 + j * DLON, {"highway": "traffic_signals"} if art else None)
    wid = [1000000]

    def way(nodes, name, hw, oneway=None):
        wid[0] += 1
        tags = {"highway": hw, "name": name}
        if oneway:
            tags["oneway"] = oneway
        els.append({"type": "way", "id": wid[0], "nodes": nodes, "tags": tags})

    for i in range(N):  # east-west streets, row i
        pts = []
        for j in range(N):
            pts.append(grid[i, j])
            if j < N - 1:
                for k in (1, 2):
                    pts.append(node(LAT0 - i * DLAT, LON0 + (j + k / 3) * DLON))
        art = i % 4 == 0
        way(pts, EW_NAMES[i], "primary" if art else "residential", "yes" if i in (3, 9) else None)
    for j in range(N):  # north-south streets, column j
        pts = []
        for i in range(N):
            pts.append(grid[i, j])
            if i < N - 1:
                for k in (1, 2):
                    pts.append(node(LAT0 - (i + k / 3) * DLAT, LON0 + j * DLON))
        art = j % 4 == 0
        way(pts, NS_NAMES[j], "secondary" if art else "residential", "-1" if j == 6 else None)
    with open(out, "w") as f:
        json.dump({"elements": els}, f)
    print(f"wrote {out}: {len(els)} elements")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sample_osm.json")
