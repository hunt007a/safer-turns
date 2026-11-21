// Times the router on the real Toronto road file. Usage: node tests/bench_router.js [roads.json] [trips]
// Prints load time, per-trip planning time, and a checksum of the results so two versions can be compared.
const fs = require("fs"), path = require("path");
const R = require("../web/router.js");
const file = process.argv[2] || path.join(__dirname, "..", "web", "roads", "toronto.json");
const n = +(process.argv[3] || 20);
let t0 = performance.now();
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const tParse = performance.now() - t0;
t0 = performance.now();
const g = R.loadGraph(data);
const tLoad = performance.now() - t0;
// fixed pseudo-random trips inside the data's box, so runs are repeatable
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const [s, w, nn, e] = data.bbox;
const trips = Array.from({ length: n }, () => [[s + rnd() * (nn - s), w + rnd() * (e - w)], [s + rnd() * (nn - s), w + rnd() * (e - w)]]);
const times = [];
const sums = [];
for (const [a, b] of trips) {
  const t = performance.now();
  const r = R.plan(g, a, b, {});
  times.push(performance.now() - t);
  sums.push(r.error ? r.error : `${r.decision}:${r.fastest.minutes.toFixed(3)}:${r.safer.minutes.toFixed(3)}:${r.fastest.risky.length}:${r.safer.risky.length}:${r.pins.length}`);
}
times.sort((x, y) => x - y);
const avg = times.reduce((x, y) => x + y, 0) / times.length;
console.log(`parse ${tParse.toFixed(0)} ms, loadGraph ${tLoad.toFixed(0)} ms`);
console.log(`plan x${n}: avg ${avg.toFixed(0)} ms, median ${times[n >> 1].toFixed(0)} ms, max ${times[n - 1].toFixed(0)} ms`);
if (process.env.SUMS) fs.writeFileSync(process.env.SUMS, sums.join("\n") + "\n");
