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
  const worker = new Worker("worker.js?v=4&roads=" + encodeURIComponent(CFG.roadsUrl || "roads/toronto.json"));
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
  function show(id) { $("plan").hidden = id !== "plan"; $("results").hidden = id !== "results"; window.scrollTo(0, 0); if (id === "results") setTimeout(() => map && map.resize(), 50); else endPreview(); }
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
      endPreview(); $("previewBtn").hidden = true;
      if (map) map.clear();
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
    endPreview();
    $("previewBtn").hidden = !(S.view === "safer" ? r.safer : r.fastest).steps.length;
    drawMap();
  }

  $("pairs").addEventListener("click", (e) => {
    const b = e.target.closest(".pair"); if (!b) return;
    document.querySelectorAll("#pairs .pair").forEach((x) => x.classList.toggle("on", x === b));
    const pts = U.focusPoints(S.result, S.view, b.dataset);
    if (pts.length && map) {
      endPreview();
      map.focus(pts);
      $("mapwrap").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  /* ---------- map ---------- */
  const P = window.SaferPreview;
  let mode = P.pickMode({
    webgl: window.SaferMap.hasWebGL(),
    saved: store.get("map", null),
    reducedMotion: !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches),
    saveData: !!(navigator.connection && navigator.connection.saveData),
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: navigator.deviceMemory || 0,
  });
  let map = null;
  function drawMode() {
    const b = $("modeBtn");
    b.hidden = mode === "leaflet";
    b.textContent = mode === "3d" ? "2D" : "3D";
    b.setAttribute("aria-label", mode === "3d" ? "Switch to flat map" : "Switch to 3D map");
    $("mapwrap").dataset.mode = mode;
  }
  drawMode();
  $("modeBtn").addEventListener("click", () => {
    mode = mode === "3d" ? "2d" : "3d";
    store.set("map", mode); drawMode();
    if (map) { map.setMode(mode); if (PV.on) map.fly(PV.stops[PV.k]); }
  });
  function drawMap() {
    if (!map) map = window.SaferMap.create($("map"), mode);
    map.draw(S.result, S.view);
  }

  /* ---------- turn-by-turn preview ---------- */
  const PV = { on: false, stops: [], k: 0 };
  function previewAt(k) {
    PV.k = Math.max(0, Math.min(PV.stops.length - 1, k));
    const s = PV.stops[PV.k];
    $("pvCount").textContent = `Turn ${PV.k + 1} of ${PV.stops.length}`;
    $("pvKind").textContent = { skipped: "Skipped", risk: "Take care", signal: "Signal", turn: "Turn" }[s.kind];
    $("pvKind").className = "pvkind " + s.kind;
    $("pvText").textContent = s.kind === "skipped" ? "Fastest route would: " + s.text : s.text;
    $("pvNote").textContent = s.note;
    $("pvPrev").disabled = PV.k === 0;
    $("pvNext").textContent = PV.k === PV.stops.length - 1 ? "Done" : "Next";
    map.fly(s);
  }
  function startPreview() {
    const r = S.result; if (!r || r.error || !map) return;
    PV.stops = P.previewStops(r, S.view);
    if (!PV.stops.length) return;
    PV.on = true;
    $("pv").hidden = false; $("previewBtn").hidden = true;
    $("mapwrap").classList.add("previewing");
    $("mapwrap").scrollIntoView({ behavior: "smooth", block: "start" });
    previewAt(0);
    $("pvNext").focus();
  }
  function endPreview() {
    if (!PV.on) return;
    PV.on = false;
    $("pv").hidden = true; $("previewBtn").hidden = false;
    $("mapwrap").classList.remove("previewing");
    if (map) map.endPreview();
  }
  $("previewBtn").addEventListener("click", startPreview);
  $("pvPrev").addEventListener("click", () => previewAt(PV.k - 1));
  $("pvNext").addEventListener("click", () => (PV.k === PV.stops.length - 1 ? endPreview() : previewAt(PV.k + 1)));
  $("pvClose").addEventListener("click", endPreview);
  document.addEventListener("keydown", (e) => {
    if (!PV.on) return;
    if (e.key === "ArrowRight") { previewAt(PV.k + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { previewAt(PV.k - 1); e.preventDefault(); }
    else if (e.key === "Escape") endPreview();
  });
  window.SaferTurnsDebug = { get result() { return S.result; }, get view() { return S.view; }, get mode() { return mode; }, get map() { return map; }, get preview() { return PV; } };
})();
