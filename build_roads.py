#!/usr/bin/env python3
"""
build_roads.py - build the compact Toronto road + traffic-signal file that the
Safer Turns web app loads in the browser (web/roads/toronto.json).

It downloads drivable roads and highway=traffic_signals nodes for the City of
Toronto from OpenStreetMap (public Overpass API) in 9 tiles, reuses the
prototype's Graph class (safer_route.py) to work out junctions and which ones
are signalized, then collapses the in-between road points so the file stays small.

Usage:
  python build_roads.py                         # download Toronto, write web/roads/toronto.json
  python build_roads.py --signals-csv signals.csv   # also merge City of Toronto signal locations
  python build_roads.py --osm-file area.json    # build from a saved Overpass JSON instead
  python build_roads.py --bbox 43.64,-79.42,43.68,-79.38   # a smaller test area

Needs: Python 3.8+ and `pip install requests` (only for downloading).
Map data (c) OpenStreetMap contributors, ODbL.
"""
import argparse
import datetime
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import safer_route as sr  # noqa: E402

TORONTO_BBOX = (43.581, -79.639, 43.856, -79.115)  # south, west, north, east


def overpass_tile(s, w, n, e, retries=4):
    if sr.requests is None:
        sys.exit("Run `pip install requests` first (or pass --osm-file).")
    q = f"""[out:json][timeout:300];
(
  way["highway"~"^({sr.DRIVABLE})$"]["access"!~"private|no"]({s},{w},{n},{e});
  node["highway"="traffic_signals"]({s},{w},{n},{e});
);
(._;>;);
out body;"""
    for attempt in range(retries):
        try:
            r = sr.requests.post(sr.OVERPASS_URL, data={"data": q}, timeout=360,
                                 headers={"User-Agent": "safer-turns-builder/0.1"})
            if r.status_code in (429, 504):
                raise RuntimeError(f"Overpass busy ({r.status_code})")
            r.raise_for_status()
            return r.json()["elements"]
        except Exception as ex:  # network hiccup or rate limit: wait and retry
            wait = 30 * (attempt + 1)
            print(f"  tile failed ({ex}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    sys.exit("Overpass kept failing. Try again later, or use --osm-file.")


def download(bbox, splits=3):
    s, w, n, e = bbox
    seen, out = set(), []
    dl, dw = (n - s) / splits, (e - w) / splits
    for i in range(splits):
        for j in range(splits):
            t = (s + i * dl, w + j * dw, s + (i + 1) * dl, w + (j + 1) * dw)
            print(f"Downloading tile {i * splits + j + 1}/{splits * splits} ...", file=sys.stderr)
            for el in overpass_tile(*t):
                k = (el["type"], el["id"])
                if k not in seen:
                    seen.add(k)
                    out.append(el)
            time.sleep(2)  # be polite to the public server
    return {"elements": out}


def compact(g):
    """Collapse chains of plain road points into single edges with geometry."""
    names, name_ix = [], {}

    def nid(name):
        if name not in name_ix:
            name_ix[name] = len(names)
            names.append(name)
        return name_ix[name]

    indeg, und = {}, {}
    attrs = {}
    for a, lst in g.adj.items():
        for b, e in lst:
            indeg[b] = indeg.get(b, 0) + 1
            und.setdefault(a, set()).add(b)
            und.setdefault(b, set()).add(a)
            key = (e["rank"], e["two_way"], e["name"])
            attrs.setdefault(a, set()).add(key)
            attrs.setdefault(b, set()).add(key)

    def plain(n):
        if n in g.signalized or g.is_junction(n):
            return False
        if len(und.get(n, ())) != 2 or len(attrs.get(n, ())) != 1:
            return False
        tw = next(iter(attrs[n]))[1]
        outd = len(g.adj.get(n, ()))
        ind = indeg.get(n, 0)
        return (outd == 2 and ind == 2) if tw else (outd == 1 and ind == 1)

    keep = [n for n in und if not plain(n)]
    keep_set = set(keep)
    ix = {n: i for i, n in enumerate(keep)}
    edges, geom = [], []
    done = set()
    for k in keep:
        for nxt, e in g.adj.get(k, []):
            if (k, nxt) in done:
                continue
            done.add((k, nxt))
            prev, cur = k, nxt
            pts, t, L = [], e["time"], e["len"]
            guard = 0
            while cur not in keep_set and guard < 100000:
                guard += 1
                pts.append(g.coord[cur])
                cand = [(x, ee) for x, ee in g.adj.get(cur, []) if x != prev]
                if not cand:
                    break
                x, ee = cand[0]
                t += ee["time"]
                L += ee["len"]
                prev, cur = cur, x
            if cur not in keep_set:
                continue  # dead end loop with no junction; drop
            if e["two_way"]:
                done.add((cur, prev))  # same road traced from the other end
            gstart = len(geom) // 2
            for la, lo in pts:
                geom += [round(la * 1e5), round(lo * 1e5)]
            edges += [ix[k], ix[cur], round(t * 10), round(L), e["rank"], 1 if e["two_way"] else 0,
                      nid(e["name"]), gstart, len(pts)]

    nodes, flags, roads = [], [], []
    for n in keep:
        la, lo = g.coord[n]
        nodes += [round(la * 1e5), round(lo * 1e5)]
        f = (1 if n in g.signalized else 0) | (2 if g.is_junction(n) else 0)
        flags.append(f)
        rs = sorted({(r[0], 1 if r[1] else 0, nid(r[2])) for r in g.node_roads.get(n, ())}) if f & 2 else []
        roads.append([list(r) for r in rs])
    return dict(names=names, nodes=nodes, flags=flags, roads=roads, edges=edges, geom=geom)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--osm-file", help="Overpass JSON to build from instead of downloading")
    ap.add_argument("--save-osm", help="also save the downloaded Overpass JSON here")
    ap.add_argument("--signals-csv", help="City of Toronto Traffic Signals CSV to merge (optional)")
    ap.add_argument("--bbox", help="south,west,north,east (default: City of Toronto)")
    ap.add_argument("--out", default=os.path.join(HERE, "web", "roads", "toronto.json"))
    ap.add_argument("--area-name", default="Toronto")
    args = ap.parse_args()

    if args.osm_file:
        with open(args.osm_file, encoding="utf-8") as f:
            osm = json.load(f)
    else:
        bbox = tuple(map(float, args.bbox.split(","))) if args.bbox else TORONTO_BBOX
        osm = download(bbox)
        if args.save_osm:
            with open(args.save_osm, "w", encoding="utf-8") as f:
                json.dump(osm, f)
    extra = sr.load_signals_csv(args.signals_csv) if args.signals_csv else []
    print("Building road graph ...", file=sys.stderr)
    g = sr.Graph(osm, extra, sr.DEFAULTS["signal_radius_m"])
    data = compact(g)
    lats = data["nodes"][0::2]
    lons = data["nodes"][1::2]
    data.update(v=1, area=args.area_name,
                built=datetime.date.today().isoformat(),
                bbox=[min(lats) / 1e5, min(lons) / 1e5, max(lats) / 1e5, max(lons) / 1e5],
                attribution="Map data (c) OpenStreetMap contributors, ODbL",
                stats=dict(nodes=len(data["flags"]), edges=len(data["edges"]) // 9,
                           signalized=sum(1 for f in data["flags"] if f & 1)))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    mb = os.path.getsize(args.out) / 1e6
    print(f"Wrote {args.out}: {data['stats']['nodes']} junctions, {data['stats']['edges']} road links, "
          f"{data['stats']['signalized']} signalized, {mb:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
