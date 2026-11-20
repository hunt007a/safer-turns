// Headless browser test of the app on the sample grid. Usage: node tests/test_ui.js [port]
const { chromium } = require("playwright");
const path = require("path"), http = require("http"), fs = require("fs");
const root = path.join(__dirname, "..", "web");
const shots = process.env.SHOTS || path.join(__dirname, "shots");
fs.mkdirSync(shots, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((q, s) => {
  let f = path.join(root, decodeURIComponent(q.url.split("?")[0]));
  if (f.endsWith("/")) f += "index.html";
  fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); s.end(b); } });
}).listen(0);
const port = srv.address().port;
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  for (const scheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    const pg = await ctx.newPage();
    const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (m) => m.type() === "error" && !/tile|fonts|Failed to load resource/.test(m.text()) && errs.push(m.text()));
    await pg.route(/fonts\.(googleapis|gstatic)|tile\.openstreetmap/, (r) => r.abort());
    // fake address search so the test needs no network
    await pg.route(/photon\.komoot\.io/, (r) => {
      const q = new URL(r.request().url()).searchParams.get("q");
      const pts = { "Hallam": [43.64595, -79.4263], "Bartlett": [43.63515, -79.41705] };
      const k = Object.keys(pts).find((k) => q.includes(k));
      r.fulfill({ contentType: "application/json", body: JSON.stringify({ features: k ? [{ properties: { name: k + " test point", city: "Toronto" }, geometry: { coordinates: [pts[k][1], pts[k][0]] } }] : [] }) });
    });
    await pg.addInitScript(() => { window.SAFER_TURNS_TEST = true; });
    await pg.goto(`http://localhost:${port}/index.html`);
    await pg.evaluate(() => {});
    // point the app at the sample road file
    await pg.route(/roads\/toronto\.json/, (r) => r.fulfill({ path: path.join(root, "roads", "sample.json") }));
    await pg.reload();
    await pg.waitForFunction(() => !document.getElementById("goBtn").textContent.includes("Loading"), null, { timeout: 15000 });
    ok(true, `[${scheme}] road file loaded`);
    await pg.fill("#fromInput", "Hallam"); await pg.waitForSelector("#fromList li"); await pg.click("#fromList li");
    await pg.fill("#toInput", "Bartlett"); await pg.waitForSelector("#toList li"); await pg.click("#toList li");
    if (scheme === "light") await pg.screenshot({ path: path.join(shots, "1-plan.png") });
    await pg.click("#goBtn");
    await pg.waitForFunction(() => document.getElementById("big").textContent.length > 0, null, { timeout: 15000 });
    const big = await pg.textContent("#big");
    ok(/skip/.test(big), `[${scheme}] verdict: "${big}"`);
    const pairs = await pg.$$eval("#pairs .pair", (x) => x.length);
    ok(pairs >= 1, `[${scheme}] ${pairs} turn pair card(s)`);
    const href = await pg.getAttribute("#go", "href");
    ok(href.startsWith("https://www.google.com/maps/dir/?api=1") && href.includes("waypoints="), `[${scheme}] Google Maps link has waypoints`);
    await pg.screenshot({ path: path.join(shots, `2-results-${scheme}.png`), fullPage: true });
    if (scheme === "light") {
      await pg.click("#pairs .pair");
      await pg.click(".seg button[data-r=fastest]");
      ok(/fastest/i.test(await pg.textContent("#listH")), "fastest view lists its risky turns");
      await pg.screenshot({ path: path.join(shots, "3-fastest.png"), fullPage: true });
      await pg.selectOption("#limit", "5");
      await pg.click(".seg button[data-r=safer]");
      await pg.click("#results [data-open=about]"); ok(await pg.isVisible("#about"), "how-it-works sheet opens");
      await pg.screenshot({ path: path.join(shots, "4-about.png") });
      await pg.click("[data-close]");
      // horizontal overflow check
      const ov = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      ok(!ov, "no sideways scroll at phone width");
      // fallback: limit tiny via direct option change
      await pg.evaluate(() => { const s = document.getElementById("limit"); s.innerHTML += '<option value="0.05">t</option>'; s.value = "0.05"; s.dispatchEvent(new Event("change")); });
      await pg.waitForFunction(() => !document.getElementById("fallback").hidden, null, { timeout: 10000 });
      ok(!(await pg.getAttribute("#go", "href")).includes("waypoints"), "fallback opens fastest route with no stops");
      await pg.screenshot({ path: path.join(shots, "5-fallback.png"), fullPage: true });
    }
    ok(errs.length === 0, `[${scheme}] no page errors ${errs.join(" | ")}`);
    await ctx.close();
  }
  await b.close(); srv.close();
  console.log(fails ? `${fails} check(s) failed` : "all UI checks passed");
  process.exit(fails ? 1 : 0);
})();
