#!/usr/bin/env python3
"""
safer_route.py - prototype "safer turns" driving router for Toronto (works anywhere OSM covers).

Idea: find a driving route that avoids unprotected turns across busy two-way traffic
at intersections WITHOUT traffic signals, preferring a parallel route that turns at
signals. If the safe route is too much of a detour, fall back to the fastest route.
Then hand the chosen route to Google Maps as a directions link with waypoints, so you
still drive with normal Google Maps navigation.

Data: OpenStreetMap via the public Overpass API (roads, one-way info, speed limits,
highway=traffic_signals nodes). Optionally merge City of Toronto Open Data
"Traffic Signals" CSV for better signal coverage (--signals-csv).

Usage:
  pip install networkx requests
  python3 safer_route.py --from 43.6629,-79.3957 --to 43.6705,-79.3868
  python3 safer_route.py --from ... --to ... --max-detour-pct 25 --max-detour-min 6
  python3 safer_route.py --osm-file area.json --from ... --to ...   # offline input
  python3 safer_route.py --from ... --to ... --map route_map.html     # interactive map

Nothing here needs a Google API key. Google Maps is only used through a plain
https://www.google.com/maps/dir/?api=1 URL.
"""
import argparse
import heapq
import json
import math
import sys
import urllib.parse

try:
    import requests
except ImportError:  # only needed for live Overpass download
    requests = None

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Road "busyness" rank. Higher = more traffic you have to judge gaps in.
ROAD_RANK = {
    "motorway": 6, "motorway_link": 3, "trunk": 5, "trunk_link": 3,
    "primary": 4, "primary_link": 2, "secondary": 3, "secondary_link": 2,
    "tertiary": 2, "tertiary_link": 1, "unclassified": 1,
    "residential": 0, "living_street": 0, "service": 0,
}
DEFAULT_SPEED_KMH = {
    "motorway": 100, "motorway_link": 60, "trunk": 70, "trunk_link": 50,
    "primary": 50, "primary_link": 40, "secondary": 50, "secondary_link": 40,
    "tertiary": 40, "tertiary_link": 30, "unclassified": 40,
    "residential": 30, "living_street": 15, "service": 15,
}
DRIVABLE = "|".join(ROAD_RANK.keys())

# Penalties (seconds added to a turn). Tuned so a few extra minutes of driving is
# preferred over one scary left. All overridable from the command line.
DEFAULTS = dict(
    left_busy=120,     # unsignalized left onto / across a road ranked >= tertiary
    left_local=10,     # unsignalized left where every road is local/residential
    right_busy=25,     # unsignalized right onto a busy road (one direction to judge)
    uturn=300,
    signal_radius_m=30,  # OSM often tags signals on the approach, not the junction node
)


def haversine(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    d = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(d))


def bearing(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def parse_speed(tag, hw):
    if tag:
        try:
            v = float(tag.split()[0])
            return v * 1.609 if "mph" in tag else v
        except ValueError:
            pass
    return DEFAULT_SPEED_KMH.get(hw, 30)


def fetch_osm(src, dst, pad_km=2.0):
    if requests is None:
        sys.exit("pip install requests (or pass --osm-file)")
    pad = pad_km / 111.0
    s, n = min(src[0], dst[0]) - pad, max(src[0], dst[0]) + pad
    padlon = pad / math.cos(math.radians((s + n) / 2))
    w, e = min(src[1], dst[1]) - padlon, max(src[1], dst[1]) + padlon
    q = f"""[out:json][timeout:120];
(
  way["highway"~"^({DRIVABLE})$"]["access"!~"private|no"]({s},{w},{n},{e});
  node["highway"="traffic_signals"]({s},{w},{n},{e});
);
(._;>;);
out body;"""
    r = requests.post(OVERPASS_URL, data={"data": q}, timeout=180,
                      headers={"User-Agent": "safer-route-prototype/0.1"})
    r.raise_for_status()
    return r.json()


def load_signals_csv(path):
    """City of Toronto 'Traffic Signals' CSV. Accepts lat/lon columns under common names."""
    import csv
    pts = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            low = {k.lower(): v for k, v in row.items() if k is not None}
            lat = low.get("latitude") or low.get("lat")
            lon = low.get("longitude") or low.get("lon") or low.get("lng")
            if (not lat or not lon) and low.get("geometry"):
                try:
                    c = json.loads(low["geometry"])["coordinates"]
                    for lo, la in (c if c and isinstance(c[0], list) else [c]):  # MultiPoint or Point
                        pts.append((float(la), float(lo)))
                except Exception:
                    pass
                continue
            try:
                pts.append((float(lat), float(lon)))
            except (TypeError, ValueError):
                pass
    return pts


class Graph:
    def __init__(self, osm, extra_signals=(), signal_radius_m=30):
        self.coord, self.signal_nodes = {}, set()
        self.adj = {}          # node -> list of (next_node, edge_dict)
        self.node_roads = {}   # node -> list of (rank, two_way, name)
        ways = []
        for el in osm["elements"]:
            if el["type"] == "node":
                self.coord[el["id"]] = (el["lat"], el["lon"])
                if el.get("tags", {}).get("highway") == "traffic_signals":
                    self.signal_nodes.add(el["id"])
            elif el["type"] == "way":
                ways.append(el)
        for w in ways:
            t = w.get("tags", {})
            hw = t.get("highway")
            if hw not in ROAD_RANK:
                continue
            ow = t.get("oneway", "no")
            if hw.startswith("motorway") or t.get("junction") == "roundabout":
                ow = t.get("oneway", "yes")
            rank, name = ROAD_RANK[hw], t.get("name", t.get("ref", hw))
            speed = parse_speed(t.get("maxspeed"), hw)
            nodes = [n for n in w["nodes"] if n in self.coord]
            two_way = ow not in ("yes", "1", "true", "-1")
            for n in nodes:
                self.node_roads.setdefault(n, []).append((rank, two_way, name))
            for a, b in zip(nodes, nodes[1:]):
                if ow == "-1":
                    a, b = b, a
                L = haversine(self.coord[a], self.coord[b])
                e = dict(len=L, time=L / (speed / 3.6), rank=rank, two_way=two_way, name=name)
                self.adj.setdefault(a, []).append((b, e))
                if two_way:
                    self.adj.setdefault(b, []).append((a, e))
        # A junction counts as signalized if a signal node lies within signal_radius_m.
        sig_pts = [self.coord[n] for n in self.signal_nodes] + list(extra_signals)
        self.signalized = set()
        cell = 0.0005
        grid = {}
        for p in sig_pts:
            grid.setdefault((int(p[0] / cell), int(p[1] / cell)), []).append(p)
        for n, roads in self.node_roads.items():
            if len(roads) < 2 and len(self.adj.get(n, [])) < 3:
                continue
            c = self.coord[n]
            gi, gj = int(c[0] / cell), int(c[1] / cell)
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for p in grid.get((gi + di, gj + dj), ()):
                        if haversine(c, p) <= signal_radius_m:
                            self.signalized.add(n)
                            break

    def nearest(self, pt):
        return min((n for n in self.adj), key=lambda n: haversine(self.coord[n], pt))

    def is_junction(self, n):
        names = {r[2] for r in self.node_roads.get(n, ())}
        return len(names) >= 2 or len(self.node_roads.get(n, ())) >= 3

    def classify_turn(self, prev, node, nxt, e_in, e_out):
        """Return (kind, risky_reason or None, signalized)."""
        b1 = bearing(self.coord[prev], self.coord[node])
        b2 = bearing(self.coord[node], self.coord[nxt])
        d = (b2 - b1 + 540) % 360 - 180   # -180..180, positive = right turn (clockwise)
        if abs(d) < 35:
            kind = "straight"
        elif abs(d) > 160:
            kind = "uturn"
        else:
            kind = "right" if d > 0 else "left"
        return kind, d


def route(g, src, dst, p, safe=True):
    """Edge-based Dijkstra (state = directed edge) so turns can carry costs."""
    best = {}
    pq = []
    for nxt, e in g.adj.get(src, []):
        st = (src, nxt)
        best[st] = e["time"]
        heapq.heappush(pq, (e["time"], src, nxt, None))
    parent = {}
    goal = None
    while pq:
        cost, a, b, par = heapq.heappop(pq)
        if cost > best.get((a, b), 1e18):
            continue
        parent[(a, b)] = par
        if b == dst:
            goal = (a, b)
            break
        e_in = next(e for x, e in g.adj[a] if x == b)
        for c, e_out in g.adj.get(b, []):
            if c == a and len(g.adj[b]) > 1:
                pen = p["uturn"]
            else:
                pen = turn_penalty(g, a, b, c, e_in, e_out, p) if safe else 0.0
            nc = cost + e_out["time"] + pen
            if nc < best.get((b, c), 1e18):
                best[(b, c)] = nc
                heapq.heappush(pq, (nc, b, c, (a, b)))
    if goal is None:
        return None
    path = [goal[1]]
    st = goal
    while st:
        path.append(st[0])
        st = parent[st]
    return path[::-1]


def turn_penalty(g, a, b, c, e_in, e_out, p):
    return turn_info(g, a, b, c, e_in, e_out, p)[0]


def turn_info(g, a, b, c, e_in, e_out, p):
    """(penalty in seconds, risk) where risk is "left", "right" or None."""
    if b in g.signalized or not g.is_junction(b):
        return 0.0, None
    kind, _ = g.classify_turn(a, b, c, e_in, e_out)
    # Busiest *other* road at this junction = traffic you must judge.
    other = [r for r in g.node_roads.get(b, ()) if r[2] != e_in["name"]] or g.node_roads.get(b, [])
    busy_rank = max([r[0] for r in other] + [e_out["rank"]])
    busy = busy_rank >= 2
    if kind == "left":
        # Left across oncoming traffic (your road two-way) or into a two-way road.
        crosses = e_in["two_way"] or e_out["two_way"] or any(r[1] for r in other)
        if not crosses:
            return 0.0, None
        if busy or e_in["rank"] >= 2:
            return p["left_busy"], "left"
        return p["left_local"], None
    if kind == "right" and busy and e_out["rank"] >= 2 and e_in["rank"] < e_out["rank"]:
        return p["right_busy"], "right"
    return 0.0, None


def describe(g, path, p):
    t = dist = 0.0
    risky = []
    edges = []
    for a, b in zip(path, path[1:]):
        e = next(e for x, e in g.adj[a] if x == b)
        edges.append(e)
        t += e["time"]
        dist += e["len"]
    for i in range(1, len(path) - 1):
        a, b, c = path[i - 1], path[i], path[i + 1]
        _, risk = turn_info(g, a, b, c, edges[i - 1], edges[i], p)
        if risk == "left" or (risk == "right" and p["right_busy"] > 0):
            kind, _ = g.classify_turn(a, b, c, edges[i - 1], edges[i])
            risky.append(dict(kind=kind, from_road=edges[i - 1]["name"], to_road=edges[i]["name"],
                              at=g.coord[b]))
    return dict(time_s=t, dist_m=dist, risky=risky, edges=edges)


def turn_points(g, path, edges):
    """Nodes where the route changes road name: good Google Maps waypoints."""
    pts = []
    for i in range(1, len(path) - 1):
        if edges[i]["name"] != edges[i - 1]["name"]:
            pts.append(path[i])
    return pts


def gmaps_url(g, src, dst, path, edges, fastest_nodes, max_wp):
    cands = []
    if max_wp > 0:
        cands = [n for n in turn_points(g, path, edges) if n not in fastest_nodes] or turn_points(g, path, edges)
    if max_wp > 0 and len(cands) > max_wp:
        step = len(cands) / max_wp
        cands = [cands[int(i * step + step / 2)] for i in range(max_wp)]
    f = lambda c: f"{c[0]:.6f},{c[1]:.6f}"
    q = dict(api="1", origin=f(src), destination=f(dst), travelmode="driving")
    if cands:
        q["waypoints"] = "|".join(f(g.coord[n]) for n in cands)
    return "https://www.google.com/maps/dir/?" + urllib.parse.urlencode(q, safe=",|")


MAP_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Safer route map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--card:#ffffffee;--muted:#666}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--card:#1d1d1dee;--muted:#aaa}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
#map{position:absolute;inset:0}
.panel{position:absolute;z-index:1000;top:12px;left:12px;right:12px;max-width:360px;background:var(--card);
 padding:12px 14px;border-radius:10px;box-shadow:0 2px 10px #0003}
.panel h1{font-size:16px;margin:0 0 6px}.row{display:flex;align-items:center;gap:8px;margin:4px 0}
.sw{width:22px;height:5px;border-radius:3px;flex:none}.dot{width:12px;height:12px;border-radius:50%;flex:none}
.muted{color:var(--muted);font-size:12px}a{color:#2b7de9}
</style></head><body><div id="map"></div>
<div class="panel"><h1>Fastest vs safer route</h1>
<div class="row"><span class="sw" style="background:#9a9a9a"></span>Fastest: __FM__ min, __FK__ km, __FR__ risky turn(s)</div>
<div class="row"><span class="sw" style="background:#2b7de9"></span>Safer: __SM__ min, __SK__ km, __SR__ risky turn(s)</div>
<div class="row"><span class="dot" style="background:#e5484d"></span>Unsignalized turn on fastest route</div>
<div class="row"><span class="dot" style="background:#f5a524"></span>Unsignalized turn still on safer route</div>
<div class="row"><span class="dot" style="background:#30a46c"></span>Traffic signal</div>
<div class="muted">Decision: __DEC__ (+__EX__ min). <a href="__URL__" target="_blank">Open in Google Maps</a></div></div>
<script>
const D=__DATA__;
const m=L.map('map');
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,
  attribution:'Tiles Esri, map data OpenStreetMap contributors'}).addTo(m);
const fast=L.polyline(D.fast,{color:'#9a9a9a',weight:7,opacity:.8}).addTo(m);
L.polyline(D.safe,{color:'#2b7de9',weight:4,opacity:.95}).addTo(m);
D.signals.forEach(p=>L.circleMarker(p,{radius:3,color:'#30a46c',fillOpacity:1,weight:1}).addTo(m));
const mk=(t,c)=>L.circleMarker(t.at,{radius:8,color:c,fillColor:c,fillOpacity:.9}).bindPopup(
  'Unsignalized '+t.kind+'<br>'+t.from_road+' &rarr; '+t.to_road).addTo(m);
D.frisky.forEach(t=>mk(t,'#e5484d'));D.srisky.forEach(t=>mk(t,'#f5a524'));
L.marker(D.fast[0]).bindPopup('Start').addTo(m);L.marker(D.fast[D.fast.length-1]).bindPopup('End').addTo(m);
m.fitBounds(fast.getBounds().extend(L.polyline(D.safe).getBounds()),{padding:[40,40]});
</script></body></html>"""


def write_map(path_out, g, fast, safe, out):
    pts = lambda p: [list(g.coord[n]) for n in p]
    lats = [g.coord[n][0] for n in fast + safe]
    lons = [g.coord[n][1] for n in fast + safe]
    box = (min(lats) - .003, max(lats) + .003, min(lons) - .004, max(lons) + .004)
    sig = [list(g.coord[n]) for n in g.signalized
           if box[0] <= g.coord[n][0] <= box[1] and box[2] <= g.coord[n][1] <= box[3]]
    data = dict(fast=pts(fast), safe=pts(safe), signals=sig,
                frisky=out["fastest"]["risky_turns"], srisky=out["safer"]["risky_turns"])
    html = MAP_HTML
    for k, v in {"__FM__": out["fastest"]["minutes"], "__FK__": out["fastest"]["km"],
                 "__FR__": len(out["fastest"]["risky_turns"]), "__SM__": out["safer"]["minutes"],
                 "__SK__": out["safer"]["km"], "__SR__": len(out["safer"]["risky_turns"]),
                 "__DEC__": out["decision"], "__EX__": out["extra_minutes"],
                 "__URL__": out["google_maps_url"].replace("&", "&amp;"), "__DATA__": json.dumps(data)}.items():
        html = html.replace(k, str(v))
    with open(path_out, "w", encoding="utf-8") as f:
        f.write(html)


def decision(use_safe, too_far, fastest):
    """Same order as the app: a fastest route with no risky turns is already safe."""
    if use_safe:
        return "safer"
    if not fastest["risky"]:
        return "fastest (already safe)"
    return "fastest (detour too long)" if too_far else "fastest (no better option)"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", required=True, help="lat,lon")
    ap.add_argument("--to", dest="dst", required=True, help="lat,lon")
    ap.add_argument("--osm-file", help="Overpass JSON instead of downloading")
    ap.add_argument("--save-osm", help="save downloaded Overpass JSON here")
    ap.add_argument("--signals-csv", help="City of Toronto traffic signals CSV (optional)")
    ap.add_argument("--max-detour-pct", type=float, default=30)
    ap.add_argument("--max-detour-min", type=float, default=7)
    ap.add_argument("--max-waypoints", type=int, default=3,
                    help="Google Maps mobile honours ~3 waypoints in a URL, desktop up to 9")
    for k, v in DEFAULTS.items():
        ap.add_argument("--" + k.replace("_", "-"), type=float, default=v)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--map", help="write an interactive HTML map (Leaflet) of both routes to this file")
    args = ap.parse_args()
    p = {k: getattr(args, k) for k in DEFAULTS}
    src = tuple(map(float, args.src.split(",")))
    dst = tuple(map(float, args.dst.split(",")))

    if args.osm_file:
        with open(args.osm_file, encoding="utf-8") as f:
            osm = json.load(f)
    else:
        print("Downloading OSM data from Overpass...", file=sys.stderr)
        osm = fetch_osm(src, dst)
        if args.save_osm:
            with open(args.save_osm, "w", encoding="utf-8") as f:
                json.dump(osm, f)
    extra = load_signals_csv(args.signals_csv) if args.signals_csv else []
    g = Graph(osm, extra, p["signal_radius_m"])
    s, d = g.nearest(src), g.nearest(dst)

    fast = route(g, s, d, p, safe=False)
    safe = route(g, s, d, p, safe=True)
    if not fast:
        sys.exit("No route found in downloaded area.")
    F, S = describe(g, fast, p), describe(g, safe, p)
    extra_s = S["time_s"] - F["time_s"]
    too_far = extra_s > args.max_detour_min * 60 or extra_s > F["time_s"] * args.max_detour_pct / 100
    use_safe = (not too_far) and len(S["risky"]) < len(F["risky"])
    chosen, C = (safe, S) if use_safe else (fast, F)
    url = gmaps_url(g, src, dst, chosen, C["edges"], set(fast) if use_safe else set(), args.max_waypoints) \
        if use_safe else gmaps_url(g, src, dst, fast, F["edges"], set(), 0)

    out = dict(
        fastest=dict(minutes=round(F["time_s"] / 60, 1), km=round(F["dist_m"] / 1000, 2), risky_turns=F["risky"]),
        safer=dict(minutes=round(S["time_s"] / 60, 1), km=round(S["dist_m"] / 1000, 2), risky_turns=S["risky"]),
        extra_minutes=round(extra_s / 60, 1),
        decision=decision(use_safe, too_far, F),
        google_maps_url=url,
    )
    if args.map:
        write_map(args.map, g, fast, safe, out)
        print(f"Map written to {args.map}", file=sys.stderr)
    if args.json:
        print(json.dumps(out, indent=2))
        return
    def show(label, r):
        print(f"{label}: {r['minutes']} min, {r['km']} km, {len(r['risky_turns'])} risky turn(s)")
        for t in r["risky_turns"]:
            print(f"   - unsignalized {t['kind']}: {t['from_road']} -> {t['to_road']} at {t['at'][0]:.5f},{t['at'][1]:.5f}")
    show("Fastest", out["fastest"])
    show("Safer  ", out["safer"])
    print(f"Extra time for safer route: {out['extra_minutes']} min")
    print(f"Decision: {out['decision']}")
    print(f"Open in Google Maps: {url}")


if __name__ == "__main__":
    main()
