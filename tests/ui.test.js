// Unit tests for web/ui.js, the screen logic. Run: node --test "tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const U = require("../web/ui.js");
const R = require("../web/router.js");

const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(__dirname, "sample_roads.json"), "utf8")));
const TRIP = [[43.64595, -79.4263], [43.63515, -79.41705]]; // has a risky left the safer route skips
const BOX = [43.581, -79.639, 43.856, -79.115];

/* ---------- small helpers ---------- */
test("esc escapes every HTML-special character", () => {
  assert.equal(U.esc(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(U.esc(7), "7");
});

test("fmtMin rounds to whole minutes and shows <1 min under a minute", () => {
  assert.equal(U.fmtMin(0.4), "<1 min");
  assert.equal(U.fmtMin(1.4), "1 min");
  assert.equal(U.fmtMin(12.6), "13 min");
});

test("plural picks the singular only for exactly one", () => {
  assert.equal(U.plural(1, "turn", "turns"), "1 turn");
  assert.equal(U.plural(0, "turn", "turns"), "0 turns");
  assert.equal(U.plural(3, "turn", "turns"), "3 turns");
});

/* ---------- address search ---------- */
test("parseLatLon reads lat,lon with or without spaces and minus signs", () => {
  assert.deepEqual(U.parseLatLon("43.6629,-79.3957"), [43.6629, -79.3957]);
  assert.deepEqual(U.parseLatLon("  43.6629 , -79.3957 "), [43.6629, -79.3957]);
  assert.deepEqual(U.parseLatLon("43,-79"), [43, -79]);
});

test("parseLatLon rejects addresses and impossible coordinates", () => {
  assert.equal(U.parseLatLon("35 Brian Peck Crescent"), null);
  assert.equal(U.parseLatLon("43.6"), null);
  assert.equal(U.parseLatLon("95,-79"), null);
  assert.equal(U.parseLatLon("43,-200"), null);
  assert.equal(U.parseLatLon(""), null);
});

test("inBox includes the edges and excludes points outside", () => {
  assert.ok(U.inBox(BOX, [43.7, -79.4]));
  assert.ok(U.inBox(BOX, [43.581, -79.639]));
  assert.ok(!U.inBox(BOX, [43.9, -79.4]));
  assert.ok(!U.inBox(BOX, [43.7, -79.0]));
});

test("search URLs encode the query and use west,south,east,north boxes", () => {
  const p = U.photonUrl("Bloor & Yonge", BOX);
  assert.ok(p.startsWith("https://photon.komoot.io/api/?q=Bloor%20%26%20Yonge&"));
  assert.ok(p.endsWith("&bbox=-79.639,43.581,-79.115,43.856"));
  const ga = U.geoapifyUrl("Bloor", BOX, "k&y");
  assert.ok(ga.includes("filter=rect:-79.639,43.581,-79.115,43.856"));
  assert.ok(ga.endsWith("apiKey=k%26y"));
});

test("photonResults: place names, street addresses and lat/lon order", () => {
  const out = U.photonResults({ features: [
    { properties: { name: "Eaton Centre", housenumber: "220", street: "Yonge St", city: "Toronto" }, geometry: { coordinates: [-79.38, 43.65] } },
    { properties: { housenumber: "35", street: "Brian Peck Crescent", district: "East York" }, geometry: { coordinates: [-79.35, 43.71] } },
    { properties: {}, geometry: { coordinates: [-79.4, 43.7] } },
    { properties: { name: "no geometry" } },
  ] });
  assert.deepEqual(out, [
    { label: "Eaton Centre", sub: "220 Yonge St, Toronto", pt: [43.65, -79.38] },
    { label: "35 Brian Peck Crescent", sub: "East York", pt: [43.71, -79.35] },
    { label: "Unnamed place", sub: "", pt: [43.7, -79.4] },
  ]);
  assert.deepEqual(U.photonResults({}), []);
  assert.deepEqual(U.photonResults(null), []);
});

test("geoapifyResults: address lines and fallbacks", () => {
  assert.deepEqual(U.geoapifyResults({ features: [
    { properties: { address_line1: "35 Brian Peck Cres", address_line2: "Toronto, ON", lat: 43.71, lon: -79.35 } },
    { properties: { formatted: "Somewhere", lat: 1, lon: 2 } },
  ] }), [
    { label: "35 Brian Peck Cres", sub: "Toronto, ON", pt: [43.71, -79.35] },
    { label: "Somewhere", sub: "", pt: [1, 2] },
  ]);
  assert.deepEqual(U.geoapifyResults(undefined), []);
});

/* ---------- recent destinations ---------- */
test("addRecent puts the newest first, drops duplicates and keeps five", () => {
  let list = [];
  for (const n of ["a", "b", "c", "d", "e", "f"]) list = U.addRecent(list, { label: n, pt: [0, 0] });
  assert.deepEqual(list.map((x) => x.label), ["f", "e", "d", "c", "b"]);
  list = U.addRecent(list, { label: "c", pt: [1, 1], sub: "again" });
  assert.deepEqual(list.map((x) => x.label), ["c", "f", "e", "d", "b"]);
  assert.equal(list[0].sub, "again");
  assert.deepEqual(U.addRecent("not a list", { label: "x", pt: [0, 0] }), [{ label: "x", sub: "", pt: [0, 0] }]);
});

/* ---------- verdict ---------- */
test("verdict for a safer route says the extra time and how many lefts it skips", () => {
  const r = R.plan(g, TRIP[0], TRIP[1], {});
  const v = U.verdict(r, false);
  assert.equal(v.eyebrow, "Safer route found");
  assert.match(v.bigHtml, /to skip 1 risky left$/);
  assert.equal(v.goText, "Open in Google Maps");
  assert.match(v.fine, /Google Maps will announce 1 stop\./);
  assert.ok(v.barSafe <= 100 && v.barFast <= 100 && Math.max(v.barSafe, v.barFast) === 100);
});

const fake = (over) => ({
  decision: "safer", chosen: "safer", extra_min: 3.2, pins: [[1, 2], [3, 4]], limits: { max_detour_min: 7 },
  fastest: { minutes: 10, risky: [{}, {}], steps: [] }, safer: { minutes: 13.2, risky: [], steps: [] },
  pairs: [{ avoided: [{}, {}], instead: [] }], still_risky: [], ...over,
});

test("verdict: +minutes and seconds per risky turn when the detour costs time", () => {
  const v = U.verdict(fake({}), false);
  assert.match(v.bigHtml, /\+3 min<\/span> to skip 2 risky lefts/);
  assert.match(v.subHtml, /saves 3 min/);
  assert.match(v.subHtml, /about <b>96 seconds per risky turn/);
  assert.match(v.fine, /2 stops/);
});

test("verdict says 'risky turns' when rights are avoided too", () => {
  assert.match(U.verdict(fake({}), true).bigHtml, /2 risky turns/);
});

test("verdict for 'too far' shows the fastest route and the limit", () => {
  const v = U.verdict(fake({ decision: "too_far", chosen: "fastest" }), false);
  assert.equal(v.eyebrow, "Fastest route");
  assert.equal(v.bigHtml, "10 min, with 2 risky lefts");
  assert.match(v.fallbackHtml, /No safer route within 7 min/);
  assert.equal(v.goText, "Open fastest route in Google Maps");
  assert.equal(v.fine, "Opens the route in Google Maps with no stops added.");
});

test("verdict for 'already safe' matches the risk setting", () => {
  assert.equal(U.verdict(fake({ decision: "already_safe", chosen: "fastest" }), false).bigHtml, "The fastest route has no risky lefts");
  const v = U.verdict(fake({ decision: "already_safe", chosen: "fastest" }), true);
  assert.equal(v.bigHtml, "The fastest route has no risky turns");
  assert.match(v.subHtml, /across or into busy traffic/);
});

test("verdict for 'no better' lists the turns to watch", () => {
  const v = U.verdict(fake({ decision: "no_better", chosen: "fastest" }), false);
  assert.match(v.subHtml, /No route found that makes fewer risky turns/);
  assert.equal(v.fallbackHtml, null);
});

test("verdict for an error explains it and offers no link", () => {
  for (const [err, re] of [["outside", /off the road map/], ["same", /same spot/], ["noroute", /No driving route/], ["crash", /went wrong/], ["new", /^No route\.$/]]) {
    const v = U.verdict({ error: err, message: err === "crash" ? "<b>boom</b>" : undefined }, false);
    assert.equal(v.error, true);
    assert.match(v.bigHtml, re);
    assert.equal(v.goText, "No route to open");
    assert.equal(v.barSafe, 0);
  }
  assert.equal(U.verdict({ error: "crash", message: "<b>boom</b>" }).subHtml, "&lt;b&gt;boom&lt;/b&gt;");
});

/* ---------- turn lists ---------- */
test("turnList on the safer view pairs each skipped turn with what replaces it", () => {
  const r = R.plan(g, TRIP[0], TRIP[1], {});
  const t = U.turnList(r, "safer");
  assert.equal(t.heading, "Turns this route skips");
  assert.match(t.html, /data-pair="0"/);
  assert.match(t.html, /Fastest route would/);
  assert.match(t.html, /Locked in the Google Maps link/);
  assert.deepEqual(t.legend, { still: false, signal: true, riskLabel: "Risky turn skipped" });
  assert.equal(t.stepsSummary, `All ${r.safer.steps.length} turns on the safer route`);
  assert.equal((t.stepsHtml.match(/<li>/g) || []).length, r.safer.steps.length);
});

test("turnList on the fastest view lists its risky turns", () => {
  const r = R.plan(g, TRIP[0], TRIP[1], {});
  const t = U.turnList(r, "fastest");
  assert.equal(t.heading, "Risky turns on the fastest route");
  assert.match(t.html, /data-risk="0"/);
  assert.match(t.stepsHtml, /chip risk/);
  assert.equal(t.legend.signal, false);
  assert.equal(t.stillHtml, "");
});

test("turnList: unpaired turns, unlocked pairs, leftover risks and step chips", () => {
  const turn = (text, extra) => ({ text, at: [1, 2], ...extra });
  const r = fake({
    pairs: [{ avoided: [turn("Left onto A", { detail: "No signal." })], instead: [], locked: false }],
    still_risky: [turn("Left onto B")],
    safer: { minutes: 13, risky: [turn("Left onto B")], steps: [turn("s1", { signal: true }), turn("s2", { junction: true }), turn("s3")] },
  });
  const t = U.turnList(r, "safer");
  assert.match(t.html, /A different street with no risky turn/);
  assert.match(t.html, /Likely, not locked/);
  assert.match(t.html, /class="detail">No signal\./);
  assert.match(t.stillHtml, /Still on this route/);
  assert.equal(t.legend.still, true);
  assert.match(t.stepsHtml, /chip sig/);
  assert.match(t.stepsHtml, /chip loc/);
  assert.match(t.stepsHtml, /<span><\/span><\/li>$/);
});

test("turnList when the route on show has no risky turns", () => {
  const r = fake({ decision: "already_safe", fastest: { minutes: 10, risky: [], steps: [] } });
  assert.equal(U.turnList(r, "fastest").heading, "No risky turns on this route");
  assert.equal(U.turnList(fake({ decision: "no_better", safer: { minutes: 1, risky: [{ text: "x" }], steps: [] } }), "safer").heading, "Turns to watch");
});

test("turnRow escapes turn text", () => {
  assert.match(U.turnRow("a", "!", "Tag", [{ text: "<script>" }]), /&lt;script&gt;/);
});

test("focusPoints: a pair zooms to its skipped turns and signals; a risk card to its turn", () => {
  const r = fake({
    pairs: [{ avoided: [{ at: [1, 1] }], instead: [{ at: [2, 2], signal: true }, { at: [3, 3] }] }],
    fastest: { minutes: 10, risky: [{ at: [4, 4] }], steps: [] },
  });
  assert.deepEqual(U.focusPoints(r, "safer", { pair: "0" }), [[1, 1], [2, 2]]);
  assert.deepEqual(U.focusPoints(r, "fastest", { risk: "0" }), [[4, 4]]);
  assert.deepEqual(U.focusPoints(r, "safer", { pair: "9" }), []);
  assert.deepEqual(U.focusPoints(r, "fastest", { risk: "9" }), []);
  assert.deepEqual(U.focusPoints(r, "safer", {}), []);
});
