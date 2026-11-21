/* Safer Turns screen logic with no DOM: the words, numbers and HTML the screens show,
 * worked out from a route result. app.js puts them on the page; tests/ui.test.js
 * checks them under Node.
 */
(function (root) {
  "use strict";

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtMin = (m) => (m < 1 ? "<1 min" : Math.round(m) + " min");
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- address search ---------- */
  function parseLatLon(q) {
    const m = String(q).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const pt = [parseFloat(m[1]), parseFloat(m[2])];
    return Math.abs(pt[0]) <= 90 && Math.abs(pt[1]) <= 180 ? pt : null;
  }
  // box is [south, west, north, east]
  const inBox = (box, pt) => pt[0] >= box[0] && pt[0] <= box[2] && pt[1] >= box[1] && pt[1] <= box[3];

  const photonUrl = (q, box) =>
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en&bbox=${box[1]},${box[0]},${box[3]},${box[2]}`;
  const geoapifyUrl = (q, box, key) =>
    `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&filter=rect:${box[1]},${box[0]},${box[3]},${box[2]}&limit=5&apiKey=${encodeURIComponent(key)}`;

  function photonResults(j) {
    return ((j && j.features) || []).filter((f) => f && f.geometry && f.properties).map((f) => {
      const p = f.properties, c = f.geometry.coordinates;
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      const line1 = p.name || street;
      const line2 = [p.name && p.street ? street : "", p.district || p.city].filter(Boolean).join(", ");
      return { label: line1 || "Unnamed place", sub: line2, pt: [c[1], c[0]] };
    });
  }
  function geoapifyResults(j) {
    return ((j && j.features) || []).filter((f) => f && f.properties).map((f) => ({
      label: f.properties.address_line1 || f.properties.formatted || "Unnamed place",
      sub: f.properties.address_line2 || "",
      pt: [f.properties.lat, f.properties.lon],
    }));
  }

  /* ---------- recent destinations ---------- */
  function addRecent(list, it, max = 5) {
    const r = (Array.isArray(list) ? list : []).filter((x) => x && x.label !== it.label);
    r.unshift({ label: it.label, sub: it.sub || "", pt: it.pt });
    return r.slice(0, max);
  }

  /* ---------- the verdict at the top of the results ---------- */
  const NO_ROUTE = {
    outside: "That spot is off the road map.",
    same: "Start and destination are at the same spot.",
    noroute: "No driving route was found between those points.",
    crash: "Something went wrong working out the route.",
  };
  const noRouteMessage = (err) => NO_ROUTE[err] || "No route.";

  // Everything the verdict, time bars and Google Maps button show for one result.
  function verdict(r, avoidRights) {
    if (r.error) {
      return {
        error: true, eyebrow: "No route", bigHtml: esc(noRouteMessage(r.error)), subHtml: esc(r.message || ""), fallbackHtml: null,
        barSafe: 0, barFast: 0, tSafe: "", tFast: "", goText: "No route to open", fine: "Pick a different start or destination to get a route.",
      };
    }
    const F = r.fastest, Sf = r.safer;
    const word = avoidRights ? ["risky turn", "risky turns"] : ["risky left", "risky lefts"];
    const nAvoid = r.pairs.reduce((n, p) => n + p.avoided.length, 0);
    const extra = Math.max(0, r.extra_min);
    const v = { error: false, fallbackHtml: null };
    if (r.decision === "safer") {
      v.eyebrow = "Safer route found";
      v.bigHtml = `<span class="plus">${extra < 0.5 ? "No extra time" : `+${Math.round(extra)} min`}</span> to skip ${plural(nAvoid, ...word)}`;
      const per = Math.round((extra * 60) / Math.max(1, nAvoid));
      v.subHtml = extra < 0.5
        ? `The fastest route makes ${plural(nAvoid, "turn", "turns")} across traffic with <b>no signal</b>. This one avoids ${nAvoid === 1 ? "it" : "them"} at about the same time.`
        : `The fastest route saves ${fmtMin(extra)} by turning across traffic at <b>${plural(nAvoid, "intersection", "intersections")} with no signal</b>. That is about <b>${per} seconds per risky turn</b>.`;
    } else if (r.decision === "too_far") {
      v.eyebrow = "Fastest route";
      v.bigHtml = esc(`${fmtMin(F.minutes)}, with ${plural(F.risky.length, ...word)}`);
      v.subHtml = esc(`The safer route would add ${fmtMin(extra)}, more than your limit, so this is the fastest route. The turns to watch are listed below.`);
      v.fallbackHtml = `<b>No safer route within ${esc(r.limits.max_detour_min)} min.</b> Opening the fastest route. Watch for the turns marked in red.`;
    } else if (r.decision === "already_safe") {
      v.eyebrow = "Good news";
      v.bigHtml = `The fastest route has no ${word[1]}`;
      v.subHtml = avoidRights
        ? "Every turn across or into busy traffic on this trip is at a signal already."
        : "Every left across busy traffic on this trip is at a signal already.";
    } else {
      v.eyebrow = "Fastest route";
      v.bigHtml = esc(`${fmtMin(F.minutes)}, with ${plural(F.risky.length, ...word)}`);
      v.subHtml = "No route found that makes fewer risky turns. The turns to watch are listed below.";
    }
    const maxT = Math.max(F.minutes, Sf.minutes) || 1;
    v.barSafe = (100 * Sf.minutes) / maxT;
    v.barFast = (100 * F.minutes) / maxT;
    v.tSafe = fmtMin(Sf.minutes);
    v.tFast = fmtMin(F.minutes);
    v.goText = r.chosen === "safer" ? "Open in Google Maps" : "Open fastest route in Google Maps";
    v.fine = r.chosen === "safer" && r.pins.length
      ? `Google Maps will announce ${plural(r.pins.length, "stop", "stops")}. Those are pinned signals to drive through, not places to stop.`
      : "Opens the route in Google Maps with no stops added.";
    return v;
  }

  /* ---------- turn lists ---------- */
  function turnRow(cls, icon, tag, turns, extraHtml) {
    return `<div class="row ${cls}"><div class="ic">${icon}</div><div><div class="tag">${tag}</div>${turns.map((t) => `<div class="what">${esc(t.text)}</div>${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ""}`).join("")}${extraHtml || ""}</div></div>`;
  }

  // The list under the map for the route on show ("safer" or "fastest"), and the legend.
  function turnList(r, view) {
    const pairView = view === "safer" && r.decision === "safer";
    const R = view === "safer" ? r.safer : r.fastest;
    let heading, html = "";
    if (pairView) {
      heading = "Turns this route skips";
      r.pairs.forEach((p, i) => {
        const sig = p.instead.filter((t) => t.signal && t.kind !== "straight");
        const instead = p.instead.length
          ? p.instead.map((t) => ({ ...t, detail: t.signal ? "At a traffic signal." : "" }))
          : [{ text: "A different street with no risky turn", detail: "" }];
        html += `<button class="pair" type="button" data-pair="${i}">` +
          turnRow("avoid struck", "!", "Fastest route would", p.avoided) +
          turnRow("instead", sig.length ? "✓" : "→", "Instead", instead,
            `<span class="lock${p.locked ? "" : " no"}">${p.locked ? "Locked in the Google Maps link" : "Likely, not locked: check Google's route here"}</span>`) +
          `</button>`;
      });
    } else {
      heading = R.risky.length ? (view === "fastest" ? "Risky turns on the fastest route" : "Turns to watch") : "No risky turns on this route";
      R.risky.forEach((t, i) => { html += `<button class="pair" type="button" data-risk="${i}">` + turnRow("avoid", "!", "On this route", [t]) + `</button>`; });
    }
    const still = view === "safer" ? r.still_risky : [];
    return {
      heading, html,
      stillHtml: still.length ? `<h3>Still on this route</h3>` + still.map((t) => `<div class="pair">${turnRow("still", "!", "Take care", [t])}</div>`).join("") : "",
      legend: { still: still.length > 0, signal: pairView, riskLabel: pairView ? "Risky turn skipped" : "Risky turn on this route" },
      stepsSummary: `All ${R.steps.length} turns on the ${view === "safer" ? "safer" : "fastest"} route`,
      stepsHtml: R.steps.map((t, i) => {
        const chip = t.risk ? `<span class="chip risk">No signal</span>` : t.signal ? `<span class="chip sig">Signal</span>` : t.junction ? `<span class="chip loc">No signal</span>` : `<span></span>`;
        return `<li><span class="n">${i + 1}</span><span>${esc(t.text)}</span>${chip}</li>`;
      }).join(""),
    };
  }

  // Map points to zoom to when a card in the list is tapped.
  function focusPoints(r, view, card) {
    if (card.pair != null) { const p = r.pairs[+card.pair]; return p ? [...p.avoided, ...p.instead.filter((t) => t.signal)].map((t) => t.at) : []; }
    if (card.risk != null) { const t = (view === "safer" ? r.safer : r.fastest).risky[+card.risk]; return t ? [t.at] : []; }
    return [];
  }

  const api = { esc, fmtMin, plural, parseLatLon, inBox, photonUrl, geoapifyUrl, photonResults, geoapifyResults, addRecent, noRouteMessage, verdict, turnRow, turnList, focusPoints };
  root.SaferUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
