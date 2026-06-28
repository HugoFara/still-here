// Still Here — follow-view client. Zero build, plain ES modules.
// No account: an anonymous session id (localStorage) determines the A/B arm.

import { LAND } from "./basemap.generated.js";

const session = (() => {
  // ?session=… lets you deep-link / pin an A/B arm (handy for demos + testing).
  const override = new URL(location.href).searchParams.get("session");
  let s = override || localStorage.getItem("session");
  if (!s) s = (crypto.randomUUID && crypto.randomUUID()) || `s-${Date.now()}-${Math.random()}`;
  localStorage.setItem("session", s);
  return s;
})();

const followed = new Set(JSON.parse(localStorage.getItem("followed") || "[]"));
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const STATE_LABEL = {
  LIVE: "Live",
  QUIET: "Resting / out of signal",
  RESOLVED_KNOWN: "Journey complete",
  RESOLVED_UNKNOWN: "Signal lost",
};

// --------------------------------------------------------------------------
// roster
// --------------------------------------------------------------------------

async function loadRoster() {
  const { roster } = await (await fetch("/api/roster")).json();
  const ul = $("#roster-list");
  ul.innerHTML = "";
  for (const a of roster) {
    const li = document.createElement("li");
    li.innerHTML = `
      <button class="roster-card" data-id="${esc(a.id)}">
        <span class="nm">${esc(a.name)}</span>
        <span class="sp">${esc(a.species)} · ${esc(a.latestPlace)}</span>
        <span class="meta">
          <span class="pill ${a.state}">${esc(STATE_LABEL[a.state] || a.state)}</span>
          <span class="sp">${a.totalKm.toLocaleString()} km</span>
        </span>
      </button>`;
    li.querySelector("button").addEventListener("click", () => openAnimal(a.id));
    ul.appendChild(li);
  }
  if (roster[0]) openAnimal(roster[0].id);
}

let engageTimer = null;

// `fromId` is set only when this open is a successor handoff — it lets the
// server attribute the follow to the bridge and lets the view carry the thread.
async function openAnimal(id, fromId = null) {
  document.querySelectorAll(".roster-card").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.id === id),
  );

  if (!followed.has(id)) {
    followed.add(id);
    localStorage.setItem("followed", JSON.stringify([...followed]));
    fetch("/api/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session,
        individualId: id,
        ...(fromId ? { meta: { from: fromId } } : {}),
      }),
    });
  }

  const fromQ = fromId ? `&from=${encodeURIComponent(fromId)}` : "";
  const res = await fetch(
    `/api/animal?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}${fromQ}`,
  );
  if (!res.ok) {
    $("#stage").innerHTML = `<div class="empty">This animal is no longer available.</div>`;
    return;
  }
  renderAnimal(await res.json());

  // Engagement-depth signal: a dwell of 6s counts as 'engage'.
  if (engageTimer) clearTimeout(engageTimer);
  engageTimer = setTimeout(() => {
    fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session, individualId: id, type: "engage" }),
    });
  }, 6000);
}

// --------------------------------------------------------------------------
// follow view (arm-aware)
// --------------------------------------------------------------------------

function renderAnimal(p) {
  const isNarrative = p.arm === "narrative";
  const j = p.journey;
  const stage = $("#stage");

  const title = isNarrative ? esc(p.animal.name) : esc(p.animal.species);
  const kicker = isNarrative
    ? esc(p.animal.species)
    : `${esc(p.animal.localIdentifier)} · ${esc(p.provenance.studyName || "")}`;
  const assignedNote =
    isNarrative && p.animal.nameIsAssigned
      ? `<div class="assigned">name assigned by us — not from the study record</div>`
      : "";

  const story = isNarrative
    ? `<p class="narrative">${esc(p.narrative || "")}</p>`
    : `<div class="control-tag">control · plain map</div>
       <p class="control-line">Last fix: near ${esc(j.latestPlace || "unknown")}${
         p.status.gapDays != null ? `, ${Math.max(1, Math.round(p.status.gapDays))} day(s) ago` : ""
       }.</p>`;

  const asOf = j.latestFixAt ? new Date(j.latestFixAt).toISOString().slice(0, 10) : null;
  // Two honesty modes: a fabricated demo track vs. a REAL track whose study
  // provenance/license is not yet human-verified. Never conflate the two.
  let banner = "";
  if (p.provenance.dataIsSynthetic) {
    banner = `<div class="synthetic-banner">⚠︎ Demo data — this is a <strong>synthetic</strong> track (mechanism demonstrator). Not a real animal or position.</div>`;
  } else if (!p.provenance.verified) {
    banner = `<div class="unverified-banner">Real Movebank track${
      asOf ? `, snapshot as of ${asOf}` : ""
    } — a fixed snapshot, not a live position. Study provenance &amp; license are <strong>pending verification</strong> before publication.</div>`;
  }
  const synthetic = banner;

  // The thread carried forward: acknowledge the animal we were handed from, so a
  // handoff feels like continuation, not a fresh start (brief §5).
  const continued = p.continuedFrom
    ? `<div class="continued-banner">Continuing from <strong>${esc(p.continuedFrom.name)}</strong>'s journey — ${esc(p.continuedFrom.species)}.</div>`
    : "";

  stage.innerHTML = `
    ${continued}
    ${synthetic}
    <div class="hero">
      <div class="kicker">${kicker}</div>
      <h1>${title}</h1>
      ${assignedNote}
      <div class="ribbon"><span class="pill ${p.status.state}">${esc(STATE_LABEL[p.status.state] || p.status.state)}</span></div>
    </div>
    <div class="map-wrap">${renderMap(j, p.status.state)}</div>
    <div class="body">
      ${story}
      <div class="stats">
        <div class="stat"><div class="k">Distance tracked</div><div class="v">${j.totalKm.toLocaleString()} km</div></div>
        <div class="stat"><div class="k">Days followed</div><div class="v">${j.daysTracked}</div></div>
        <div class="stat"><div class="k">From</div><div class="v">${esc(j.startPlace || "—")}</div></div>
        <div class="stat"><div class="k">To</div><div class="v">${esc(j.latestPlace || "—")}</div></div>
      </div>
      <div id="action-slot"></div>
      <div id="successor-slot"></div>
      <div class="provenance">
        Source: ${esc(p.provenance.studyName)}${p.provenance.principalInvestigator ? " · PI: " + esc(p.provenance.principalInvestigator) : ""}<br/>
        License: ${esc(p.provenance.license)} · ${p.provenance.verified ? "verified" : "provenance unverified"}
        ${p.provenance.citation ? "<br/>Citation: " + esc(p.provenance.citation) : ""}
      </div>
    </div>`;

  if (p.action) renderAction(p.action, p.animal.id);
  if (p.successor) renderSuccessor(p.successor, p.animal.id, isNarrative);
}

function renderAction(action, individualId) {
  const slot = $("#action-slot");
  slot.innerHTML = `
    <div class="action">
      <h3>${esc(action.label)}</h3>
      <button class="cta">${action.reason === "resolution" ? "Carry the story forward" : "Invite a friend"}</button>
      <div class="share hidden">
        <div>Share this:</div>
        <textarea rows="3" readonly>${esc(action.shareText)}</textarea>
      </div>
    </div>`;
  const btn = slot.querySelector(".cta");
  btn.addEventListener("click", () => {
    fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session,
        individualId,
        type: "action_taken",
        meta: { reason: action.reason, target: action.targetIndividualId },
      }),
    });
    btn.disabled = true;
    btn.textContent = "Thank you — shared";
    slot.querySelector(".share").classList.remove("hidden");
    slot.querySelector("textarea").select();
  });
}

// The handoff. In the narrative arm this is the grounded bridge — *why* this
// successor preserves the relationship. The control arm gets the bare next-animal
// fact, so the experiment isolates whether the individuated continuity matters.
// `fromId` is the resolved animal we're handing off FROM — carried so the
// successor view can acknowledge the thread.
function renderSuccessor(s, fromId, isNarrative) {
  const slot = $("#successor-slot");
  const body = isNarrative
    ? `<div class="sp">When one journey ends, another is already moving.</div>
       <p class="bridge">${esc(s.bridge)}</p>`
    : `<div class="sp">Next live animal</div>
       <div class="nm">${esc(s.name)}</div>
       <div class="sp">${esc(s.species)}</div>`;
  slot.innerHTML = `
    <div class="successor">
      ${body}
      <button data-id="${esc(s.id)}">Follow ${esc(s.name)} →</button>
    </div>`;
  slot.querySelector("button").addEventListener("click", () => openAnimal(s.id, fromId));
}

// --------------------------------------------------------------------------
// SVG journey map (offline — coastlines + borders from a bundled Natural Earth
// basemap, projected with the SAME transform as the track so geography lines up)
// --------------------------------------------------------------------------

const SEA = "#dde3e3";

// Project the bundled land rings that fall inside the current window, with the
// same x()/y() as the track. Off-window rings are culled by their precomputed
// bbox; partially-visible ones are clipped by the SVG viewport. Returns one path.
function landLayer(x, y, win) {
  let d = "";
  for (const poly of LAND) {
    const b = poly.b; // [minLon, minLat, maxLon, maxLat]
    if (b[2] < win.minLon || b[0] > win.maxLon || b[3] < win.minLat || b[1] > win.maxLat) continue;
    const r = poly.r;
    for (let i = 0; i < r.length; i++) {
      d += (i ? "L" : "M") + x(r[i][0]).toFixed(1) + " " + y(r[i][1]).toFixed(1) + " ";
    }
    d += "Z ";
  }
  return d
    ? `<path d="${d}" fill="#e8e3d4" stroke="#c2bba8" stroke-width="0.6" stroke-linejoin="round"/>`
    : "";
}

function renderMap(j, state) {
  const pts = j.points;
  const W = 720, H = 300, pad = 28;
  if (!pts || pts.length === 0 || !j.bbox) {
    return `<svg viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${SEA}"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9a9282">no track</text></svg>`;
  }
  let { minLon, maxLon, minLat, maxLat } = j.bbox;
  const padLon = (maxLon - minLon) * 0.12 || 0.5;
  const padLat = (maxLat - minLat) * 0.12 || 0.5;
  minLon -= padLon; maxLon += padLon; minLat -= padLat; maxLat += padLat;
  const spanLon = maxLon - minLon || 1, spanLat = maxLat - minLat || 1;
  const x = (lon) => pad + ((lon - minLon) / spanLon) * (W - 2 * pad);
  const y = (lat) => pad + ((maxLat - lat) / spanLat) * (H - 2 * pad);

  const land = landLayer(x, y, { minLon, maxLon, minLat, maxLat });

  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(" ");
  const start = pts[0], end = pts[pts.length - 1];
  const stroke = state === "LIVE" ? "#4f6f52" : state === "QUIET" ? "#b07d2f" : "#5a6b73";
  const endPulse = state === "LIVE"
    ? `<circle cx="${x(end[0])}" cy="${y(end[1])}" r="9" fill="${stroke}" opacity="0.25"><animate attributeName="r" values="6;13;6" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite"/></circle>`
    : "";

  // Very faint graticule — a scale cue for zoomed-in inland tracks where no
  // coastline is in view.
  let grat = "";
  for (let k = 1; k < 4; k++) {
    const gx = pad + (k / 4) * (W - 2 * pad);
    const gy = pad + (k / 4) * (H - 2 * pad);
    grat += `<line x1="${gx}" y1="${pad}" x2="${gx}" y2="${H - pad}" stroke="#000" opacity="0.05"/>`;
    grat += `<line x1="${pad}" y1="${gy}" x2="${W - pad}" y2="${gy}" stroke="#000" opacity="0.05"/>`;
  }

  const landmark = j.landmarkCrossed
    ? `<text x="${x(end[0])}" y="${y(end[1]) - 14}" text-anchor="middle" font-size="12" fill="#3f3c34" stroke="#eef0e9" stroke-width="3" paint-order="stroke" font-weight="600">${esc(j.landmarkCrossed)}</text>`
    : "";

  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="journey map with coastlines">
      <rect x="0" y="0" width="${W}" height="${H}" fill="${SEA}"/>
      ${land}
      ${grat}
      <path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>
      <circle cx="${x(start[0])}" cy="${y(start[1])}" r="4.5" fill="#7a6a4e" stroke="#fff"/>
      ${endPulse}
      <circle cx="${x(end[0])}" cy="${y(end[1])}" r="5.5" fill="${stroke}" stroke="#fff"/>
      ${landmark}
    </svg>`;
}

// --------------------------------------------------------------------------
// experiment dashboard
// --------------------------------------------------------------------------

async function loadExperiment() {
  const r = await (await fetch("/api/experiment")).json();
  const el = $("#funnel");
  const stageRow = (label, value, max) => `
    <div class="bar">
      <div class="lab"><span>${label}</span><span>${value}</span></div>
      <div class="track"><div class="fill" style="width:${max ? (100 * value) / max : 0}%"></div></div>
    </div>`;
  const armCard = (a) => {
    const max = a.follow || 1;
    return `
      <div class="arm-card">
        <h3>${a.arm === "narrative" ? "Individuated narrative" : "Plain map (control)"}</h3>
        ${stageRow("Followed", a.follow, max)}
        ${stageRow("Viewed", a.view, max)}
        ${stageRow("Engaged", a.engage, max)}
        ${stageRow("Action shown", a.action_shown, max)}
        ${stageRow("Action taken", a.action_taken, max)}
        <div class="lab" style="margin-top:.6rem;display:flex;justify-content:space-between"><span>follow → action</span><span>${(100 * a.followToAction).toFixed(1)}%</span></div>
      </div>`;
  };
  const lift = r.narrativeLiftVsMap;
  el.innerHTML = `
    <div class="funnel-grid">${r.arms.map(armCard).join("")}</div>
    <div class="lift">Narrative lift vs. control:
      <span class="num">${lift == null ? "—" : lift.toFixed(2) + "×"}</span></div>
    <p class="sp">${esc(r.note || "")}</p>`;
}

// --------------------------------------------------------------------------
// nav
// --------------------------------------------------------------------------

$("#nav-follow").addEventListener("click", () => switchView("follow"));
$("#nav-experiment").addEventListener("click", () => switchView("experiment"));
function switchView(which) {
  $("#nav-follow").classList.toggle("is-active", which === "follow");
  $("#nav-experiment").classList.toggle("is-active", which === "experiment");
  $("#view-follow").classList.toggle("hidden", which !== "follow");
  $("#view-experiment").classList.toggle("hidden", which !== "experiment");
  if (which === "experiment") loadExperiment();
}

// ?view=experiment opens the dashboard directly; ?animal=<id> pins the subject.
const params = new URL(location.href).searchParams;
if (params.get("view") === "experiment") switchView("experiment");
const wantAnimal = params.get("animal");
loadRoster().then(() => {
  if (wantAnimal) openAnimal(wantAnimal);
});
