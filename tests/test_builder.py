"""Unit tests for safer_route.py and build_roads.py. Run: python -m unittest discover tests"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import build_roads  # noqa: E402
import safer_route as sr  # noqa: E402


def node(i, lat, lon, signal=False):
    el = {"type": "node", "id": i, "lat": lat, "lon": lon}
    if signal:
        el["tags"] = {"highway": "traffic_signals"}
    return el


def way(i, nodes, **tags):
    return {"type": "way", "id": i, "nodes": nodes, "tags": tags}


def plus_osm(signal=False, signal_offset=0.0):
    """A + junction at node 1: Main St (primary) north-south, Side St (residential) east-west.
    Each arm has a plain middle point so the builder has something to collapse."""
    els = [
        node(1, 43.7, -79.4),
        node(2, 43.7005, -79.4), node(3, 43.701, -79.4),      # north
        node(4, 43.6995, -79.4), node(5, 43.699, -79.4),      # south
        node(6, 43.7, -79.3993), node(7, 43.7, -79.3986),     # east
        node(8, 43.7, -79.4007), node(9, 43.7, -79.4014),     # west
        way(100, [5, 4, 1, 2, 3], highway="primary", name="Main St"),
        way(101, [9, 8, 1, 6, 7], highway="residential", name="Side St"),
    ]
    if signal:
        els.append(node(50, 43.7 + signal_offset, -79.4, signal=True))
    return {"elements": els}


class Geometry(unittest.TestCase):
    def test_haversine_one_degree(self):
        self.assertAlmostEqual(sr.haversine((43, -79), (44, -79)), 111195, delta=5)

    def test_bearing(self):
        self.assertAlmostEqual(sr.bearing((43.7, -79.4), (43.8, -79.4)), 0, places=3)
        self.assertAlmostEqual(sr.bearing((43.7, -79.4), (43.6, -79.4)), 180, places=3)


class Speeds(unittest.TestCase):
    def test_tagged_kmh(self):
        self.assertEqual(sr.parse_speed("60", "primary"), 60)

    def test_tagged_mph(self):
        self.assertAlmostEqual(sr.parse_speed("30 mph", "primary"), 48.27)

    def test_bad_tag_falls_back_to_road_default(self):
        self.assertEqual(sr.parse_speed("walk", "residential"), 30)
        self.assertEqual(sr.parse_speed(None, "motorway"), 100)
        self.assertEqual(sr.parse_speed(None, "something_new"), 30)


class SignalsCsv(unittest.TestCase):
    def _csv(self, text):
        f = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
        f.write(text)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_lat_lon_columns(self):
        p = self._csv("ID,Latitude,Longitude\n1,43.7,-79.4\n2,,\n3,43.8,-79.5\n")
        self.assertEqual(sr.load_signals_csv(p), [(43.7, -79.4), (43.8, -79.5)])

    def test_geojson_geometry_column(self):
        p = self._csv('id,geometry\n1,"{""type"": ""MultiPoint"", ""coordinates"": [[-79.4, 43.7]]}"\n'
                      '2,"{""type"": ""Point"", ""coordinates"": [-79.5, 43.8]}"\n3,not json\n')
        self.assertEqual(sr.load_signals_csv(p), [(43.7, -79.4), (43.8, -79.5)])


class GraphBuild(unittest.TestCase):
    def test_two_way_and_one_way(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4), node(3, 43.702, -79.4),
                            way(1, [1, 2], highway="residential", name="A"),
                            way(2, [2, 3], highway="residential", name="B", oneway="yes")]}
        g = sr.Graph(osm)
        self.assertIn(1, [b for b, _ in g.adj[2]])           # two-way: back from 2 to 1
        self.assertNotIn(2, [b for b, _ in g.adj.get(3, [])])  # one-way: no way back from 3

    def test_oneway_minus_one_runs_against_node_order(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4),
                            way(1, [1, 2], highway="residential", name="A", oneway="-1")]}
        g = sr.Graph(osm)
        self.assertEqual([b for b, _ in g.adj[2]], [1])
        self.assertNotIn(1, g.adj)

    def test_motorway_is_one_way_unless_tagged(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4),
                            way(1, [1, 2], highway="motorway", name="401")]}
        self.assertNotIn(2, sr.Graph(osm).adj)

    def test_private_and_unknown_roads_are_skipped(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4),
                            way(1, [1, 2], highway="footway", name="Path")]}
        self.assertEqual(sr.Graph(osm).adj, {})

    def test_signal_near_junction_marks_it_signalized(self):
        self.assertIn(1, sr.Graph(plus_osm(signal=True, signal_offset=0.0002)).signalized)  # ~22 m
        self.assertNotIn(1, sr.Graph(plus_osm(signal=True, signal_offset=0.0006)).signalized)  # ~67 m

    def test_extra_signals_from_csv_count(self):
        self.assertIn(1, sr.Graph(plus_osm(), extra_signals=[(43.7, -79.4)]).signalized)

    def test_is_junction(self):
        g = sr.Graph(plus_osm())
        self.assertTrue(g.is_junction(1))
        self.assertFalse(g.is_junction(2))


class TurnPenalty(unittest.TestCase):
    def setUp(self):
        self.g = sr.Graph(plus_osm())
        self.p = dict(sr.DEFAULTS)

    def pen(self, a, b, c):
        e_in = next(e for x, e in self.g.adj[a] if x == b)
        e_out = next(e for x, e in self.g.adj[b] if x == c)
        return sr.turn_penalty(self.g, a, b, c, e_in, e_out, self.p)

    def test_left_off_busy_road(self):
        self.assertEqual(self.pen(4, 1, 8), self.p["left_busy"])  # north on Main, left to the west

    def test_straight_is_free(self):
        self.assertEqual(self.pen(4, 1, 2), 0)

    def test_right_onto_busy_road(self):
        self.assertEqual(self.pen(6, 1, 2), self.p["right_busy"])  # west on Side, right onto Main

    def test_signal_removes_penalty(self):
        self.g = sr.Graph(plus_osm(signal=True))
        self.assertEqual(self.pen(4, 1, 8), 0)


class Routing(unittest.TestCase):
    def test_describe_with_right_penalty_off_counts_only_real_risks(self):
        # with --right-busy 0, a plain straight drive must not be flagged as risky
        g = sr.Graph(plus_osm())
        p = dict(sr.DEFAULTS, right_busy=0)
        path = sr.route(g, 5, 3, p, safe=True)
        self.assertEqual(path, [5, 4, 1, 2, 3])
        self.assertEqual(sr.describe(g, path, p)["risky"], [])

    def test_safe_route_flags_the_left(self):
        g = sr.Graph(plus_osm())
        path = sr.route(g, 5, 9, sr.DEFAULTS, safe=False)
        risky = sr.describe(g, path, sr.DEFAULTS)["risky"]
        self.assertEqual([r["kind"] for r in risky], ["left"])

    def test_gmaps_url(self):
        g = sr.Graph(plus_osm())
        path = sr.route(g, 5, 9, sr.DEFAULTS, safe=False)
        edges = sr.describe(g, path, sr.DEFAULTS)["edges"]
        url = sr.gmaps_url(g, (43.699, -79.4), (43.7, -79.4014), path, edges, set(), 3)
        self.assertTrue(url.startswith("https://www.google.com/maps/dir/?api=1&origin=43.699000,-79.400000"))
        self.assertIn("waypoints=43.700000,-79.400000", url)


class Compact(unittest.TestCase):
    """build_roads.compact must keep every junction and the total time and length of every road."""

    def setUp(self):
        self.g = sr.Graph(plus_osm(signal=True))
        self.d = build_roads.compact(self.g)

    def test_plain_points_are_collapsed_into_geometry(self):
        # 9 OSM nodes; the 4 middle points are plain, so 5 nodes remain: the junction and 4 ends
        self.assertEqual(len(self.d["flags"]), 5)
        self.assertEqual(len(self.d["geom"]) // 2, 4)
        for i in range(0, len(self.d["edges"]), 9):
            self.assertEqual(self.d["edges"][i + 8], 1)  # each arm keeps its one middle point

    def test_flags(self):
        flags = self.d["flags"]
        self.assertEqual(sum(1 for f in flags if f & 2), 1)  # one junction
        self.assertEqual(sum(1 for f in flags if f & 1), 1)  # and it is signalized

    def test_time_and_length_are_kept(self):
        total_len = sum(e["len"] for lst in self.g.adj.values() for _, e in lst)
        total_t = sum(e["time"] for lst in self.g.adj.values() for _, e in lst)
        E = self.d["edges"]
        c_len = c_t = 0
        for i in range(0, len(E), 9):
            mult = 2 if E[i + 5] else 1  # a two-way edge stands for both directions
            c_len += E[i + 3] * mult
            c_t += E[i + 2] / 10 * mult
        self.assertAlmostEqual(c_len, total_len, delta=len(E) / 9 * 2)
        self.assertAlmostEqual(c_t, total_t, delta=len(E) / 9 * 0.2)

    def test_indices_are_in_range(self):
        n = len(self.d["flags"])
        E = self.d["edges"]
        for i in range(0, len(E), 9):
            self.assertTrue(0 <= E[i] < n and 0 <= E[i + 1] < n)
            self.assertTrue(0 <= E[i + 6] < len(self.d["names"]))
            self.assertLessEqual((E[i + 7] + E[i + 8]) * 2, len(self.d["geom"]))

    def test_junction_lists_its_roads(self):
        j = next(i for i, f in enumerate(self.d["flags"]) if f & 2)
        names = {self.d["names"][r[2]] for r in self.d["roads"][j]}
        self.assertEqual(names, {"Main St", "Side St"})

    def test_sample_grid_matches_the_checked_in_fixture(self):
        with open(os.path.join(HERE, "sample_osm.json"), encoding="utf-8") as f:
            osm = json.load(f)
        with open(os.path.join(HERE, "sample_roads.json"), encoding="utf-8") as f:
            fixture = json.load(f)
        d = build_roads.compact(sr.Graph(osm, (), sr.DEFAULTS["signal_radius_m"]))
        for k in ("names", "nodes", "flags", "roads", "edges", "geom"):
            self.assertEqual(d[k], fixture[k], k)


if __name__ == "__main__":
    unittest.main()
