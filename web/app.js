/* Safer Turns app: plan screen, results screen, address search, map. */
(function () {
  "use strict";
  const CFG = window.SAFER_TURNS_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("st." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("st." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const S = { from: null, to: null, ready: false, result: null, view: "safer", opts: { avoid_rights: store.get("rights", false), max_detour_min: store.get("limit", 7) } };

  /* ---------- worker ---------- */
  const worker = new Worker("worker.js?v=2&roads=" + encodeURIComponent(CFG.roadsUrl || "roads/toronto.json"));
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
      document.querySelector("#results").classList.remove("busy");
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
  function parseLatLon(q) {
    const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  }
  async function geocode(q) {
    const ll = parseLatLon(q);
    if (ll) return [{ label: q.trim(), sub: "Coordinates", pt: ll }];
    if (CFG.geoapifyKey) {
      const u = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&filter=rect:${box[1]},${box[0]},${box[3]},${box[2]}&limit=5&apiKey=${encodeURIComponent(CFG.geoapifyKey)}`;
      const j = await (await fetch(u)).json();
      return (j.features || []).map((f) => ({ label: f.properties.address_line1 || f.properties.formatted, sub: f.properties.address_line2 || "", pt: [f.properties.lat, f.properties.lon] }));
    }
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en&bbox=${box[1]},${box[0]},${box[3]},${box[2]}`;
    const j = await (await fetch(u)).json();
    return (j.features || []).map((f) => {
      const p = f.properties, c = f.geometry.coordinates;
      const line1 = p.name || [p.housenumber, p.street].filter(Boolean).join(" ");
      const line2 = [p.name && p.street ? [p.housenumber, p.street].filter(Boolean).join(" ") : "", p.district || p.city].filter(Boolean).join(", ");
      return { label: line1 || "Unnamed place", sub: line2, pt: [c[1], c[0]] };
    });
  }
  function inBox(pt) { return pt[0] >= box[0] && pt[0] <= box[2] && pt[1] >= box[1] && pt[1] <= box[3]; }

  function attachSearch(input, list, key) {
    let timer = null, items = [], sel = -1;
    const close = () => { list.hidden = true; sel = -1; input.setAttribute("aria-expanded", "false"); };
    const choose = (it) => { S[key] = it; input.value = it.label; close(); updateGo(); };
    const draw = () => {
      list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</li>`).join("");
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
    };
    input.addEventListener("input", () => {
      S[key] = null; updateGo();
      clearTimeout(timer);
      const q = input.value;
      const ll = parseLatLon(q);
      if (ll) { items = [{ label: q.trim(), sub: "Coordinates", pt: ll }]; draw(); return; }
      if (q.trim().length < 3) { items = []; draw(); return; }
      timer = setTimeout(async () => {
        try { items = await geocode(q); if (input.value === q) draw(); }
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
    for (const k of ["from", "to"]) if (!inBox(S[k].pt)) { $("formMsg").textContent = `${k === "from" ? "Start" : "Destination"} is outside Toronto. Safer Turns covers the City of Toronto only for now.`; return; }
    remember(S.to);
    show("results");
    S.view = "safer";
    $("rFrom").textContent = S.from.label; $("rTo").textContent = S.to.label;
    $("rights").checked = !!S.opts.avoid_rights; $("limit").value = String(S.opts.max_detour_min);
    run();
  });

  /* ---------- recent destinations (this phone only) ---------- */
  function remember(it) {
    const r = store.get("recent", []).filter((x) => x.label !== it.label);
    r.unshift({ label: it.label, sub: it.sub || "", pt: it.pt });
    store.set("recent", r.slice(0, 5)); drawRecent();
  }
  function drawRecent() {
    const r = store.get("recent", []);
    $("recentCard").hidden = !r.length;
    $("recentList").innerHTML = r.map((x, i) => `<li><button type="button" data-i="${i}">${esc(x.label)}</button></li>`).join("");
  }
  $("recentList").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const it = store.get("recent", [])[+b.dataset.i]; S.to = it; $("toInput").value = it.label; updateGo();
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
  const fmtMin = (m) => (m < 1 ? "<1 min" : Math.round(m) + " min");
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function onResult(r) {
    S.result = r;
    if (r.error) {
      const msg = { outside: "That spot is off the road map.", same: "Start and destination are at the same spot.", noroute: "No driving route was found between those points.", crash: "Something went wrong working out the route." }[r.error] || "No route.";
      $("eyebrow").textContent = "No route"; $("big").textContent = msg; $("sub").textContent = r.message || "";
      $("pairs").innerHTML = ""; $("still").innerHTML = ""; $("steps").innerHTML = ""; $("stepsSum").textContent = "";
      $("fallback").hidden = true; $("listH").textContent = "";
      $("go").removeAttribute("href"); $("go").setAttribute("aria-disabled", "true");
      $("fine").textContent = "Pick a different start or destination to get a route.";
      $("barSafe").style.width = "0"; $("barFast").style.width = "0"; $("tSafe").textContent = ""; $("tFast").textContent = "";
      if (layers) layers.clearLayers();
      return;
    }
    S.view = r.chosen;
    const F = r.fastest, Sf = r.safer;
    const riskWord = S.opts.avoid_rights ? ["risky turn", "risky turns"] : ["risky left", "risky lefts"];
    const nAvoid = r.pairs.reduce((n, p) => n + p.avoided.length, 0);
    const extra = Math.max(0, r.extra_min);
    $("fallback").hidden = true;
    if (r.decision === "safer") {
      $("eyebrow").textContent = "Safer route found";
      $("big").innerHTML = extra < 0.5
        ? `<span class="plus">No extra time</span> to skip ${plural(nAvoid, ...riskWord)}`
        : `<span class="plus">+${Math.round(extra)} min</span> to skip ${plural(nAvoid, ...riskWord)}`;
      const per = Math.round((extra * 60) / Math.max(1, nAvoid));
      $("sub").innerHTML = extra < 0.5
        ? `The fastest route makes ${plural(nAvoid, "turn", "turns")} across traffic with <b>no signal</b>. This one avoids ${nAvoid === 1 ? "it" : "them"} at about the same time.`
        : `The fastest route saves ${fmtMin(extra)} by turning across traffic at <b>${plural(nAvoid, "intersection", "intersections")} with no signal</b>. That is about <b>${per} seconds per risky turn</b>.`;
    } else if (r.decision === "too_far") {
      $("eyebrow").textContent = "Fastest route";
      $("big").textContent = `${fmtMin(F.minutes)}, with ${plural(F.risky.length, ...riskWord)}`;
      $("sub").textContent = `The safer route would add ${fmtMin(extra)}, more than your limit, so this is the fastest route. The turns to watch are listed below.`;
      $("fallback").hidden = false;
      $("fallback").innerHTML = `<b>No safer route within ${r.limits.max_detour_min} min.</b> Opening the fastest route. Watch for the turns marked in red.`;
    } else if (r.decision === "already_safe") {
      $("eyebrow").textContent = "Good news";
      $("big").textContent = "The fastest route has no risky lefts";
      $("sub").textContent = "Every left across busy traffic on this trip is at a signal already.";
    } else {
      $("eyebrow").textContent = "Fastest route";
      $("big").textContent = `${fmtMin(F.minutes)}, with ${plural(F.risky.length, ...riskWord)}`;
      $("sub").textContent = "No route found that makes fewer risky turns. The turns to watch are listed below.";
    }
    const maxT = Math.max(F.minutes, Sf.minutes) || 1;
    $("barSafe").style.width = (100 * Sf.minutes / maxT) + "%"; $("barFast").style.width = (100 * F.minutes / maxT) + "%";
    $("tSafe").textContent = fmtMin(Sf.minutes); $("tFast").textContent = fmtMin(F.minutes);
    $("go").href = r.google_url; $("go").removeAttribute("aria-disabled");
    $("go").textContent = r.chosen === "safer" ? "Open in Google Maps" : "Open fastest route in Google Maps";
    $("fine").textContent = r.chosen === "safer" && r.pins.length
      ? `Google Maps will announce ${plural(r.pins.length, "stop", "stops")}. Those are pinned signals to drive through, not places to stop.`
      : "Opens the route in Google Maps with no stops added.";
    drawView();
  }

  function turnRow(cls, icon, tag, turns, extraHtml) {
    return `<div class="row ${cls}"><div class="ic">${icon}</div><div><div class="tag">${tag}</div>${turns.map((t) => `<div class="what">${esc(t.text)}</div>${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ""}`).join("")}${extraHtml || ""}</div></div>`;
  }

  function drawView() {
    const r = S.result; if (!r || r.error) return;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.r === S.view)));
    const R = S.view === "safer" ? r.safer : r.fastest;
    let html = "";
    if (S.view === "safer" && r.decision === "safer") {
      $("listH").textContent = "Turns this route skips";
      r.pairs.forEach((p, i) => {
        const sig = p.instead.filter((t) => t.signal && t.kind !== "straight");
        const insteadTurns = p.instead.length ? p.instead.map((t) => ({ ...t, detail: t.signal ? "At a traffic signal." : "" })) : [{ text: "A different street with no risky turn", detail: "" }];
        html += `<button class="pair" type="button" data-pair="${i}">` +
          turnRow("avoid struck", "!", "Fastest route would", p.avoided) +
          turnRow("instead", sig.length ? "✓" : "→", "Instead", insteadTurns,
            `<span class="lock${p.locked ? "" : " no"}">${p.locked ? "Locked in the Google Maps link" : "Likely, not locked: check Google's route here"}</span>`) +
          `</button>`;
      });
    } else {
      $("listH").textContent = R.risky.length ? (S.view === "fastest" ? "Risky turns on the fastest route" : "Turns to watch") : "No risky turns on this route";
      R.risky.forEach((t, i) => { html += `<button class="pair" type="button" data-risk="${i}">` + turnRow("avoid", "!", "On this route", [t]) + `</button>`; });
    }
    $("pairs").innerHTML = html;
    const still = S.view === "safer" ? r.still_risky : [];
    $("still").innerHTML = still.length ? `<h3>Still on this route</h3>` + still.map((t) => `<div class="pair">${turnRow("still", "!", "Take care", [t])}</div>`).join("") : "";
    $("lgStill").hidden = !still.length;
    $("lgRisk").textContent = S.view === "safer" && r.decision === "safer" ? "Risky turn skipped" : "Risky turn on this route";
    $("lgSig").parentElement.hidden = !(S.view === "safer" && r.decision === "safer");
    $("stepsSum").textContent = `All ${R.steps.length} turns on the ${S.view === "safer" ? "safer" : "fastest"} route`;
    $("steps").innerHTML = R.steps.map((t, i) => {
      const chip = t.risk ? `<span class="chip risk">No signal</span>` : t.signal ? `<span class="chip sig">Signal</span>` : t.junction ? `<span class="chip loc">No signal</span>` : `<span></span>`;
      return `<li><span class="n">${i + 1}</span><span>${esc(t.text)}</span>${chip}</li>`;
    }).join("");
    drawMap();
  }

  $("pairs").addEventListener("click", (e) => {
    const b = e.target.closest(".pair"); if (!b) return;
    document.querySelectorAll("#pairs .pair").forEach((x) => x.classList.toggle("on", x === b));
    const r = S.result;
    let pts = [];
    if (b.dataset.pair != null) { const p = r.pairs[+b.dataset.pair]; pts = [...p.avoided, ...p.instead.filter((t) => t.signal)].map((t) => t.at); }
    else if (b.dataset.risk != null) { const R = S.view === "safer" ? r.safer : r.fastest; pts = [R.risky[+b.dataset.risk].at]; }
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
