/* Safer Turns router: a JavaScript port of the prototype's turn-penalty routing
 * (safer_route.py), plus the turn pairing the results screen needs.
 * Runs in a Web Worker in the app, and under Node for tests.
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    left_busy: 120,   // s added to an unsignalized left across a busy road
    left_local: 10,   // s for an unsignalized left where every road is local
    right_busy: 0,    // s for an unsignalized right onto a busier road (0 = allowed; 120 when "avoid rights" is on)
    uturn: 300,
    max_detour_min: 7,
    max_detour_pct: 30,
    max_waypoints: 3,
    max_snap_m: 1000, // a start or end further than this from any road is off the map
  };
  const RIGHT_AVOID = 120;
  const ROAD_WORD = { 6: "a highway", 5: "an expressway", 4: "a major road", 3: "a major road", 2: "a busy road" };

  const toRad = (d) => (d * Math.PI) / 180;
  function haversine(a, b) {
    const [la1, lo1] = a.map(toRad), [la2, lo2] = b.map(toRad);
    const d = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(d));
  }
  function bearing(a, b) {
    const [la1, lo1] = a.map(toRad), [la2, lo2] = b.map(toRad);
    const y = Math.sin(lo2 - lo1) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  /* ---------- graph from the road file ---------- */
  function loadGraph(data) {
    const nN = data.flags.length;
    const lat = new Float64Array(nN), lon = new Float64Array(nN);
    for (let i = 0; i < nN; i++) { lat[i] = data.nodes[2 * i] / 1e5; lon[i] = data.nodes[2 * i + 1] / 1e5; }
    const E = data.edges, nE = E.length / 9;
    // directed edges: forward always, reverse when two-way
    const G = data.geom;
    const dir = [];
    let vmax = 1; // fastest speed on any edge, m/s: bounds the A* estimate
    const pt = (n) => [lat[n], lon[n]];
    const gp = (k) => [G[2 * k] / 1e5, G[2 * k + 1] / 1e5];
    for (let i = 0; i < nE; i++) {
      const o = i * 9;
      const a = E[o], b = E[o + 1], time = E[o + 2] / 10, len = E[o + 3], gs = E[o + 7], gc = E[o + 8];
      if (time > 0 && len / time > vmax) vmax = len / time;
      // first and last legs of the edge's geometry, in the forward direction
      const first = gc ? gp(gs) : pt(b), last = gc ? gp(gs + gc - 1) : pt(a);
      const common = { time, len, rank: E[o + 4], two_way: !!E[o + 5], name: E[o + 6], gs, gc };
      dir.push(Object.assign({ a, b, rev: false, b0: bearing(pt(a), first), b1: bearing(last, pt(b)) }, common));
      if (common.two_way) dir.push(Object.assign({ a: b, b: a, rev: true, b0: bearing(pt(b), last), b1: bearing(first, pt(a)) }, common));
    }
    const out = Array.from({ length: nN }, () => []);
    dir.forEach((e, k) => out[e.a].push(k));
    return { data, lat, lon, flags: data.flags, roads: data.roads, names: data.names, dir, out, vmax };
  }

  function edgePoints(g, e) {
    const mid = [];
    const G = g.data.geom;
    for (let k = 0; k < e.gc; k++) mid.push([G[2 * (e.gs + k)] / 1e5, G[2 * (e.gs + k) + 1] / 1e5]);
    if (e.rev) mid.reverse();
    return [[g.lat[e.a], g.lon[e.a]], ...mid, [g.lat[e.b], g.lon[e.b]]];
  }

  function nearest(g, pt) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.flags.length; i++) {
      if (!g.out[i].length) continue;
      const d = (g.lat[i] - pt[0]) ** 2 + ((g.lon[i] - pt[1]) * 0.72) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* ---------- turns ---------- */
  function turnKind(eIn, eOut) {
    const d = ((eOut.b0 - eIn.b1 + 540) % 360) - 180; // + = right
    if (Math.abs(d) < 35) return "straight";
    if (Math.abs(d) > 160) return "uturn";
    return d > 0 ? "right" : "left";
  }

  // Mirrors safer_route.turn_penalty. Returns {pen, kind, reason}.
  function turnInfo(g, eIn, eOut, p) {
    const n = eIn.b;
    const kind = turnKind(eIn, eOut);
    const signal = !!(g.flags[n] & 1), junction = !!(g.flags[n] & 2);
    const res = { kind, signal, junction, pen: 0, risk: null, node: n, busyRank: 0 };
    if (signal || !junction) return res;
    const roads = g.roads[n] || [];
    let other = roads.filter((r) => r[2] !== eIn.name);
    if (!other.length) other = roads;
    const busyRank = Math.max(eOut.rank, ...other.map((r) => r[0]));
    res.busyRank = busyRank;
    const busy = busyRank >= 2;
    if (kind === "left") {
      const crosses = eIn.two_way || eOut.two_way || other.some((r) => r[1]);
      if (!crosses) return res;
      if (busy || eIn.rank >= 2) { res.pen = p.left_busy; res.risk = "left"; }
      else res.pen = p.left_local;
    } else if (kind === "right" && busy && eOut.rank >= 2 && eIn.rank < eOut.rank) {
      res.pen = p.right_busy;
      res.risk = "right";
    }
    return res;
  }

  // Same result as turnInfo(...).pen, without building objects or arrays. The search
  // calls this for every pair of edges it looks at, so it has to stay cheap.
  function turnPen(g, eIn, eOut, p) {
    const n = eIn.b, f = g.flags[n];
    if (f & 1 || !(f & 2)) return 0;
    const kind = turnKind(eIn, eOut);
    if (kind !== "left" && kind !== "right") return 0;
    const roads = g.roads[n] || [];
    let busyRank = eOut.rank, otherTwoWay = false, nOther = 0;
    for (const r of roads) if (r[2] !== eIn.name) { nOther++; if (r[0] > busyRank) busyRank = r[0]; if (r[1]) otherTwoWay = true; }
    if (!nOther) for (const r of roads) { if (r[0] > busyRank) busyRank = r[0]; if (r[1]) otherTwoWay = true; }
    const busy = busyRank >= 2;
    if (kind === "left") {
      if (!(eIn.two_way || eOut.two_way || otherTwoWay)) return 0;
      return busy || eIn.rank >= 2 ? p.left_busy : p.left_local;
    }
    return busy && eOut.rank >= 2 && eIn.rank < eOut.rank ? p.right_busy : 0;
  }

  /* ---------- edge-based A* ---------- */
  // Binary min-heap on typed arrays, so pushing allocates nothing. pop() returns the
  // value and leaves its key in this.key.
  class Heap {
    constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.size = 0; this.key = 0; }
    push(c, v) {
      if (this.size === this.k.length) {
        const k = new Float64Array(this.size * 2), w = new Int32Array(this.size * 2);
        k.set(this.k); w.set(this.v); this.k = k; this.v = w;
      }
      const K = this.k, V = this.v;
      let i = this.size++;
      while (i) { const j = (i - 1) >> 1; if (K[j] <= c) break; K[i] = K[j]; V[i] = V[j]; i = j; }
      K[i] = c; V[i] = v;
    }
    pop() {
      const K = this.k, V = this.v, top = V[0];
      this.key = K[0];
      const n = --this.size, c = K[n], v = V[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const m = l + 1 < n && K[l + 1] < K[l] ? l + 1 : l;
        if (K[m] >= c) break;
        K[i] = K[m]; V[i] = V[m]; i = m;
      }
      if (n) { K[i] = c; V[i] = v; }
      return top;
    }
  }

  // A* over directed edges: the state is an edge, so a turn between two edges can
  // carry a cost. The estimate is straight-line distance at the road file's top speed,
  // cut by 2% so rounding in the file can never make it overestimate.
  function search(g, src, dst, p, safe) {
    const nD = g.dir.length;
    const best = new Float64Array(nD).fill(Infinity);
    const par = new Int32Array(nD).fill(-1);
    const h = new Heap();
    const dLat = g.lat[dst], dLon = g.lon[dst];
    const kx = 111195 * Math.cos(toRad(dLat)), ky = 111195, inv = 0.98 / g.vmax;
    const est = (n) => { const x = (g.lon[n] - dLon) * kx, y = (g.lat[n] - dLat) * ky; return Math.sqrt(x * x + y * y) * inv; };
    for (const k of g.out[src]) { const e = g.dir[k]; if (e.time < best[k]) { best[k] = e.time; h.push(e.time + est(e.b), k); } }
    let goal = -1;
    while (h.size) {
      const k = h.pop();
      const eIn = g.dir[k], c = best[k];
      if (h.key > c + est(eIn.b) + 1e-6) continue; // stale entry: a cheaper way in was found
      if (eIn.b === dst) { goal = k; break; }
      const outs = g.out[eIn.b];
      for (let j = 0; j < outs.length; j++) {
        const k2 = outs[j], eOut = g.dir[k2];
        let pen = 0;
        if (eOut.b === eIn.a && outs.length > 1) pen = p.uturn;
        else if (safe) pen = turnPen(g, eIn, eOut, p);
        const nc = c + eOut.time + pen;
        if (nc < best[k2]) { best[k2] = nc; par[k2] = k; h.push(nc + est(eOut.b), k2); }
      }
    }
    if (goal < 0) return null;
    const path = [];
    for (let k = goal; k >= 0; k = par[k]) path.push(k);
    return path.reverse();
  }

  /* ---------- describe a route ---------- */
  function describe(g, edges, p, riskP) {
    let time = 0, len = 0;
    const turns = [];
    edges.forEach((k) => { time += g.dir[k].time; len += g.dir[k].len; });
    for (let i = 1; i < edges.length; i++) {
      const eIn = g.dir[edges[i - 1]], eOut = g.dir[edges[i]];
      const t = turnInfo(g, eIn, eOut, riskP);
      t.i = i;
      t.from = g.names[eIn.name];
      t.to = g.names[eOut.name];
      t.at = [g.lat[t.node], g.lon[t.node]];
      t.toRank = eOut.rank;
      t.fromRank = eIn.rank;
      t.maneuver = t.kind !== "straight" || eIn.name !== eOut.name;
      t.risky = !!t.risk && (t.risk === "left" || p.right_busy > 0);
      turns.push(t);
    }
    const nodes = [g.dir[edges[0]].a, ...edges.map((k) => g.dir[k].b)];
    const line = [];
    edges.forEach((k, i) => { const pts = edgePoints(g, g.dir[k]); line.push(...(i ? pts.slice(1) : pts)); });
    return { edges, nodes, time, len, turns, risky: turns.filter((t) => t.risky), line };
  }

  function turnText(t) {
    const verb = t.kind === "left" ? "Left" : t.kind === "right" ? "Right" : t.kind === "uturn" ? "U-turn" : "Continue";
    if (t.kind === "straight") return `Continue onto ${t.to}`;
    return `${verb} from ${t.from} onto ${t.to}`;
  }
  function riskDetail(t) {
    if (t.risk === "left") {
      if (t.fromRank >= 2) return `No signal. You wait for a gap in oncoming traffic on ${t.from}, ${ROAD_WORD[t.fromRank] || "a busy road"}.`;
      return `No signal. You cross traffic on ${ROAD_WORD[t.busyRank] || "a busy road"} to turn.`;
    }
    return `No signal. You merge into traffic on ${t.to}, ${ROAD_WORD[t.toRank] || "a busy road"}.`;
  }

  /* ---------- pairing: which detour replaces which risky turns ---------- */
  function segments(F, S) {
    const fIdx = new Map();
    F.nodes.forEach((n, i) => { if (!fIdx.has(n)) fIdx.set(n, i); });
    const segs = [];
    let i = 0;
    while (i < S.nodes.length - 1) {
      if (fIdx.has(S.nodes[i]) && fIdx.has(S.nodes[i + 1]) && fIdx.get(S.nodes[i + 1]) === fIdx.get(S.nodes[i]) + 1) { i++; continue; }
      // routes split after S.nodes[i]
      const sA = i;
      let j = i + 1;
      while (j < S.nodes.length && !(fIdx.has(S.nodes[j]) && fIdx.get(S.nodes[j]) > fIdx.get(S.nodes[sA]))) j++;
      if (j >= S.nodes.length) j = S.nodes.length - 1;
      segs.push({ sA, sB: j, fA: fIdx.get(S.nodes[sA]) ?? 0, fB: fIdx.get(S.nodes[j]) ?? F.nodes.length - 1 });
      i = j;
    }
    return segs;
  }

  function pinPoint(g, S, turn) {
    // a point ~40 m along the road after the turn, so Google has to make that turn
    const e = g.dir[S.edges[turn.i]];
    const pts = edgePoints(g, e);
    let acc = 0;
    for (let k = 1; k < pts.length; k++) {
      const d = haversine(pts[k - 1], pts[k]);
      if (acc + d >= 40 || k === pts.length - 1) {
        const f = Math.min(1, (40 - acc) / (d || 1));
        return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f];
      }
      acc += d;
    }
    return pts[pts.length - 1];
  }

  function gmapsUrl(src, dst, pins) {
    const f = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
    let u = `https://www.google.com/maps/dir/?api=1&origin=${f(src)}&destination=${f(dst)}&travelmode=driving`;
    if (pins.length) u += "&waypoints=" + pins.map(f).join("%7C");
    return u;
  }

  /* ---------- the one call the app makes ---------- */
  function plan(g, src, dst, opts) {
    const p = { ...DEFAULTS, ...(opts || {}) };
    if (opts && opts.avoid_rights) p.right_busy = RIGHT_AVOID;
    const s = nearest(g, src), d = nearest(g, dst);
    if (s < 0 || d < 0) return { error: "outside" };
    if (haversine(src, [g.lat[s], g.lon[s]]) > p.max_snap_m || haversine(dst, [g.lat[d], g.lon[d]]) > p.max_snap_m) return { error: "outside" };
    if (s === d) return { error: "same" };
    const fe = search(g, s, d, p, false);
    if (!fe) return { error: "noroute" };
    const se = search(g, s, d, p, true) || fe;
    const F = describe(g, fe, p, p), S = describe(g, se, p, p);
    const extra = S.time - F.time;
    const tooFar = extra > p.max_detour_min * 60 || extra > (F.time * p.max_detour_pct) / 100;
    const useSafe = !tooFar && S.risky.length < F.risky.length;

    const pairs = [];
    if (useSafe) {
      const seen = new Set();
      for (const sg of segments(F, S)) {
        const avoided = F.turns.filter((t) => t.risky && t.i >= Math.max(1, sg.fA) && t.i <= sg.fB && !seen.has("f" + t.i));
        if (!avoided.length) continue;
        avoided.forEach((t) => seen.add("f" + t.i));
        const instead = S.turns.filter((t) => t.maneuver && t.i >= Math.max(1, sg.sA) && t.i <= sg.sB);
        pairs.push({ avoided, instead, sg });
      }
      // turns the pairing could not place (should be rare): add as their own pair
      const left = F.risky.filter((t) => !seen.has("f" + t.i));
      if (left.length) pairs.push({ avoided: left, instead: [], sg: null });
    }
    // pins: one per pair, the most severe pairs first, at most max_waypoints
    const order = pairs.map((pr, ix) => ({ ix, sev: pr.avoided.reduce((a, t) => a + (t.risk === "left" ? 2 : 1), 0) }))
      .sort((a, b) => b.sev - a.sev);
    const pins = [];
    order.forEach(({ ix }) => {
      const pr = pairs[ix];
      const anchor = pr.instead.find((t) => t.signal && t.kind !== "straight") || pr.instead.find((t) => t.kind !== "straight") || pr.instead[0];
      if (anchor && pins.length < p.max_waypoints) {
        pr.locked = true;
        pr.pinTurn = anchor.i;
        pins.push({ i: anchor.i, at: pinPoint(g, S, anchor) });
      } else pr.locked = false;
    });
    pins.sort((a, b) => a.i - b.i);

    const chosen = useSafe ? S : F;
    const out = (R) => ({
      minutes: R.time / 60, km: R.len / 1000, line: R.line,
      risky: R.risky.map(slim),
      steps: R.turns.filter((t) => t.maneuver).map(slim),
    });
    function slim(t) {
      return { i: t.i, kind: t.kind, from: t.from, to: t.to, at: t.at, signal: t.signal, junction: t.junction, risk: t.risky ? t.risk : null, text: turnText(t), detail: t.risky ? riskDetail(t) : "" };
    }
    return {
      decision: useSafe ? "safer" : F.risky.length === 0 ? "already_safe" : tooFar ? "too_far" : "no_better",
      extra_min: extra / 60,
      fastest: out(F),
      safer: out(S),
      chosen: useSafe ? "safer" : "fastest",
      pairs: pairs.map((pr) => ({ avoided: pr.avoided.map(slim), instead: pr.instead.map(slim), locked: pr.locked })),
      still_risky: useSafe ? S.risky.map(slim) : [],
      pins: pins.map((x) => x.at),
      google_url: gmapsUrl(src, dst, useSafe ? pins.map((x) => x.at) : []),
      snapped: { from: [g.lat[s], g.lon[s]], to: [g.lat[d], g.lon[d]] },
      limits: { max_detour_min: p.max_detour_min, max_detour_pct: p.max_detour_pct },
    };
  }

  const api = { DEFAULTS, loadGraph, plan, nearest, haversine, bearing, turnKind, turnInfo, turnPen, search, segments, gmapsUrl, Heap };
  root.SaferRouter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
