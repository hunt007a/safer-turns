// Compare the JS router with the Python prototype on the sample grid, and check the pairing.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const R = require("../web/router.js");
const dir = __dirname;
const g = R.loadGraph(JSON.parse(fs.readFileSync(path.join(dir, "sample_roads.json"))));
const trips = [
  [[43.64865, -79.42815], [43.63785, -79.40965]],
  [[43.65000, -79.43000], [43.63380, -79.40780]],
  [[43.63650, -79.42815], [43.64730, -79.41150]],
  [[43.64730, -79.40965], [43.63785, -79.42630]],
  [[43.64325, -79.41890], [43.64865, -79.41335]],
  [[43.64595, -79.42630], [43.63515, -79.41705]],
  [[43.64190, -79.42815], [43.64190, -79.40780]],
];
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } };
for (const [a, b] of trips) {
  const py = JSON.parse(execFileSync("python3", [path.join(dir, "..", "safer_route.py"), "--osm-file", path.join(dir, "sample_osm.json"),
    "--from", a.join(","), "--to", b.join(","), "--json"]).toString());
  const js = R.plan(g, a, b, { right_busy: 25 });
  const tag = `${a} -> ${b}`;
  ok(Math.abs(js.fastest.minutes - py.fastest.minutes) < 0.06, `${tag} fastest min js ${js.fastest.minutes.toFixed(2)} py ${py.fastest.minutes}`);
  ok(Math.abs(js.safer.minutes - py.safer.minutes) < 0.06, `${tag} safer min js ${js.safer.minutes.toFixed(2)} py ${py.safer.minutes}`);
  // risky counts can differ only when several routes tie on time (grid streets); report, don't fail
  if (js.fastest.risky.length !== py.fastest.risky_turns.length) console.log(`   note: tie-break picked a different equal-time fastest route (${js.fastest.risky.length} vs ${py.fastest.risky_turns.length} risky)`);
  ok(js.safer.risky.length <= py.safer.risky_turns.length, `${tag} safer risky js ${js.safer.risky.length} py ${py.safer.risky_turns.length}`);
  const app = R.plan(g, a, b, {});
  const paired = app.pairs.reduce((n, p) => n + p.avoided.length, 0);
  if (app.decision === "safer") {
    ok(paired === app.fastest.risky.length, `${tag} every risky turn paired (${paired}/${app.fastest.risky.length})`);
    ok(app.pins.length <= 3, `${tag} at most 3 pins`);
  }
  console.log(`${tag}: py fast ${py.fastest.minutes}m/${py.fastest.risky_turns.length} safe ${py.safer.minutes}m/${py.safer.risky_turns.length} | app ${app.decision} +${app.extra_min.toFixed(1)}m, ${app.pairs.length} pairs, ${app.pins.length} pins`);
  for (const p of app.pairs) console.log("   avoid:", p.avoided.map(t => t.text).join("; "), "| instead:", p.instead.map(t => t.text + (t.signal ? " [signal]" : "")).join("; "), p.locked ? "(locked)" : "");
}
// far-detour fallback
const fb = R.plan(g, trips[3][0], trips[3][1], { max_detour_min: 0.05 });
ok(fb.decision === "too_far" && !fb.google_url.includes("waypoints"), "fallback when detour limit is tiny");
console.log(fails ? `${fails} check(s) failed` : "all router checks passed");
process.exit(fails ? 1 : 0);
