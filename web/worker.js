/* Loads the road file once and answers route requests off the main thread. */
importScripts("router.js");
let graph = null;
const ROADS = new URLSearchParams(self.location.search).get("roads") || "roads/toronto.json";
const ready = fetch(ROADS)
  .then((r) => { if (!r.ok) throw new Error("Road file missing (" + r.status + "). Run the road builder first."); return r.json(); })
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
