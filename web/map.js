/* Safer Turns map. One small interface over two libraries:
 *  - MapLibre GL ("3d" tilted with buildings, or "2d" flat) with free OpenFreeMap tiles;
 *  - Leaflet ("leaflet") for phones with no WebGL, loaded only when needed.
 * app.js calls create(), then draw(result, view), focus(points), fly(stop), setMode(mode).
 */
(function (root) {
  "use strict";
  const CFG = root.SAFER_TURNS_CONFIG || {};
  const STYLE_LIGHT = CFG.mapStyle || "https://tiles.openfreemap.org/styles/positron";
  const STYLE_DARK = CFG.mapStyleDark || "https://tiles.openfreemap.org/styles/dark";
  const TORONTO = [-79.38, 43.70];
  const LABEL_ZOOM = 14; // below this the map shows red "!" dots without their reason labels
  const darkQ = root.matchMedia ? root.matchMedia("(prefers-color-scheme: dark)") : null;
  const motionQ = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const isDark = () => !!(darkQ && darkQ.matches);
  const still = () => !!(motionQ && motionQ.matches);
  const col = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const ll = (p) => [p[1], p[0]]; // [lat, lon] -> [lon, lat]

  function hasWebGL() {
    try { const c = document.createElement("canvas"); return !!(root.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); }
    catch (e) { return false; }
  }

  /* what the map shows for one result and view: lines, red stretches, markers */
  function overlays(r, view) {
    const P = root.SaferPreview;
    const safeView = view === "safer";
    const marks = [];
    const add = (t, cls, txt, tag) => marks.push({ at: Array.isArray(t) ? t : t.at, cls, txt, tag: tag || "" });
    const redTurns = [];
    if (safeView && r.decision === "safer") {
      r.pairs.forEach((p) => {
        p.avoided.forEach((t) => { add(t, "risk", "!", t.tag); redTurns.push([r.fastest.line, t.at]); });
        p.instead.filter((t) => t.signal && t.kind !== "straight").forEach((t) => add(t, "safe", ""));
      });
      r.still_risky.forEach((t) => add(t, "amber", "!", t.tag));
    } else {
      const R = safeView ? r.safer : r.fastest;
      R.risky.forEach((t) => { add(t, "risk", "!", t.tag); redTurns.push([R.line, t.at]); });
    }
    add(r.fastest.line[0], "start", ""); add(r.fastest.line[r.fastest.line.length - 1], "end", "");
    return {
      safeView,
      fastRisky: r.fastest.risky.length > 0, // a fastest route with no risky turns is drawn green, not red
      showSafe: r.decision === "safer" || safeView,
      fast: r.fastest.line, safe: r.safer.line,
      red: redTurns.map(([line, at]) => P.aroundTurn(line, at, 45)).filter((x) => x.length > 1),
      marks,
      all: [...r.fastest.line, ...r.safer.line],
    };
  }

  function markerEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "mkwrap";
    wrap.innerHTML = `<div class="mk ${m.cls}">${m.txt}</div>` + (m.tag ? `<span class="mktag ${m.cls}">${m.tag.replace(/[&<>]/g, "")}</span>` : "");
    return wrap;
  }

  /* ---------------- MapLibre ---------------- */
  function maplibreMap(el, mode) {
    const gl = root.maplibregl;
    let state = null, markers = [], here = null, styleReady = false;
    const map = new gl.Map({
      container: el, style: isDark() ? STYLE_DARK : STYLE_LIGHT,
      center: TORONTO, zoom: 11, pitch: mode === "3d" ? 45 : 0, maxPitch: 70,
      attributionControl: { compact: true }, dragRotate: true, fadeDuration: 0,
    });
    map.on("error", (e) => console.warn("map:", e && e.error ? e.error.message : e));
    map.addControl(new gl.NavigationControl({ showCompass: true, showZoom: false, visualizePitch: true }), "top-right");
    map.on("style.load", () => { styleReady = true; addLayers(); paint(); });
    // labels on red turns only when zoomed in enough that they don't pile on top of each other
    const labels = () => el.classList.toggle("farzoom", map.getZoom() < LABEL_ZOOM);
    map.on("zoom", labels); labels();
    if (darkQ && darkQ.addEventListener) darkQ.addEventListener("change", () => { styleReady = false; map.setStyle(isDark() ? STYLE_DARK : STYLE_LIGHT); });

    const empty = { type: "FeatureCollection", features: [] };
    const lineFC = (lines) => ({ type: "FeatureCollection", features: lines.map((l) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l.map(ll) } })) });

    function addLayers() {
      const firstSymbol = (map.getStyle().layers || []).find((l) => l.type === "symbol");
      const before = firstSymbol && firstSymbol.id;
      if (map.getSource("openmaptiles") && !map.getLayer("st-buildings")) {
        map.addLayer({
          id: "st-buildings", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14,
          layout: { visibility: mode === "3d" ? "visible" : "none" },
          paint: {
            "fill-extrusion-color": isDark() ? "#2a3542" : "#d9dee4",
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, ["coalesce", ["get", "render_height"], 8]],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.8,
          },
        }, before);
      }
      for (const id of ["st-fast", "st-safe", "st-red"]) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: empty });
      // routes go above buildings so a tall block never hides the line
      map.addLayer({ id: "st-fast", type: "line", source: "st-fast", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": col("--fast"), "line-width": 5 } });
      map.addLayer({ id: "st-safe", type: "line", source: "st-safe", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": col("--safe"), "line-width": 6 } });
      map.addLayer({ id: "st-red-case", type: "line", source: "st-red", layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 13, "line-opacity": 0.9 } });
      map.addLayer({ id: "st-red", type: "line", source: "st-red", layout: { "line-cap": "round" }, paint: { "line-color": col("--risk"), "line-width": 8 } });
    }

    function paint() {
      if (!state || !styleReady || !map.getSource("st-fast")) return;
      const o = state;
      map.getSource("st-fast").setData(lineFC([o.fast]));
      map.getSource("st-safe").setData(lineFC(o.showSafe ? [o.safe] : []));
      map.getSource("st-red").setData(lineFC(o.red));
      map.setPaintProperty("st-fast", "line-color", o.safeView ? col("--fast") : o.fastRisky ? col("--risk") : col("--safe"));
      map.setPaintProperty("st-fast", "line-opacity", o.safeView ? 0.85 : 0.95);
      map.setPaintProperty("st-fast", "line-dasharray", o.safeView ? [1.6, 1.2] : [1, 0]);
      map.setPaintProperty("st-safe", "line-color", col("--safe"));
      map.setPaintProperty("st-safe", "line-opacity", o.safeView ? 1 : 0.3);
      map.setPaintProperty("st-red", "line-color", col("--risk"));
    }

    // Fit the points with the map flat, then tilt: fitting while tilted pushes the near end off screen.
    function overview(pts, padding, pitch, duration, maxZoom) {
      const cur = { pitch: map.getPitch(), bearing: map.getBearing() };
      map.jumpTo({ pitch: 0, bearing: 0 });
      const cam = map.cameraForBounds(bounds(pts), { padding, maxZoom: maxZoom || 18 });
      map.jumpTo(cur);
      if (!cam) return;
      const to = { center: cam.center, zoom: cam.zoom - (pitch ? 0.45 : 0), pitch, bearing: 0 };
      if (duration) map.easeTo({ ...to, duration }); else map.jumpTo(to);
    }

    function bounds(pts) {
      const b = new gl.LngLatBounds();
      pts.forEach((p) => b.extend(ll(p)));
      return b;
    }

    const api = {
      kind: "maplibre",
      get mode() { return mode; },
      draw(r, view) {
        state = overlays(r, view);
        paint();
        markers.forEach((m) => m.mk.remove());
        markers = state.marks.map((m) => {
          const e = markerEl(m);
          return { at: m.at, el: e, mk: new gl.Marker({ element: e, anchor: "center", pitchAlignment: "viewport" }).setLngLat(ll(m.at)).addTo(map) };
        });
        map.resize();
        overview(state.all, 30, mode === "3d" ? 35 : 0, 0);
      },
      clear() { state = null; markers.forEach((m) => m.mk.remove()); markers = []; if (styleReady && map.getSource("st-fast")) for (const id of ["st-fast", "st-safe", "st-red"]) map.getSource(id).setData(empty); },
      focus(pts) {
        if (!pts.length) return;
        overview(pts, 70, mode === "3d" ? 50 : 0, still() ? 0 : 900, 17);
        api.pulse(pts);
      },
      pulse(pts) {
        markers.forEach((m) => { if (pts.some((p) => p[0] === m.at[0] && p[1] === m.at[1])) { const d = m.el.firstChild; d.classList.remove("pulse"); void d.offsetWidth; d.classList.add("pulse"); } });
      },
      fly(s) {
        const cam = root.SaferPreview.cameraFor(s, mode);
        if (!here) { const e = document.createElement("div"); e.className = "here"; here = new gl.Marker({ element: e, anchor: "center" }); }
        here.setLngLat(cam.center).addTo(map);
        // keep the turn in the part of the map the preview card does not cover
        const card = document.getElementById("pv");
        cam.padding = { top: 0, left: 0, right: 0, bottom: card && !card.hidden ? card.offsetHeight + 8 : 0 };
        if (mode === "3d" && !still()) map.flyTo({ ...cam, duration: 2000, curve: 1.3, essential: true });
        else map.easeTo({ ...cam, duration: 600 }); // reduced motion: a short glide, no zoom-out arc
        api.pulse([s.at]);
      },
      endPreview() { if (here) here.remove(); map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 }); if (state) overview(state.all, 30, mode === "3d" ? 35 : 0, still() ? 0 : 900); },
      setMode(m) {
        mode = m;
        if (map.getLayer("st-buildings")) map.setLayoutProperty("st-buildings", "visibility", m === "3d" ? "visible" : "none");
        map.easeTo({ pitch: m === "3d" ? 45 : 0, bearing: m === "3d" ? map.getBearing() : 0, duration: still() ? 0 : 500 });
      },
      resize() { map.resize(); },
      raw: map,
    };
    return api;
  }

  /* ---------------- Leaflet (no WebGL) ---------------- */
  function loadLeaflet() {
    if (root.L) return Promise.resolve();
    return new Promise((ok, bad) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "vendor/leaflet/leaflet.css"; document.head.appendChild(css);
      const s = document.createElement("script"); s.src = "vendor/leaflet/leaflet.js"; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
  }
  function leafletMap(el) {
    let map = null, layers = null, markers = [], pending = null, here = null;
    const ready = loadLeaflet().then(() => {
      const L = root.L;
      map = L.map(el, { zoomControl: false, attributionControl: true });
      const labels = () => el.classList.toggle("farzoom", map.getZoom() < LABEL_ZOOM);
      map.on("zoomend", labels);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
      layers = L.layerGroup().addTo(map);
      if (pending) pending();
    }).catch(() => { el.textContent = "The map could not load. The turn list below still works."; });
    const whenReady = (f) => { if (map) f(); else pending = f; };
    const api = {
      kind: "leaflet", mode: "leaflet",
      draw(r, view) {
        whenReady(() => {
          const L = root.L, o = overlays(r, view);
          layers.clearLayers(); markers = [];
          L.polyline(o.fast, { color: o.safeView ? col("--fast") : o.fastRisky ? col("--risk") : col("--safe"), weight: 5, opacity: o.safeView ? 0.6 : 0.95, dashArray: o.safeView ? "8 6" : null }).addTo(layers);
          if (o.showSafe) L.polyline(o.safe, { color: col("--safe"), weight: 6, opacity: o.safeView ? 1 : 0.3 }).addTo(layers);
          o.red.forEach((seg) => L.polyline(seg, { color: col("--risk"), weight: 9, opacity: 0.95 }).addTo(layers));
          o.marks.forEach((m) => {
            const e = markerEl(m);
            const mk = L.marker(m.at, { icon: L.divIcon({ className: "", html: e.outerHTML, iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(layers);
            markers.push({ at: m.at, mk });
          });
          map.invalidateSize();
          map.fitBounds(L.latLngBounds(o.all).pad(0.08), { animate: false });
        });
      },
      clear() { whenReady(() => { layers.clearLayers(); markers = []; }); },
      focus(pts) { whenReady(() => { map.fitBounds(root.L.latLngBounds(pts).pad(0.6), { maxZoom: 17 }); api.pulse(pts); }); },
      pulse(pts) {
        markers.forEach((m) => { if (pts.some((p) => p[0] === m.at[0] && p[1] === m.at[1])) { const e = m.mk.getElement(); const d = e && e.querySelector(".mk"); if (d) { d.classList.remove("pulse"); void d.offsetWidth; d.classList.add("pulse"); } } });
      },
      fly(s) {
        whenReady(() => {
          const L = root.L;
          if (!here) here = L.marker(s.at, { icon: L.divIcon({ className: "", html: '<div class="here"></div>', iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false });
          here.setLatLng(s.at).addTo(map);
          map.setView(s.at, 17, { animate: !still() });
          api.pulse([s.at]);
        });
      },
      endPreview() { whenReady(() => { if (here) here.remove(); }); },
      setMode() {},
      resize() { if (map) map.invalidateSize(); },
      ready,
    };
    return api;
  }

  function create(el, mode) {
    if (mode !== "leaflet" && root.maplibregl) {
      try { return maplibreMap(el, mode); } catch (e) { console.warn("3D map failed, using flat map:", e.message); }
    }
    return leafletMap(el);
  }

  root.SaferMap = { create, hasWebGL, overlays };
})(typeof self !== "undefined" ? self : globalThis);
