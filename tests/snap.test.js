// Snapping a start or end only onto the connected road network (web/router.js mainComponent).
// Run: node --test "tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const R = require("../web/router.js");

// Same compact road format as router.test.js. Roads are [from, to, seconds, metres, rank, twoWay, name].
function makeData(nodes, roads, names) {
  const data = { names, nodes: [], flags: [], roads: [], edges: [], geom: [], bbox: [0, 0, 0, 0] };
  const touching = nodes.map(() => []);
  for (const [a, b, t, len, rank, tw, name] of roads) {
    data.edges.push(a, b, Math.round(t * 10), len, rank, tw ? 1 : 0, name, 0, 0);
    touching[a].push([rank, tw ? 1 : 0, name]);
    touching[b].push([rank, tw ? 1 : 0, name]);
  }
  nodes.forEach(([la, lo], i) => {
    data.nodes.push(Math.round(la * 1e5), Math.round(lo * 1e5));
    const junction = new Set(touching[i].map((r) => r[2])).size >= 2 || touching[i].length >= 3;
    data.flags.push(junction ? 2 : 0);
    data.roads.push(junction ? touching[i] : []);
  });
  return data;
}

// A square of two-way streets (nodes 0-3), plus:
//  - an island: nodes 4-5, a two-way lane joined to nothing (like a zoo's inside roads);
//  - a trap: node 6, reached from node 1 by a one-way street with no way back out.
const D = 0.001;
function town() {
  const nodes = [
    [43.7, -79.4], [43.7, -79.4 + D * 1.4], [43.7 + D, -79.4 + D * 1.4], [43.7 + D, -79.4], // square
    [43.7 + 3 * D, -79.4 + 3 * D], [43.7 + 3 * D, -79.4 + 3.5 * D],                           // island
    [43.7 - D, -79.4 + D * 1.4],                                                              // trap
  ];
  const roads = [
    [0, 1, 10, 111, 1, true, 0], [1, 2, 10, 111, 1, true, 1], [2, 3, 10, 111, 1, true, 0], [3, 0, 10, 111, 1, true, 1],
    [4, 5, 10, 40, 0, true, 2],
    [1, 6, 10, 111, 0, false, 3],
  ];
  const g = R.loadGraph(makeData(nodes, roads, ["A St", "B St", "Zoo Rd", "Dead End"]));
  return g;
}
// Turn the filter on for a graph smaller than the real-data limit, and drop the grid so nearest() scans.
function withMain(g) { g.main = R.mainComponent(g, 0); g.grid = null; return g; }

test("mainComponent: keeps the connected streets, drops islands and one-way traps", () => {
  const g = withMain(town());
  assert.deepEqual([...g.main], [1, 1, 1, 1, 0, 0, 0]);
});

test("nearest: a point beside an island road snaps to the connected network instead", () => {
  const g = town();
  const beside = [43.7 + 3 * D, -79.4 + 3.2 * D];
  assert.ok([4, 5].includes(R.nearest(g, beside)), "without the filter it lands on the island");
  withMain(g);
  assert.ok(!([4, 5].includes(R.nearest(g, beside))), "with the filter it does not");
  assert.equal(R.nearest(g, [43.7 - D, -79.4 + D * 1.4]), 1, "the trap's spot snaps to the street before it");
});

test("plan: a trip ending beside the island gets a route, not 'no route'", () => {
  const g = withMain(town());
  const r = R.plan(g, [43.7, -79.4], [43.7 + 3 * D, -79.4 + 3.2 * D], { max_snap_m: 1000 });
  assert.ok(!r.error, `got ${r.error}`);
});

test("graphs smaller than the limit are left alone (hand-made test graphs)", () => {
  const g = town();
  assert.equal(g.flags.length < R.MAIN_MIN_NODES, true);
  assert.equal(g.main, null);
  assert.equal(R.mainComponent(g), null);
});

test("mainComponent on the sample grid: most junctions are in the main network", () => {
  const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8")));
  const m = R.mainComponent(g, 0);
  const n = m.reduce((s, x) => s + x, 0);
  assert.ok(n > 0.9 * m.length, `${n} of ${m.length}`);
  // every main junction can reach every other: spot-check a few routes between them
  const ids = [...m.keys()].filter((i) => m[i] && g.out[i].length);
  for (let k = 1; k < ids.length; k += Math.ceil(ids.length / 7)) {
    assert.ok(R.search(g, ids[0], ids[k], R.DEFAULTS, false), `no route from ${ids[0]} to ${ids[k]}`);
  }
});

const TORONTO = path.join(__dirname, "..", "web", "roads", "toronto.json");
test("Toronto: Union Station to the Toronto Zoo finds a route", { skip: !fs.existsSync(TORONTO) && "needs web/roads/toronto.json (run run.bat)" }, () => {
  const g = R.loadGraph(JSON.parse(fs.readFileSync(TORONTO, "utf8")));
  const union = [43.6453, -79.3806], zoo = [43.8196233, -79.1844977];
  for (const [a, b] of [[union, zoo], [zoo, union]]) {
    const r = R.plan(g, a, b, {});
    assert.ok(!r.error, `got ${r.error}`);
    assert.ok(r.fastest.minutes > 15 && r.fastest.minutes < 45, `${r.fastest.minutes} min`);
  }
});
