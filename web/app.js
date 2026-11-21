/* Safer Turns app: wires the screens, address search and map to the page.
 * The words and HTML the screens show are worked out in ui.js (SaferUI). */
(function () {
  "use strict";
  const CFG = window.SAFER_TURNS_CONFIG || {};
  const U = window.SaferUI;
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("st." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("st." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const S = { from: null, to: null, ready: false, result: null, view: "safer", opts: { avoid_rights: store.get("rights", false), max_detour_min: store.get("limit", 7) } };

  /* ---------- worker ---------- */
  const worker = new Worker("worker.js?v=3&roads=" + encodeURIComponent(CFG.roadsUrl || "roads/toronto.json"));
  let reqId = 0;
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "ready") {
      S.ready = true; S.area = m;
      $("dataAge").textContent = "Road data from " + m.built;
      if (m.attribution) $("attrib").textContent = m.attribution + ".";
      updateGo();
    } else if (m.type === "error") {
      $("goBtn").textContent = "Road data not loaded";
      $("formMsg").textContent = m.message;
    } else if (m.type === "plan" && m.id === reqId) {
      $("results").classList.remove("busy");
      onResult(m.result);
    }
  };
  function run() {
    reqId++;
    $("results").classList.add("busy");
    worker.postMessage({ type: "plan", id: reqId, from: S.from.pt, to: S.to.pt, opts: S.opts });
  }

  /* ---------- address search ---------- */
  const box = CFG.searchBox || [43.581, -79.639, 43.856, -79.115];
  async function geocode(q) {
    const ll = U.parseLatLon(q);
    if (ll) return [{ label: q.trim(), sub: "Coordinates", pt: ll }];
    if (CFG.geoapifyKey) return U.geoapifyResults(await (await fetch(U.geoapifyUrl(q, box, CFG.geoapifyKey))).json());
    return U.photonResults(await (await fetch(U.photonUrl(q, box))).json());
  }

  function attachSearch(input, list, key) {
    let timer = null, items = [], sel = -1;
    const close = () => { list.hidden = true; sel = -1; input.setAttribute("aria-expanded", "false"); };
    const choose = (it) => { S[key] = it; input.value = it.label; close(); updateGo(); };
    const draw = () => {
      list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${U.esc(it.label)}${it.sub ? `<small>${U.esc(it.sub)}</small>` : ""}</li>`).join("");
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
    };
    input.addEventListener("input", () => {
      S[key] = null; updateGo();
      clearTimeout(timer);
      const q = input.value;
      const ll = U.parseLatLon(q);
      if (ll) { items = [{ label: q.trim(), sub: "Coordinates", pt: ll }]; draw(); return; }
      if (q.trim().length < 3) { items = []; draw(); return; }
      timer = setTimeout(async () => {
        try { const found = await geocode(q); if (input.value === q) { items = found; draw(); } }
        catch (e) { items = []; draw(); $("formMsg").textContent = "Address search is not reachable right now. You can type lat,lon instead."; }
      }, 350);
    });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && items.length) { choose(items[Math.max(0, sel)]); e.preventDefault(); }
      else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); choose(items[+li.dataset.i]); } });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }
  attachSearch($("fromInput"), $("fromList"), "from");
  attachSearch($("toInput"), $("toList"), "to");

  $("locBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { $("formMsg").textContent = "This browser cannot share your location. Type a start address."; return; }
    $("locBtn").textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition((pos) => {
      S.from = { label: "My location", pt: [pos.coords.latitude, pos.coords.longitude] };
      $("fromInput").value = "My location"; $("locBtn").textContent = "Use my location"; updateGo();
    }, () => {
      $("locBtn").textContent = "Use my location";
      $("formMsg").textContent = "Location was not shared. Type a start address instead.";
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  function updateGo() {
    const b = $("goBtn");
    if (!S.ready) { b.disabled = true; b.textContent = "Loading Toronto roads…"; return; }
    b.disabled = !(S.from && S.to);
    b.textContent = "Find safer route";
  }
  $("planForm").addEventListener("submit", (e) => {
    e.preventDefault();
    $("formMsg").textContent = "";
    if (!S.from || !S.to) return;
    for (const k of ["from", "to"]) if (!U.inBox(box, S[k].pt)) { $("formMsg").textContent = `${k === "from" ? "Start" : "Destination"} is outside Toronto. Safer Turns covers the City of Toronto only for now.`; return; }
    remember(S.to);
    show("results");
    S.view = "safer";
    $("rFrom").textContent = S.from.label; $("rTo").textContent = S.to.label;
    $("rights").checked = !!S.opts.avoid_rights; $("limit").value = String(S.opts.max_detour_min);
    run();
  });

  /* ---------- recent destinations (this phone only) ---------- */
  function remember(it) { store.set("recent", U.addRecent(store.get("recent", []), it)); drawRecent(); }
  function drawRecent() {
    const r = store.get("recent", []);
    $("recentCard").hidden = !r.length;
    $("recentList").innerHTML = r.map((x, i) => `<li><button type="button" data-i="${i}">${U.esc(x.label)}</button></li>`).join("");
  }
  $("recentList").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const it = store.get("recent", [])[+b.dataset.i]; if (!it) return;
    S.to = it; $("toInput").value = it.label; updateGo();
  });
  drawRecent();

  /* ---------- screens ---------- */
  function show(id) { $("plan").hidden = id !== "plan"; $("results").hidden = id !== "results"; window.scrollTo(0, 0); if (id === "results") setTimeout(() => map && map.invalidateSize(), 50); }
  $("backBtn").addEventListener("click", () => show("plan"));
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { $(o.dataset.open).hidden = false; $("scrim").hidden = false; }
    if (e.target.closest("[data-close]") || e.target === $("scrim")) { $("about").hidden = true; $("scrim").hidden = true; }
  });
  $("rights").addEventListener("change", (e) => { S.opts.avoid_rights = e.target.checked; store.set("rights", e.target.checked); run(); });
  $("limit").addEventListener("change", (e) => { S.opts.max_detour_min = +e.target.value; store.set("limit", +e.target.value); run(); });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.r; drawView(); }));

  /* ---------- results ---------- */
  function onResult(r) {
    S.result = r;
    const v = U.verdict(r, S.opts.avoid_rights);
    $("eyebrow").textContent = v.eyebrow; $("big").innerHTML = v.bigHtml; $("sub").innerHTML = v.subHtml;
    $("fallback").hidden = !v.fallbackHtml; $("fallback").innerHTML = v.fallbackHtml || "";
    $("barSafe").style.width = v.barSafe + "%"; $("barFast").style.width = v.barFast + "%";
    $("tSafe").textContent = v.tSafe; $("tFast").textContent = v.tFast;
    $("go").textContent = v.goText; $("fine").textContent = v.fine;
    if (v.error) {
      // a failed trip must not leave the previous trip's link, lists or map behind
      $("go").removeAttribute("href"); $("go").setAttribute("aria-disabled", "true");
      for (const id of ["pairs", "still", "steps"]) $(id).innerHTML = "";
      $("stepsSum").textContent = ""; $("listH").textContent = "";
      $("lgStill").hidden = true; $("lgSig").parentElement.hidden = true;
      if (layers) layers.clearLayers();
      markers = [];
      return;
    }
    S.view = r.chosen;
    $("go").href = r.google_url; $("go").removeAttribute("aria-disabled");
    drawView();
  }

  function drawView() {
    const r = S.result; if (!r || r.error) return;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.r === S.view)));
    const t = U.turnList(r, S.view);
    $("listH").textContent = t.heading; $("pairs").innerHTML = t.html; $("still").innerHTML = t.stillHtml;
    $("lgStill").hidden = !t.legend.still; $("lgRisk").textContent = t.legend.riskLabel; $("lgSig").parentElement.hidden = !t.legend.signal;
    $("stepsSum").textContent = t.stepsSummary; $("steps").innerHTML = t.stepsHtml;
    drawMap();
  }

  $("pairs").addEventListener("click", (e) => {
    const b = e.target.closest(".pair"); if (!b) return;
    document.querySelectorAll("#pairs .pair").forEach((x) => x.classList.toggle("on", x === b));
    const pts = U.focusPoints(S.result, S.view, b.dataset);
    if (pts.length && map) {
      map.fitBounds(L.latLngBounds(pts).pad(0.6), { maxZoom: 17 });
      markers.forEach((m) => { if (pts.some((p) => p[0] === m.at[0] && p[1] === m.at[1])) { const el = m.mk.getElement(); if (el) { const d = el.firstChild; d.classList.remove("pulse"); void d.offsetWidth; d.classList.add("pulse"); } } });
      $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  /* ---------- map ---------- */
  let map = null, layers = null, markers = [];
  function icon(cls, txt) { return L.divIcon({ className: "", html: `<div class="mk ${cls}">${txt || ""}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }); }
  function drawMap() {
    if (typeof L === "undefined") return;
    if (!map) {
      map = L.map("map", { zoomControl: false, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
      layers = L.layerGroup().addTo(map);
    }
    layers.clearLayers(); markers = [];
    const r = S.result, safeView = S.view === "safer";
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    L.polyline(r.fastest.line, { color: safeView ? col("--fast") : col("--risk"), weight: 5, opacity: safeView ? 0.6 : 0.95, dashArray: safeView ? "8 6" : null }).addTo(layers);
    if (r.decision === "safer" || safeView) L.polyline(r.safer.line, { color: col("--safe"), weight: 6, opacity: safeView ? 1 : 0.3 }).addTo(layers);
    const add = (at, cls, txt) => { const mk = L.marker(at, { icon: icon(cls, txt), keyboard: false }).addTo(layers); markers.push({ at, mk }); };
    if (safeView && r.decision === "safer") {
      r.pairs.forEach((p) => { p.avoided.forEach((t) => add(t.at, "risk", "!")); p.instead.filter((t) => t.signal && t.kind !== "straight").forEach((t) => add(t.at, "safe", "")); });
      r.still_risky.forEach((t) => add(t.at, "amber", "!"));
    } else {
      (safeView ? r.safer : r.fastest).risky.forEach((t) => add(t.at, "risk", "!"));
    }
    add(r.fastest.line[0], "start", ""); add(r.fastest.line[r.fastest.line.length - 1], "end", "");
    map.fitBounds(L.latLngBounds([...r.fastest.line, ...r.safer.line]).pad(0.08), { animate: false });
  }
})();
