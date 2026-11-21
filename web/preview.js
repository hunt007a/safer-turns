/* Safer Turns map helpers with no map library in them, so Node tests can run them:
 * which map mode a phone gets, the stops of the turn-by-turn preview, the camera for
 * each stop, and the stretch of road around a turn that the map paints red.
 */
(function (root) {
  "use strict";

  /* ---------- which map this device gets ----------
   * "3d": tilted MapLibre map with 3D buildings and camera flights.
   * "2d": flat MapLibre map, quick moves, no buildings (weak phones, data saver, or the person chose it).
   * "leaflet": no WebGL at all, so the old flat tile map.
   */
  function pickMode(env) {
    const e = env || {};
    if (!e.webgl) return "leaflet";
    if (e.saved === "2d" || e.saved === "3d") return e.saved;
    // Reduced motion keeps the 3D view; map.js then jumps between turns instead of flying.
    if (e.saveData) return "2d";
    if ((e.cores && e.cores <= 2) || (e.memoryGb && e.memoryGb <= 2)) return "2d";
    return "3d";
  }

  /* ---------- the preview's stops ----------
   * One stop for each turn on the route being shown, in driving order. On the safer
   * route, each risky turn it skips is put just before the turn that replaces it, so
   * the preview shows "the fastest route would turn here; you turn there instead".
   */
  function previewStops(result, view) {
    const r = result;
    if (!r || r.error) return [];
    const R = view === "fastest" ? r.fastest : r.safer;
    const skipBefore = new Map(); // safer-route step index -> risky turns it replaces
    const leftover = [];
    if (view !== "fastest" && r.decision === "safer") {
      for (const p of r.pairs || []) {
        if (p.instead && p.instead.length) {
          const k = p.instead[0].i;
          skipBefore.set(k, (skipBefore.get(k) || []).concat(p.avoided));
        } else leftover.push(...p.avoided);
      }
    }
    const stops = [];
    const steps = R.steps || [];
    const placed = new Set();
    // "Continue onto ..." is a road changing its name, not a turn: the preview skips it
    steps.filter((t) => t.kind !== "straight" || t.risk).forEach((t) => {
      // skipped turns go before the first step at or after the pair's first "instead" turn
      for (const [k, list] of skipBefore) {
        if (!placed.has(k) && k <= t.i) { placed.add(k); list.forEach((a) => stops.push(stop(a, "skipped"))); }
      }
      stops.push(stop(t, t.risk ? "risk" : t.signal ? "signal" : "turn"));
    });
    for (const [k, list] of skipBefore) if (!placed.has(k)) list.forEach((a) => stops.push(stop(a, "skipped")));
    leftover.forEach((a) => stops.push(stop(a, "skipped")));
    return stops;
  }

  function stop(t, kind) {
    let note;
    if (kind === "skipped") note = (t.reason || "No signal") + ". This route skips it.";
    else if (kind === "risk") note = (t.reason || "No signal") + ". Take care here.";
    else if (kind === "signal") note = "At a traffic signal.";
    else note = t.junction ? "No signal, but no busy traffic to cross." : "";
    return { kind, at: t.at, hdg: t.hdg || 0, text: t.text, note, tag: t.tag || "" };
  }

  /* ---------- camera for one stop ----------
   * Look along the road you arrive on, from a little behind the junction, so the
   * turn ahead is in the middle of the screen.
   */
  function cameraFor(s, mode) {
    const flat = mode !== "3d";
    return {
      center: [s.at[1], s.at[0]], // MapLibre wants [lon, lat]
      zoom: flat ? 17 : 17.6,
      pitch: flat ? 0 : 62,
      bearing: flat ? 0 : s.hdg || 0,
    };
  }

  /* ---------- the stretch of route around a turn ----------
   * Returns the points of `line` within `metres` (measured along the line) either side
   * of the vertex nearest `at`. Both are [lat, lon].
   */
  const toRad = (d) => (d * Math.PI) / 180;
  function dist(a, b) {
    const x = toRad(b[1] - a[1]) * Math.cos(toRad((a[0] + b[0]) / 2)), y = toRad(b[0] - a[0]);
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  function aroundTurn(line, at, metres) {
    if (!line || line.length < 2) return [];
    let k = 0, bd = Infinity;
    line.forEach((p, i) => { const d = dist(p, at); if (d < bd) { bd = d; k = i; } });
    const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const walk = (step) => {
      const out = [];
      let acc = 0;
      for (let i = k; i + step >= 0 && i + step < line.length; i += step) {
        const d = dist(line[i], line[i + step]);
        if (acc + d >= metres) { out.push(lerp(line[i], line[i + step], (metres - acc) / (d || 1))); return out; }
        acc += d;
        out.push(line[i + step]);
      }
      return out;
    };
    return [...walk(-1).reverse(), line[k], ...walk(1)];
  }

  const api = { pickMode, previewStops, cameraFor, aroundTurn };
  root.SaferPreview = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
