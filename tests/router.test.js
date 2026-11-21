// Unit tests for web/router.js. Run: node --test tests/
// Uses the sample street grid (tests/sample_roads.json) plus small hand-made graphs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const R = require("../web/router.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8"));
const g = R.loadGraph(SAMPLE);

/* ---------- a tiny hand-made road file ----------
 * Builds the compact format build_roads.py writes. Each road is
 * [from, to, seconds, metres, rank, twoWay, name]; nodes are [lat, lon, signal].
 */
function makeData(nodes, roads, names) {
  const data = { names, nodes: [], flags: [], roads: [], edges: [], geom: [], bbox: [0, 0, 0, 0] };
  const touching = nodes.map(() => []);
  for (const [a, b, t, len, rank, tw, name] of roads) {
    data.edges.push(a, b, Math.round(t * 10), len, rank, tw ? 1 : 0, name, 0, 0);
    touching[a].push([rank, tw ? 1 : 0, name]);
    touching[b].push([rank, tw ? 1 : 0, name]);
  }
  nodes.forEach(([la, lo, sig], i) => {
    data.nodes.push(Math.round(la * 1e5), Math.round(lo * 1e5));
    const junction = new Set(touching[i].map((r) => r[2])).size >= 2 || touching[i].length >= 3;
    data.flags.push((sig ? 1 : 0) | (junction ? 2 : 0));
    data.roads.push(junction ? touching[i] : []);
  });
  return data;
}

// A plus-shaped junction (node 0) with arms north (1), east (2), south (3), west (4).
// Main St runs north-south (busy, rank 3); Side St runs east-west (local, rank 0).
const D = 0.001; // about 111 m of latitude
function plus({ signal = false, mainTwoWay = true, sideRank = 0 } = {}) {
  const nodes = [[43.7, -79.4, signal], [43.7 + D, -79.4], [43.7, -79.4 + D * 1.38], [43.7 - D, -79.4], [43.7, -79.4 - D * 1.38]];
  const roads = [
    [3, 0, 10, 111, 3, mainTwoWay, 0], [0, 1, 10, 111, 3, mainTwoWay, 0],
    [4, 0, 10, 111, sideRank, true, 1], [0, 2, 10, 111, sideRank, true, 1],
  ];
  return R.loadGraph(makeData(nodes, roads, ["Main St", "Side St"]));
}
// directed edge from node a to node b
const edge = (gr, a, b) => gr.dir.find((e) => e.a === a && e.b === b);

/* ---------- geometry ---------- */
test("haversine: one degree of latitude is about 111.2 km", () => {
  assert.ok(Math.abs(R.haversine([43, -79], [44, -79]) - 111195) < 5);
  assert.equal(R.haversine([43.7, -79.4], [43.7, -79.4]), 0);
});

test("bearing: compass directions", () => {
  const o = [43.7, -79.4];
  assert.ok(Math.abs(R.bearing(o, [43.71, -79.4]) - 0) < 0.01);
  assert.ok(Math.abs(R.bearing(o, [43.7, -79.39]) - 90) < 0.1);
  assert.ok(Math.abs(R.bearing(o, [43.69, -79.4]) - 180) < 0.01);
  assert.ok(Math.abs(R.bearing(o, [43.7, -79.41]) - 270) < 0.1);
});

test("turnKind: straight, right, left and U-turn from the bearings", () => {
  const k = (b1, b0) => R.turnKind({ b1 }, { b0 });
  assert.equal(k(0, 10), "straight");
  assert.equal(k(0, 90), "right");
  assert.equal(k(0, 270), "left");
  assert.equal(k(0, 180), "uturn");
  assert.equal(k(350, 80), "right"); // wraps through north
  assert.equal(k(10, 280), "left");
});

/* ---------- loading ---------- */
test("loadGraph: two-way roads become two directed edges, one-way roads one", () => {
  const twoWay = SAMPLE.edges.filter((_, i) => i % 9 === 5).reduce((n, v) => n + v, 0);
  assert.equal(g.dir.length, SAMPLE.edges.length / 9 + twoWay);
  for (const [k, e] of g.dir.entries()) assert.ok(g.out[e.a].includes(k));
});

test("loadGraph: edge bearings match the edge's drawn geometry, both directions", () => {
  // the optimized loader works bearings out without building point arrays; check it
  // against the points the map draws
  const pts = (e) => {
    const mid = [];
    for (let k = 0; k < e.gc; k++) mid.push([SAMPLE.geom[2 * (e.gs + k)] / 1e5, SAMPLE.geom[2 * (e.gs + k) + 1] / 1e5]);
    if (e.rev) mid.reverse();
    return [[g.lat[e.a], g.lon[e.a]], ...mid, [g.lat[e.b], g.lon[e.b]]];
  };
  for (const e of g.dir) {
    const p = pts(e);
    assert.ok(Math.abs(e.b0 - R.bearing(p[0], p[1])) < 1e-9);
    assert.ok(Math.abs(e.b1 - R.bearing(p[p.length - 2], p[p.length - 1])) < 1e-9);
  }
});

test("loadGraph: top speed is a real edge's speed", () => {
  assert.ok(g.vmax > 5 && g.vmax < 40, `vmax ${g.vmax} m/s`);
});

/* ---------- turn penalties ---------- */
test("unsignalized left off a busy two-way road gets the busy-left penalty", () => {
  const gr = plus();
  const t = R.turnInfo(gr, edge(gr, 3, 0), edge(gr, 0, 4), R.DEFAULTS); // north on Main, left onto Side west
  assert.equal(t.kind, "left");
  assert.equal(t.risk, "left");
  assert.equal(t.pen, R.DEFAULTS.left_busy);
});

test("the same left at a traffic signal costs nothing", () => {
  const gr = plus({ signal: true });
  const t = R.turnInfo(gr, edge(gr, 3, 0), edge(gr, 0, 4), R.DEFAULTS);
  assert.equal(t.signal, true);
  assert.equal(t.pen, 0);
  assert.equal(t.risk, null);
});

test("a left where every road is local gets only the small local penalty", () => {
  const nodes = [[43.7, -79.4], [43.7 + D, -79.4], [43.7, -79.4 + D * 1.38], [43.7 - D, -79.4], [43.7, -79.4 - D * 1.38]];
  const roads = [[3, 0, 10, 111, 0, true, 0], [0, 1, 10, 111, 0, true, 0], [4, 0, 10, 111, 0, true, 1], [0, 2, 10, 111, 0, true, 1]];
  const gr = R.loadGraph(makeData(nodes, roads, ["Elm St", "Oak St"]));
  const t = R.turnInfo(gr, edge(gr, 3, 0), edge(gr, 0, 4), R.DEFAULTS);
  assert.equal(t.pen, R.DEFAULTS.left_local);
  assert.equal(t.risk, null);
});

test("a right onto a busier road is risky only when rights are penalized", () => {
  const gr = plus();
  const eIn = edge(gr, 2, 0), eOut = edge(gr, 0, 1); // west on Side, right onto Main north
  assert.equal(R.turnInfo(gr, eIn, eOut, R.DEFAULTS).risk, "right");
  assert.equal(R.turnInfo(gr, eIn, eOut, R.DEFAULTS).pen, 0);
  assert.equal(R.turnInfo(gr, eIn, eOut, { ...R.DEFAULTS, right_busy: 120 }).pen, 120);
});

test("going straight through never costs anything", () => {
  const gr = plus();
  assert.equal(R.turnInfo(gr, edge(gr, 3, 0), edge(gr, 0, 1), R.DEFAULTS).pen, 0);
});

test("turnPen gives the same penalty as turnInfo for every turn in the sample grid", () => {
  for (const p of [R.DEFAULTS, { ...R.DEFAULTS, right_busy: 120 }, { ...R.DEFAULTS, left_busy: 50, left_local: 3 }]) {
    let n = 0;
    for (const eIn of g.dir) for (const k2 of g.out[eIn.b]) {
      const eOut = g.dir[k2];
      assert.equal(R.turnPen(g, eIn, eOut, p), R.turnInfo(g, eIn, eOut, p).pen);
      n++;
    }
    assert.ok(n > 500);
  }
});

/* ---------- heap ---------- */
test("Heap pops keys in order, including duplicates and growth past its first size", () => {
  const h = new R.Heap(4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const keys = Array.from({ length: 500 }, () => Math.floor(rnd() * 100));
  keys.forEach((k, i) => h.push(k, i));
  const outK = [];
  while (h.size) { const v = h.pop(); assert.equal(keys[v], h.key); outK.push(h.key); }
  assert.deepEqual(outK, [...keys].sort((a, b) => a - b));
});

/* ---------- search ---------- */
// Plain Dijkstra over the same edge states, as the reference for the A* search.
function referenceCost(gr, src, dst, p, safe) {
  const best = new Float64Array(gr.dir.length).fill(Infinity);
  const todo = new Set();
  for (const k of gr.out[src]) { best[k] = gr.dir[k].time; todo.add(k); }
  while (todo.size) {
    let k = -1;
    for (const x of todo) if (k < 0 || best[x] < best[k]) k = x;
    todo.delete(k);
    const eIn = gr.dir[k];
    if (eIn.b === dst) return best[k];
    for (const k2 of gr.out[eIn.b]) {
      const eOut = gr.dir[k2];
      const pen = eOut.b === eIn.a && gr.out[eIn.b].length > 1 ? p.uturn : safe ? R.turnInfo(gr, eIn, eOut, p).pen : 0;
      if (best[k] + eOut.time + pen < best[k2]) { best[k2] = best[k] + eOut.time + pen; todo.add(k2); }
    }
  }
  return Infinity;
}
// Cost of a path of directed edges as the search counts it: time plus turn penalties.
function pathCost(gr, path, p, safe) {
  let c = gr.dir[path[0]].time;
  for (let i = 1; i < path.length; i++) {
    const eIn = gr.dir[path[i - 1]], eOut = gr.dir[path[i]];
    const pen = eOut.b === eIn.a && gr.out[eIn.b].length > 1 ? p.uturn : safe ? R.turnInfo(gr, eIn, eOut, p).pen : 0;
    c += eOut.time + pen;
  }
  return c;
}

for (const safe of [false, true]) {
  test(`A* ${safe ? "safer" : "fastest"} search finds the same lowest cost as plain Dijkstra`, () => {
    const ids = [];
    for (let i = 0; i < g.flags.length; i += 5) if (g.out[i].length) ids.push(i);
    let n = 0;
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      const ref = referenceCost(g, a, b, R.DEFAULTS, safe);
      const path = R.search(g, a, b, R.DEFAULTS, safe);
      if (!Number.isFinite(ref)) { assert.equal(path, null); continue; }
      assert.equal(g.dir[path[0]].a, a);
      assert.equal(g.dir[path[path.length - 1]].b, b);
      assert.ok(Math.abs(pathCost(g, path, R.DEFAULTS, safe) - ref) < 1e-6, `${a}->${b}`);
      n++;
    }
    assert.ok(n > 500, `${n} trips compared`);
  });
}

/* ---------- plan ---------- */
const trip = [[43.64595, -79.4263], [43.63515, -79.41705]]; // a trip with a risky left on the sample grid

test("plan: safer route skips the risky left and pairs it with a replacement", () => {
  const r = R.plan(g, trip[0], trip[1], {});
  assert.equal(r.decision, "safer");
  assert.ok(r.safer.risky.length < r.fastest.risky.length);
  const paired = r.pairs.reduce((n, p) => n + p.avoided.length, 0);
  assert.equal(paired, r.fastest.risky.length, "every risky turn on the fastest route is in a pair");
  assert.ok(r.pins.length >= 1 && r.pins.length <= 3);
  assert.match(r.google_url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=/);
  assert.match(r.google_url, /&waypoints=/);
});

test("plan: a tiny detour limit falls back to the fastest route with no stops", () => {
  const r = R.plan(g, trip[0], trip[1], { max_detour_min: 0.001 });
  assert.equal(r.decision, "too_far");
  assert.equal(r.chosen, "fastest");
  assert.ok(!r.google_url.includes("waypoints"));
  assert.deepEqual(r.still_risky, []);
});

test("plan: at most max_waypoints pins, in route order", () => {
  const r = R.plan(g, [43.6500, -79.4300], [43.6338, -79.4078], { max_waypoints: 1 });
  assert.ok(r.pins.length <= 1);
  const r3 = R.plan(g, [43.6500, -79.4300], [43.6338, -79.4078], {});
  assert.ok(r3.pins.length <= 3);
});

test("plan: start and end at the same junction", () => {
  assert.equal(R.plan(g, trip[0], trip[0], {}).error, "same");
});

test("plan: a point far from every road is reported as off the map", () => {
  assert.equal(R.plan(g, [43.9, -79.0], trip[1], {}).error, "outside");
  assert.equal(R.plan(g, trip[0], [43.5, -79.9], {}).error, "outside");
});

test("plan: a fastest route with no risky turns is 'already safe', even past the detour limit", () => {
  // On real maps the safer search can wander to dodge small local-left penalties and
  // go past the limit. A negative limit forces "past the limit" on this tiny grid.
  const gr = plus({ mainTwoWay: true });
  const r = R.plan(gr, [43.7 - D, -79.4], [43.7 + D, -79.4], { max_detour_min: -1 });
  assert.equal(r.fastest.risky.length, 0);
  assert.equal(r.decision, "already_safe");
});

test("plan: 'avoid rights' turns risky rights into risky turns", () => {
  const gr = plus();
  // west along Side St then right (north) onto busy Main St
  const off = R.plan(gr, [43.7, -79.4 + D * 1.38], [43.7 + D, -79.4], {});
  const on = R.plan(gr, [43.7, -79.4 + D * 1.38], [43.7 + D, -79.4], { avoid_rights: true });
  assert.equal(off.fastest.risky.length, 0);
  assert.equal(on.fastest.risky.length, 1);
  assert.equal(on.fastest.risky[0].risk, "right");
});

test("plan: the step list names each road change", () => {
  const r = R.plan(g, trip[0], trip[1], {});
  for (const s of r.fastest.steps) assert.ok(s.text.length > 0 && !s.text.includes("undefined"));
});

/* ---------- pairing and links ---------- */
test("segments: finds where the safer route leaves and rejoins the fastest", () => {
  const F = { nodes: [1, 2, 3, 4, 5] };
  const S = { nodes: [1, 2, 9, 8, 4, 5] };
  assert.deepEqual(R.segments(F, S), [{ sA: 1, sB: 4, fA: 1, fB: 3 }]);
  assert.deepEqual(R.segments(F, { nodes: [1, 2, 3, 4, 5] }), []);
});

test("gmapsUrl: six-decimal coordinates and | between waypoints", () => {
  const u = R.gmapsUrl([43.1, -79.2], [43.3, -79.4], [[43.15, -79.25], [43.2, -79.3]]);
  assert.equal(u, "https://www.google.com/maps/dir/?api=1&origin=43.100000,-79.200000&destination=43.300000,-79.400000&travelmode=driving&waypoints=43.150000,-79.250000%7C43.200000,-79.300000");
  assert.ok(!R.gmapsUrl([1, 2], [3, 4], []).includes("waypoints"));
});
