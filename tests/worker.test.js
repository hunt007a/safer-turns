// Unit tests for web/worker.js: runs it in a sandbox with a fake fetch and postMessage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm"), zlib = require("zlib");

const WEB = path.join(__dirname, "..", "web");
const SAMPLE = fs.readFileSync(path.join(__dirname, "sample_roads.json"));
const TRIP = [[43.64595, -79.4263], [43.63515, -79.41705]];

// files: url -> Buffer, or a status number to answer with
function startWorker(files, { roads, noDecompress } = {}) {
  const posted = [], fetched = [];
  const ctx = {
    location: { search: roads ? "?roads=" + encodeURIComponent(roads) : "" },
    URLSearchParams, TextDecoder, Response, Blob, Uint8Array, JSON, Math, Promise, Error, String, performance,
    DecompressionStream: noDecompress ? undefined : DecompressionStream,
    postMessage: (m) => posted.push(m),
    fetch: async (url) => {
      fetched.push(url);
      const f = files[url];
      if (f === undefined) return new Response(null, { status: 404 });
      if (typeof f === "number") return new Response(null, { status: f });
      if (f instanceof Error) throw f;
      return new Response(f);
    },
  };
  ctx.self = ctx; // a worker's global object is "self"
  ctx.importScripts = (u) => vm.runInContext(fs.readFileSync(path.join(WEB, u.split("?")[0]), "utf8"), ctx, { filename: path.join(WEB, u.split("?")[0]) });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, "worker.js"), "utf8"), ctx, { filename: path.join(WEB, "worker.js") });
  const until = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { ctx, posted, fetched, until };
}

test("loads the gzipped road file first and says ready", async () => {
  const w = startWorker({ "roads/toronto.json.gz": zlib.gzipSync(SAMPLE) });
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "ready");
  assert.equal(w.posted[0].stats.nodes, 169);
  assert.deepEqual(w.fetched, ["roads/toronto.json.gz"]);
});

test("accepts a .gz the server already unzipped", async () => {
  const w = startWorker({ "roads/toronto.json.gz": SAMPLE });
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "ready");
});

test("falls back to the plain file when there is no gzipped copy", async () => {
  const w = startWorker({ "roads/toronto.json": SAMPLE });
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "ready");
  assert.deepEqual(w.fetched, ["roads/toronto.json.gz", "roads/toronto.json"]);
});

test("falls back to the plain file when the gzipped copy is corrupt or the fetch fails", async () => {
  for (const bad of [Buffer.from([0x1f, 0x8b, 1, 2, 3]), new Error("network")]) {
    const w = startWorker({ "roads/toronto.json.gz": bad, "roads/toronto.json": SAMPLE });
    await w.until(() => w.posted.length);
    assert.equal(w.posted[0].type, "ready");
  }
});

test("browsers without DecompressionStream load the plain file directly", async () => {
  const w = startWorker({ "roads/toronto.json": SAMPLE }, { noDecompress: true });
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "ready");
  assert.deepEqual(w.fetched, ["roads/toronto.json"]);
});

test("a roads URL ending in .gz is fetched as given", async () => {
  const w = startWorker({ "roads/x.json.gz": zlib.gzipSync(SAMPLE) }, { roads: "roads/x.json.gz" });
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "ready");
  assert.deepEqual(w.fetched, ["roads/x.json.gz"]);
});

test("a missing road file is reported as an error", async () => {
  const w = startWorker({});
  await w.until(() => w.posted.length);
  assert.equal(w.posted[0].type, "error");
  assert.match(w.posted[0].message, /Road file missing \(404\)/);
});

test("answers a plan request with the same id and a timing", async () => {
  const w = startWorker({ "roads/toronto.json.gz": zlib.gzipSync(SAMPLE) });
  w.ctx.onmessage({ data: { type: "plan", id: 7, from: TRIP[0], to: TRIP[1], opts: {} } });
  await w.until(() => w.posted.some((m) => m.type === "plan"));
  const m = w.posted.find((x) => x.type === "plan");
  assert.equal(m.id, 7);
  assert.equal(m.result.decision, "safer");
  assert.ok(m.result.ms >= 0);
});

test("ignores other messages, and plan requests when the road file failed", async () => {
  const w = startWorker({});
  w.ctx.onmessage({ data: { type: "hello" } });
  w.ctx.onmessage({ data: { type: "plan", id: 1, from: TRIP[0], to: TRIP[1], opts: {} } });
  await w.until(() => w.posted.length);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(w.posted.map((m) => m.type), ["error"]);
});

test("a router crash comes back as an error result, not a dead worker", async () => {
  const w = startWorker({ "roads/toronto.json.gz": zlib.gzipSync(SAMPLE) });
  await w.until(() => w.posted.length);
  w.ctx.SaferRouter.plan = () => { throw new Error("boom"); };
  w.ctx.onmessage({ data: { type: "plan", id: 2, from: TRIP[0], to: TRIP[1], opts: {} } });
  await w.until(() => w.posted.some((m) => m.type === "plan"));
  const m = w.posted.find((x) => x.type === "plan");
  assert.equal(m.result.error, "crash");
  assert.match(m.result.message, /boom/);
});
