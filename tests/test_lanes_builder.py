"""Lane counts in the road file (for "crossing N lanes" on the map). Run: python -m unittest discover -s tests -p "test_*.py" """
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import build_roads  # noqa: E402
import safer_route as sr  # noqa: E402
from test_builder import node, way  # noqa: E402


def plus_with_lanes(main_lanes="4", side_lanes=None):
    side = {"lanes": side_lanes} if side_lanes else {}
    return {"elements": [
        node(1, 43.7, -79.4),
        node(2, 43.7005, -79.4), node(3, 43.701, -79.4),
        node(4, 43.6995, -79.4), node(5, 43.699, -79.4),
        node(6, 43.7, -79.3993), node(7, 43.7, -79.3986),
        node(8, 43.7, -79.4007), node(9, 43.7, -79.4014),
        way(100, [5, 4, 1, 2, 3], highway="primary", name="Main St", lanes=main_lanes),
        way(101, [9, 8, 1, 6, 7], highway="residential", name="Side St", **side),
    ]}


class ParseLanes(unittest.TestCase):
    def test_plain_and_odd_values(self):
        self.assertEqual(build_roads.parse_lanes("4"), 4)
        self.assertEqual(build_roads.parse_lanes("2;3"), 3)
        self.assertEqual(build_roads.parse_lanes("2.5"), 2)
        self.assertEqual(build_roads.parse_lanes(None), 0)
        self.assertEqual(build_roads.parse_lanes("many"), 0)
        self.assertEqual(build_roads.parse_lanes("40"), 0)  # a typo, not a road


class LanesInRoadFile(unittest.TestCase):
    def build(self, osm):
        g = sr.Graph(osm)
        return build_roads.compact(g, build_roads.segment_lanes(osm))

    def test_one_lane_count_per_edge(self):
        d = self.build(plus_with_lanes("4"))
        self.assertEqual(len(d["lanes"]), len(d["edges"]) // 9)
        for k, ln in enumerate(d["lanes"]):
            name = d["names"][d["edges"][9 * k + 6]]
            self.assertEqual(ln, 4 if name == "Main St" else 0, name)

    def test_no_lanes_list_when_osm_has_none(self):
        d = self.build(plus_with_lanes(None))
        self.assertNotIn("lanes", d)

    def test_edges_unchanged_by_lanes(self):
        osm = plus_with_lanes("4", "2")
        g = sr.Graph(osm)
        self.assertEqual(build_roads.compact(g)["edges"], build_roads.compact(g, build_roads.segment_lanes(osm))["edges"])


if __name__ == "__main__":
    unittest.main()
