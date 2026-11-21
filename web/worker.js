/* Loads the road file once and answers route requests off the main thread. */
importScripts("router.js?v=3");
let graph = null;
const ROADS = new URLSearchParams(self.location.search).get("roads") || "roads/toronto.json";

// The builder also writes a gzipped copy, about a quarter of the size. Fetch that first
// and unzip it here; fall back to the plain file if it is missing or the browser
// cannot unzip. The gzip check looks at the bytes, because some servers unzip the
// file on the way and others hand it over as is.
async function fetchRoads(url) {
  if (typeof DecompressionStream !== "undefined" && !url.endsWith(".gz")) {
    try {
      const r = await fetch(url + ".gz");
      if (r.ok) return await parseRoads(await r.arrayBuffer());
    } catch (e) { /* fall through to the plain file */ }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error("Road file missing (" + r.status + "). Run the road builder first.");
  return parseRoads(await r.arrayBuffer());
}
async function parseRoads(buf) {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(text);
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

const ready = fetchRoads(ROADS)
  .then((data) => {
    graph = SaferRouter.loadGraph(data);
    postMessage({ type: "ready", area: data.area, built: data.built, bbox: data.bbox, stats: data.stats, attribution: data.attribution });
  })
  .catch((e) => postMessage({ type: "error", message: e.message }));

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type !== "plan") return;
  await ready;
  if (!graph) return;
  const t0 = performance.now();
  let res;
  try { res = SaferRouter.plan(graph, m.from, m.to, m.opts); }
  catch (e) { res = { error: "crash", message: String(e) }; }
  res.ms = Math.round(performance.now() - t0);
  postMessage({ type: "plan", id: m.id, result: res });
};
