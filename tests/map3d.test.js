// Unit tests for the 3D map work: risky-turn reasons (web/router.js), the turn preview
// and map mode choice (web/preview.js), and what the map draws (web/map.js).
// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const R = require("../web/router.js");
const P = require("../web/preview.js");
require("../web/map.js"); // sets globalThis.SaferMap; needs no browser until a map is created
const M = globalThis.SaferMap;

/* ---------- a tiny road file, like router.test.js, plus a lanes list ---------- */
function makeData(nodes, roads, names, lanes) {
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
  if (lanes) data.lanes = lanes;
  return data;
}
// + junction at node 0; Main St north-south (busy), Side St east-west (local)
const D = 0.001;
function plus({ mainLanes = 4, sideLanes = 0, mainTwoWay = true, withLanes = true } = {}) {
  const nodes = [[43.7, -79.4], [43.7 + D, -79.4], [43.7, -79.4 + D * 1.38], [43.7 - D, -79.4], [43.7, -79.4 - D * 1.38]];
  const roads = [
    [3, 0, 10, 111, 3, mainTwoWay, 0], [0, 1, 10, 111, 3, mainTwoWay, 0],
    [4, 0, 10, 111, 0, true, 1], [0, 2, 10, 111, 0, true, 1],
  ];
  return R.loadGraph(makeData(nodes, roads, ["Main St", "Side St"], withLanes ? [mainLanes, mainLanes, sideLanes, sideLanes] : null));
}
// describe one turn through node 0 the way plan() does, and return its public form
function turnThrough(g, a, b) {
  const k1 = g.dir.findIndex((e) => e.a === a && e.b === 0), k2 = g.dir.findIndex((e) => e.a === 0 && e.b === b);
  const r = R.plan(g, [g.lat[a], g.lon[a]], [g.lat[b], g.lon[b]], { max_detour_min: 0, max_detour_pct: 0 });
  // plan() picks its own path; check it went through the junction as intended
  assert.ok(k1 >= 0 && k2 >= 0);
  return r.fastest.steps.find((t) => t.at[0] === g.lat[0] && t.at[1] === g.lon[0]);
}

/* ---------- reasons ---------- */
test("left off a busy two-way road: crosses half its lanes, the oncoming ones", () => {
  const t = turnThrough(plus({ mainLanes: 4 }), 3, 4); // north on Main St, left onto Side St (west)
  assert.equal(t.kind, "left");
  assert.equal(t.risk, "left");
  assert.equal(t.lanes, 2);
  assert.equal(t.reason, "No signal, crossing 2 lanes of oncoming traffic");
  assert.equal(t.tag, "No signal · 2 lanes oncoming");
});

test("left from a side street onto a busy road: crosses all its lanes, both ways", () => {
  const t = turnThrough(plus({ mainLanes: 4 }), 2, 3); // west on Side St, left onto Main St (south)
  assert.equal(t.kind, "left");
  assert.equal(t.lanes, 4);
  assert.equal(t.reason, "No signal, crossing 4 lanes of two-way traffic");
  assert.equal(t.tag, "No signal · 4 lanes, two-way");
});

test("no lane data: the reason still says what is crossed, with no number", () => {
  const t = turnThrough(plus({ withLanes: false }), 2, 3);
  assert.equal(t.lanes, 0);
  assert.equal(t.reason, "No signal, crossing two-way traffic");
  const t2 = turnThrough(plus({ withLanes: false }), 3, 4);
  assert.equal(t2.reason, "No signal, crossing oncoming traffic");
});

test("a 3-lane road rounds its oncoming side up, and one lane is singular", () => {
  assert.equal(turnThrough(plus({ mainLanes: 3 }), 3, 4).lanes, 2);
  assert.equal(R.shortReason({ risk: "left", crossWhat: "oncoming", crossLanes: 1 }).reason, "No signal, crossing 1 lane of oncoming traffic");
});

test("shortReason: rights merge, one-way roads, and safe turns", () => {
  assert.equal(R.shortReason({ risk: "right", crossLanes: 3 }).reason, "No signal, merging into 3 lanes of fast traffic");
  assert.equal(R.shortReason({ risk: "right", crossLanes: 0 }).tag, "No signal · fast merge");
  assert.equal(R.shortReason({ risk: "left", crossWhat: "oneway", crossLanes: 3 }).reason, "No signal, crossing 3 lanes of one-way traffic");
  assert.deepEqual(R.shortReason({ risk: null }), { reason: "", tag: "" });
});

test("every turn carries the heading you arrive on, for the preview camera", () => {
  const t = turnThrough(plus(), 3, 4); // arriving northbound
  assert.ok(t.hdg <= 1 || t.hdg >= 359, `heading ${t.hdg}`);
  assert.ok(Math.abs(t.hdgOut - 270) <= 1, `heading out ${t.hdgOut}`);
});

test("the sample grid's road file (no lanes list) still plans, with reasons on every risky turn", () => {
  const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8")));
  const r = R.plan(g, [43.64595, -79.4263], [43.63515, -79.41705], {});
  assert.equal(r.decision, "safer");
  const risky = [...r.fastest.risky, ...r.pairs.flatMap((p) => p.avoided)];
  assert.ok(risky.length);
  for (const t of risky) assert.match(t.reason, /^No signal, /);
});

/* ---------- map mode ---------- */
test("pickMode: no WebGL gets Leaflet; weak phones and data saver get flat; the person's choice wins", () => {
  assert.equal(P.pickMode({ webgl: false, saved: "3d" }), "leaflet");
  assert.equal(P.pickMode({ webgl: true, cores: 8, memoryGb: 8 }), "3d");
  assert.equal(P.pickMode({ webgl: true, cores: 2 }), "2d");
  assert.equal(P.pickMode({ webgl: true, memoryGb: 1 }), "2d");
  assert.equal(P.pickMode({ webgl: true, saveData: true }), "2d");
  assert.equal(P.pickMode({ webgl: true, reducedMotion: true }), "3d"); // still 3D, just no flights
  assert.equal(P.pickMode({ webgl: true, cores: 2, saved: "3d" }), "3d");
  assert.equal(P.pickMode({ webgl: true, saved: "2d" }), "2d");
  assert.equal(P.pickMode({ webgl: true }), "3d"); // browsers that report nothing
});

/* ---------- preview stops ---------- */
const turn = (i, kind, extra) => ({ i, kind, text: `${kind} ${i}`, at: [43.7 + i * 1e-3, -79.4], hdg: i * 10, signal: false, junction: true, risk: null, ...extra });
function fakeResult() {
  const safer = [turn(2, "right"), turn(4, "straight"), turn(5, "left", { signal: true }), turn(9, "right")];
  return {
    decision: "safer",
    pairs: [
      { avoided: [turn(3, "left", { risk: "left", reason: "No signal, crossing 4 lanes of two-way traffic", tag: "No signal · 4 lanes, two-way" })], instead: [safer[1], safer[2]] },
      { avoided: [turn(7, "left", { risk: "left", reason: "No signal, crossing oncoming traffic" })], instead: [] },
    ],
    safer: { steps: safer },
    fastest: { steps: [turn(2, "right"), turn(3, "left", { risk: "left", reason: "No signal, crossing 4 lanes of two-way traffic" })] },
  };
}

test("previewStops: each skipped turn comes just before the turn that replaces it", () => {
  const s = P.previewStops(fakeResult(), "safer");
  assert.deepEqual(s.map((x) => x.kind + ":" + x.text), [
    "turn:right 2",
    "skipped:left 3",   // before the pair's first replacement (step 4, a name change)
    "signal:left 5",
    "turn:right 9",
    "skipped:left 7",   // a skipped turn with no replacement goes at the end
  ]);
  assert.equal(s[1].note, "No signal, crossing 4 lanes of two-way traffic. This route skips it.");
  assert.equal(s[1].tag, "No signal · 4 lanes, two-way");
  assert.equal(s[2].note, "At a traffic signal.");
});

test("previewStops: name changes ('Continue onto ...') are not stops", () => {
  const s = P.previewStops(fakeResult(), "safer");
  assert.ok(!s.some((x) => x.text === "straight 4"));
});

test("previewStops: the fastest view shows its own risky turns, and no skipped ones", () => {
  const s = P.previewStops(fakeResult(), "fastest");
  assert.deepEqual(s.map((x) => x.kind), ["turn", "risk"]);
  assert.match(s[1].note, /Take care/);
});

test("previewStops: nothing to preview for a failed trip", () => {
  assert.deepEqual(P.previewStops({ error: "noroute" }, "safer"), []);
  assert.deepEqual(P.previewStops(null, "safer"), []);
});

test("previewStops on a real plan: every safer-route turn, plus every skipped turn, once", () => {
  const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8")));
  const r = R.plan(g, [43.64595, -79.4263], [43.63515, -79.41705], {});
  const s = P.previewStops(r, "safer");
  const turns = r.safer.steps.filter((t) => t.kind !== "straight" || t.risk).length;
  const skipped = r.pairs.reduce((n, p) => n + p.avoided.length, 0);
  assert.equal(s.length, turns + skipped);
  assert.equal(s.filter((x) => x.kind === "skipped").length, skipped);
  for (const x of s) { assert.equal(x.at.length, 2); assert.ok(Number.isFinite(x.hdg)); }
});

/* ---------- camera ---------- */
test("cameraFor: 3D looks along the road you arrive on; flat stays north-up", () => {
  const st = { at: [43.7, -79.4], hdg: 135 };
  const c3 = P.cameraFor(st, "3d");
  assert.deepEqual(c3.center, [-79.4, 43.7]);
  assert.equal(c3.bearing, 135);
  assert.ok(c3.pitch >= 45 && c3.pitch <= 70);
  const c2 = P.cameraFor(st, "2d");
  assert.equal(c2.pitch, 0);
  assert.equal(c2.bearing, 0);
});

/* ---------- red stretch around a turn ---------- */
test("aroundTurn: about the asked distance either side of the turn, measured along the road", () => {
  // a straight north-south line, one point every ~11 m
  const line = Array.from({ length: 41 }, (_, i) => [43.7 + i * 1e-4, -79.4]);
  const seg = P.aroundTurn(line, line[20], 45);
  const len = (a) => a.slice(1).reduce((s, p, i) => s + R.haversine(a[i], p), 0);
  assert.ok(Math.abs(len(seg) - 90) < 1, `length ${len(seg)}`);
  assert.ok(seg.some((p) => p[0] === line[20][0]));
  // near the start of the line it stops at the first point
  const head = P.aroundTurn(line, line[1], 45);
  assert.deepEqual(head[0], line[0]);
  assert.deepEqual(P.aroundTurn([line[0]], line[0], 45), []);
});

/* ---------- what the map draws ---------- */
test("overlays: markers sit on real points, risky ones carry their label, and skipped turns get a red stretch", () => {
  const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8")));
  const r = R.plan(g, [43.64595, -79.4263], [43.63515, -79.41705], {});
  for (const view of ["safer", "fastest"]) {
    const o = M.overlays(r, view);
    for (const m of o.marks) {
      assert.ok(Array.isArray(m.at) && m.at.length === 2 && m.at.every(Number.isFinite), `${view}: bad marker point ${JSON.stringify(m.at)}`);
    }
    const risky = o.marks.filter((m) => m.cls === "risk");
    assert.ok(risky.length, view);
    for (const m of risky) assert.match(m.tag, /^No signal/);
    assert.equal(o.red.length, risky.length, `${view}: one red stretch per red marker`);
    assert.equal(o.marks.filter((m) => m.cls === "start" || m.cls === "end").length, 2);
  }
  assert.equal(M.overlays(r, "safer").safeView, true);
  assert.equal(M.overlays(r, "fastest").safeView, false);
});

test("overlays: the fastest route is drawn red only when it has risky turns", () => {
  const line = [[43.7, -79.4], [43.701, -79.4]];
  const base = { decision: "already_safe", pairs: [], still_risky: [], safer: { line, risky: [], steps: [] } };
  const safe = M.overlays({ ...base, fastest: { line, risky: [], steps: [] } }, "fastest");
  assert.equal(safe.fastRisky, false);
  const risky = M.overlays({ ...base, decision: "too_far", fastest: { line, risky: [{ at: line[1], tag: "No signal · oncoming traffic" }], steps: [] } }, "fastest");
  assert.equal(risky.fastRisky, true);
});
