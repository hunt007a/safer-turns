"""Unit tests for the download, command-line and file-writing parts of build_roads.py and
safer_route.py. Run: python -m unittest discover -s tests -p "test_*.py" """
import contextlib
import gzip
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import build_roads  # noqa: E402
import safer_route as sr  # noqa: E402
from test_builder import node, plus_osm, way  # noqa: E402

SAMPLE_OSM = os.path.join(HERE, "sample_osm.json")


class FakeResponse:
    def __init__(self, status=200, data=None):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code != 200:
            raise RuntimeError(self.status_code)


class FakeRequests:
    """Answers each post from a list: a FakeResponse, or an exception to raise."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.urls = []

    def post(self, url, **kw):
        self.urls.append(url)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


def quiet():
    return contextlib.redirect_stderr(io.StringIO())


def tmpdir(case):
    d = tempfile.mkdtemp()
    case.addCleanup(shutil.rmtree, d)
    return d


def load_sample():
    with open(SAMPLE_OSM, encoding="utf-8") as f:
        return json.load(f)


@mock.patch("time.sleep", lambda s: None)
class Download(unittest.TestCase):
    def test_first_server_answers(self):
        fake = FakeRequests([FakeResponse(200, {"elements": [{"type": "node", "id": 1}]})])
        with mock.patch.object(sr, "requests", fake):
            self.assertEqual(build_roads.overpass_tile(1, 2, 3, 4), [{"type": "node", "id": 1}])
        self.assertEqual(fake.urls, build_roads.OVERPASS_SERVERS[:1])

    def test_busy_servers_are_rotated(self):
        fake = FakeRequests([FakeResponse(504), TimeoutError("slow"),
                             FakeResponse(200, {"remark": "runtime error: timeout", "elements": []}),
                             FakeResponse(200, {"elements": []})])
        with mock.patch.object(sr, "requests", fake), quiet():
            self.assertEqual(build_roads.overpass_tile(1, 2, 3, 4), [])
        self.assertEqual(fake.urls, build_roads.OVERPASS_SERVERS)

    def test_gives_up_after_retries(self):
        fake = FakeRequests([FakeResponse(500)] * 3)
        with mock.patch.object(sr, "requests", fake), quiet():
            with self.assertRaises(RuntimeError):
                build_roads.overpass_tile(1, 2, 3, 4, retries=3)

    def test_needs_requests(self):
        with mock.patch.object(sr, "requests", None):
            with self.assertRaises(SystemExit):
                build_roads.overpass_tile(1, 2, 3, 4)

    def test_failing_tile_is_split_into_four_and_merged(self):
        calls = []

        def tile(s, w, n, e, retries=8):
            calls.append((s, w, n, e))
            if len(calls) == 1:
                raise RuntimeError("timeout")
            return [{"type": "node", "id": 1}, {"type": "node", "id": len(calls)}]

        with mock.patch.object(build_roads, "overpass_tile", tile), quiet():
            out = build_roads.fetch_tile(0, 0, 2, 2)
        self.assertEqual(len(calls), 5)
        self.assertEqual(sorted(el["id"] for el in out), [1, 2, 3, 4, 5])  # node 1 only once

    def test_split_gives_up_at_the_deepest_level(self):
        def tile(*a, **k):
            raise RuntimeError("down")

        with mock.patch.object(build_roads, "overpass_tile", tile), quiet():
            with self.assertRaises(SystemExit):
                build_roads.fetch_tile(0, 0, 1, 1, depth=2)

    def test_download_caches_tiles_and_merges_duplicates(self):
        tmp = tmpdir(self)
        got = []

        def tile(s, w, n, e, depth=0):
            got.append(1)
            return [{"type": "node", "id": 7}, {"type": "node", "id": len(got) + 100}]

        with mock.patch.object(build_roads, "CACHE", tmp), mock.patch.object(build_roads, "fetch_tile", tile), quiet():
            first = build_roads.download((0, 0, 1, 1), splits=2)
            again = build_roads.download((0, 0, 1, 1), splits=2)
        self.assertEqual(len(got), 4)  # the second run read every tile from the cache
        self.assertEqual(len(first["elements"]), 5)  # node 7 once, plus 4 others
        self.assertEqual(first, again)


class BuilderMain(unittest.TestCase):
    def test_builds_road_file_and_gzipped_copy(self):
        out = os.path.join(tmpdir(self), "roads", "x.json")
        argv = ["build_roads.py", "--osm-file", SAMPLE_OSM, "--out", out, "--area-name", "Test"]
        with mock.patch.object(sys, "argv", argv), quiet():
            build_roads.main()
        with open(out, encoding="utf-8") as f:
            data = json.load(f)
        with gzip.open(out + ".gz", "rt", encoding="utf-8") as f:
            self.assertEqual(json.load(f), data)
        self.assertEqual(data["area"], "Test")
        self.assertEqual(data["stats"]["nodes"], len(data["flags"]))
        self.assertEqual(data["stats"]["signalized"], 16)
        s, w, n, e = data["bbox"]
        self.assertTrue(s < n and w < e)

    def test_gzipped_copy_is_byte_for_byte_repeatable(self):
        tmp = tmpdir(self)
        a, b = os.path.join(tmp, "a.json"), os.path.join(tmp, "b.json")
        build_roads.write_road_file({"x": 1}, a)
        build_roads.write_road_file({"x": 1}, b)
        with open(a + ".gz", "rb") as fa, open(b + ".gz", "rb") as fb:
            self.assertEqual(fa.read(), fb.read())

    def test_downloads_when_no_file_given(self):
        tmp = tmpdir(self)
        out, saved = os.path.join(tmp, "x.json"), os.path.join(tmp, "osm.json")
        argv = ["build_roads.py", "--bbox", "43.63,-79.43,43.65,-79.40", "--out", out, "--save-osm", saved]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(build_roads, "download", return_value=load_sample()) as dl, quiet():
            build_roads.main()
        dl.assert_called_once_with((43.63, -79.43, 43.65, -79.40), 6)
        self.assertTrue(os.path.exists(saved))

    def test_compact_drops_a_loop_with_no_junction(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4), node(3, 43.701, -79.401),
                            way(1, [1, 2, 3, 1], highway="residential", name="Loop")]}
        self.assertEqual(build_roads.compact(sr.Graph(osm))["edges"], [])


class PrototypeCli(unittest.TestCase):
    TRIP = ["--from", "43.64595,-79.4263", "--to", "43.63515,-79.41705"]

    def run_main(self, *extra):
        argv = ["safer_route.py", "--osm-file", SAMPLE_OSM, *self.TRIP, *extra]
        out = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out), quiet():
            sr.main()
        return out.getvalue()

    def test_json_output(self):
        out = json.loads(self.run_main("--json"))
        self.assertEqual(out["decision"], "safer")
        self.assertIn("waypoints=", out["google_maps_url"])
        self.assertLess(len(out["safer"]["risky_turns"]), len(out["fastest"]["risky_turns"]))

    def test_text_output(self):
        out = self.run_main()
        self.assertIn("Decision: safer", out)
        self.assertIn("unsignalized left", out)
        self.assertIn("Open in Google Maps: https://www.google.com/maps/dir/?api=1", out)

    def test_detour_limit_falls_back_to_fastest(self):
        out = json.loads(self.run_main("--json", "--max-detour-min", "0.001"))
        self.assertEqual(out["decision"], "fastest (detour too long)")
        self.assertNotIn("waypoints", out["google_maps_url"])

    def test_map_file(self):
        path = os.path.join(tmpdir(self), "map.html")
        self.run_main("--json", "--map", path)
        with open(path, encoding="utf-8") as f:
            html = f.read()
        self.assertIn("const D={", html)
        self.assertNotIn("__DATA__", html)
        self.assertIn("&amp;destination=", html)

    def test_download_and_save(self):
        saved = os.path.join(tmpdir(self), "osm.json")
        argv = ["safer_route.py", *self.TRIP, "--json", "--save-osm", saved]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(sr, "fetch_osm", return_value=load_sample()), \
                contextlib.redirect_stdout(io.StringIO()), quiet():
            sr.main()
        self.assertTrue(os.path.exists(saved))

    def test_no_route(self):
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4), node(3, 43.7, -79.39), node(4, 43.701, -79.39),
                            way(1, [1, 2], highway="residential", name="A"),
                            way(2, [3, 4], highway="residential", name="B")]}
        path = os.path.join(tmpdir(self), "osm.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(osm, f)
        argv = ["safer_route.py", "--osm-file", path, "--from", "43.7,-79.4", "--to", "43.7,-79.39"]
        with mock.patch.object(sys, "argv", argv), quiet():
            with self.assertRaises(SystemExit):
                sr.main()


class PrototypeParts(unittest.TestCase):
    def test_fetch_osm_posts_a_query(self):
        fake = FakeRequests([FakeResponse(200, {"elements": []})])
        with mock.patch.object(sr, "requests", fake):
            self.assertEqual(sr.fetch_osm((43.7, -79.4), (43.71, -79.39)), {"elements": []})
        self.assertEqual(fake.urls, [sr.OVERPASS_URL])
        with mock.patch.object(sr, "requests", None):
            with self.assertRaises(SystemExit):
                sr.fetch_osm((0, 0), (1, 1))

    def test_decision_order_matches_the_app(self):
        self.assertEqual(sr.decision(True, False, {"risky": [1]}), "safer")
        self.assertEqual(sr.decision(False, True, {"risky": []}), "fastest (already safe)")
        self.assertEqual(sr.decision(False, True, {"risky": [1]}), "fastest (detour too long)")
        self.assertEqual(sr.decision(False, False, {"risky": [1]}), "fastest (no better option)")

    def test_nearest_and_uturn(self):
        g = sr.Graph(plus_osm())
        self.assertEqual(g.nearest((43.70001, -79.40001)), 1)
        self.assertEqual(g.classify_turn(4, 1, 4, None, None)[0], "uturn")

    def test_gmaps_url_spreads_waypoints(self):
        g = sr.Graph(plus_osm())
        path = [5, 4, 1, 8, 9]
        edges = sr.describe(g, path, sr.DEFAULTS)["edges"]
        with mock.patch.object(sr, "turn_points", return_value=[4, 1, 8, 9, 2]):
            url = sr.gmaps_url(g, (43.699, -79.4), (43.7, -79.4014), path, edges, set(), 2)
        self.assertEqual(url.count("|"), 1)  # 2 of the 5 candidates

    def test_multipoint_with_several_points_and_ragged_rows(self):
        path = os.path.join(tmpdir(self), "s.csv")
        with open(path, "w", encoding="utf-8") as f:
            f.write('id,geometry\n1,"{""type"": ""MultiPoint"", ""coordinates"": [[-79.4, 43.7], [-79.41, 43.71]]}",extra\n')
        self.assertEqual(sr.load_signals_csv(path), [(43.7, -79.4), (43.71, -79.41)])

    def test_risk_kind_not_penalty_value_decides_risky(self):
        # with right_busy equal to left_local, every local left used to count as risky
        osm = {"elements": [node(1, 43.7, -79.4), node(2, 43.701, -79.4), node(3, 43.7, -79.4014),
                            node(4, 43.699, -79.4), node(5, 43.7, -79.3986),
                            way(1, [4, 1, 2], highway="residential", name="Elm"),
                            way(2, [5, 1, 3], highway="residential", name="Oak")]}
        g = sr.Graph(osm)
        p = dict(sr.DEFAULTS, right_busy=sr.DEFAULTS["left_local"])
        self.assertEqual(sr.describe(g, [4, 1, 3], p)["risky"], [])


if __name__ == "__main__":
    unittest.main()
