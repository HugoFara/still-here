// Still Here — follow-view client. Zero build, plain ES modules.
// No account: an anonymous session id (localStorage) determines the A/B arm.
// The journey map is a vendored Leaflet instance (window.L, loaded by a classic
// <script> in index.html — no npm dependency).

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

// --------------------------------------------------------------------------
// Data access — works both server-served AND as a static GitHub Pages export.
// In static mode (window.STATIC_EXPORT, set by the exported index.html) there is
// no server: the deterministic fixture payloads are pre-baked to JSON, the A/B
// arm is computed client-side, and the measurement POSTs are no-ops (the funnel
// needs a writable server-side store, which a static host cannot provide).
// --------------------------------------------------------------------------
const STATIC = typeof window !== "undefined" && window.STATIC_EXPORT === true;

// FNV-1a 32-bit — MUST stay identical to assignArm() in src/experiment/ab.ts so
// the client loads the arm-correct pre-baked payload.
function assignArm(sessionId, salt = "v1") {
  let h = 2166136261 >>> 0;
  const s = `${salt}:${sessionId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0 ? "narrative" : "map";
}

async function apiRoster() {
  return (await fetch(STATIC ? "api/roster.json" : "/api/roster")).json();
}

// Returns a Response in BOTH modes so callers can branch on res.ok uniformly.
function apiAnimal(id, sessionId, fromId) {
  if (STATIC) {
    const arm = assignArm(sessionId);
    const slug = fromId ? `${id}__from__${fromId}` : id;
    return fetch(`api/animal/${arm}/${slug}.json`);
  }
  const fromQ = fromId ? `&from=${encodeURIComponent(fromId)}` : "";
  return fetch(`/api/animal?id=${encodeURIComponent(id)}&session=${encodeURIComponent(sessionId)}${fromQ}`);
}

function apiPost(path, body) {
  if (STATIC) return Promise.resolve(null); // measurement is server-only
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiExperiment() {
  return (await fetch(STATIC ? "api/experiment.json" : "/api/experiment")).json();
}

const STATE_LABEL = {
  LIVE: "Live",
  QUIET: "Resting / out of signal",
  RESOLVED_KNOWN: "Journey complete",
  RESOLVED_UNKNOWN: "Signal lost",
};

// Per-species reference photo so a follower can recognise the animal at a glance.
// Each is a freely-licensed Wikimedia Commons image, VENDORED locally under img/
// (no hotlinking) and keyed by the taxon.commonName the API sends. These are
// illustrative of the SPECIES — not the individual tracked bird. CC BY / CC BY-SA
// require attribution, surfaced in the provenance block and listed in img/CREDITS.md.
const SPECIES_PHOTO = {
  "White Stork": {
    img: "img/white-stork.jpg",
    by: "Andreas Trepte",
    license: "CC BY-SA 2.5",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.5",
    source: "https://commons.wikimedia.org/wiki/File:White_Stork.jpg",
  },
  "European Turtle Dove": {
    img: "img/turtle-dove.jpg",
    by: "Charles J. Sharp",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
    source: "https://commons.wikimedia.org/wiki/File:Turtle_Dove_(Streptopelia_turtur)_Otmoor.jpg",
  },
  "European Honey Buzzard": {
    img: "img/honey-buzzard.jpg",
    by: "Andy Morffew",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0",
    source: "https://commons.wikimedia.org/wiki/File:Honey_Buzzard.jpg",
  },
  "Red Kite": {
    img: "img/red-kite.jpg",
    by: "Hansueli Krapf",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
    source:
      "https://commons.wikimedia.org/wiki/File:Milvus_milvus_(2011-04-17_Switzerland_Kanton_Schaffhausen_Gennersbrunn_2).jpg",
  },
};
const speciesPhoto = (species) => SPECIES_PHOTO[species] ?? null;

// --------------------------------------------------------------------------
// roster
// --------------------------------------------------------------------------

async function loadRoster() {
  const { roster } = await apiRoster();
  const ul = $("#roster-list");
  ul.innerHTML = "";
  for (const a of roster) {
    const li = document.createElement("li");
    const ph = speciesPhoto(a.species);
    const thumb = ph
      ? `<img class="rc-thumb" src="${esc(ph.img)}" alt="${esc(a.species)}" loading="lazy" width="48" height="48" />`
      : `<span class="rc-thumb rc-thumb--empty" aria-hidden="true"></span>`;
    li.innerHTML = `
      <button class="roster-card" data-id="${esc(a.id)}">
        ${thumb}
        <span class="rc-info">
          <span class="nm">${esc(a.name)}</span>
          <span class="sp">${esc(a.species)} · ${esc(a.latestPlace)}</span>
          <span class="meta">
            <span class="pill ${a.state}">${esc(STATE_LABEL[a.state] || a.state)}</span>
            <span class="sp">${a.totalKm.toLocaleString()} km</span>
          </span>
        </span>
      </button>`;
    li.querySelector("button").addEventListener("click", () => openAnimal(a.id));
    ul.appendChild(li);
  }
  // Open exactly one animal up front: the deep-linked ?animal= if valid, else the
  // first. (One open, not two — opening roster[0] AND a wanted animal races, and
  // with instant static file reads the wrong one can win.)
  const want = new URL(location.href).searchParams.get("animal");
  const initialId = want && roster.some((a) => a.id === want) ? want : roster[0]?.id;
  if (initialId) openAnimal(initialId);
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
    apiPost("/api/follow", {
      sessionId: session,
      individualId: id,
      ...(fromId ? { meta: { from: fromId } } : {}),
    });
  }

  const res = await apiAnimal(id, session, fromId);
  if (!res.ok) {
    $("#stage").innerHTML = `<div class="empty">This animal is no longer available.</div>`;
    return;
  }
  renderAnimal(await res.json());

  // Engagement-depth signal: a dwell of 6s counts as 'engage'.
  if (engageTimer) clearTimeout(engageTimer);
  engageTimer = setTimeout(() => {
    apiPost("/api/event", { sessionId: session, individualId: id, type: "engage" });
  }, 6000);
}

// --------------------------------------------------------------------------
// follow view (arm-aware)
// --------------------------------------------------------------------------

function renderAnimal(p) {
  const isNarrative = p.arm === "narrative";
  const j = p.journey;
  const stage = $("#stage");

  // Species portrait (illustrative, not the individual) — recognise the animal at a glance.
  const ph = speciesPhoto(p.animal.species);
  const heroImg = ph
    ? `<img class="hero-portrait" src="${esc(ph.img)}" alt="${esc(p.animal.species)}" width="96" height="96" />`
    : "";
  const photoCredit = ph
    ? `<br/>Species photo: <a href="${esc(ph.source)}" target="_blank" rel="noopener">${esc(
        p.animal.species,
      )}</a> © ${esc(ph.by)} · <a href="${esc(ph.licenseUrl)}" target="_blank" rel="noopener">${esc(
        ph.license,
      )}</a> (Wikimedia Commons) — illustrative of the species, not the tracked individual.`
    : "";

  // Only credit the live weather source when the journey actually drives a scrubber.
  const hasScrub = Array.isArray(j.times) && (j.points?.length ?? 0) >= 3;
  const condCredit = hasScrub
    ? `<br/>Local conditions: season derived from each fix's date &amp; hemisphere; daily-mean air temperature from <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> ERA5 reanalysis (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) at the fix's own place &amp; date — fetched live, not part of the tracking data.`
    : "";

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
      ${heroImg}
      <div class="hero-text">
        <div class="kicker">${kicker}</div>
        <h1>${title}</h1>
        ${assignedNote}
        <div class="ribbon"><span class="pill ${p.status.state}">${esc(STATE_LABEL[p.status.state] || p.status.state)}</span></div>
      </div>
    </div>
    <div class="map-wrap"><div id="journey-map"></div><div class="map-scrubber" id="map-scrubber"></div></div>
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
        ${photoCredit}
        ${condCredit}
      </div>
    </div>`;

  mountMap(j, p.status.state);
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
    apiPost("/api/event", {
      sessionId: session,
      individualId,
      type: "action_taken",
      meta: { reason: action.reason, target: action.targetIndividualId },
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
// Journey map — a real interactive Leaflet slippy map (pan/zoom), street +
// satellite layers, with the GPS track drawn as a polyline on top. Tiles are
// fetched from OpenStreetMap + Esri World Imagery at view time, so the map needs
// a network connection. Leaflet itself is vendored (window.L) — no npm dep.
// --------------------------------------------------------------------------

const TRACK_COLOR = { LIVE: "#4f6f52", QUIET: "#b07d2f" };
const trackColor = (state) => TRACK_COLOR[state] || "#5a6b73";

const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Fixes are UTC epoch ms; format in UTC so the calendar day never shifts.
function fmtDate(t) {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// Great-circle km between [lat, lon] pairs — for cumulative distance along the track.
function haversineKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --------------------------------------------------------------------------
// Local conditions for the scrubbed moment — an honest "what was it like there,
// then?" readout. Season is DERIVED from the fix's date + hemisphere (no data
// needed, no estimation). Temperature is REAL: ERA5 daily-mean 2 m air
// temperature via Open-Meteo's archive API, fetched live for the fix's OWN place
// and date. It is NOT part of the Movebank tracking data and is labelled as such;
// offline (or for dates the reanalysis hasn't filled yet) it degrades to "—".
// --------------------------------------------------------------------------
const SEASONS = [
  { name: "Winter", ico: "❄️" },
  { name: "Spring", ico: "🌱" },
  { name: "Summer", ico: "☀️" },
  { name: "Autumn", ico: "🍂" },
];
// Meteorological season from the fix's UTC month, flipped below the equator.
function seasonAt(time, lat) {
  const m = new Date(time).getUTCMonth();
  let idx = Math.floor(((m + 1) % 12) / 3); // 0 winter · 1 spring · 2 summer · 3 autumn
  if (lat < 0) idx = (idx + 2) % 4; // southern hemisphere is offset by two
  return { ...SEASONS[idx], hemi: lat >= 0 ? "N" : "S" };
}

const pad2 = (n) => String(n).padStart(2, "0");
const ymdUTC = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

// key (lat,lon rounded + date) -> °C number | null (known-missing) | Promise
// (in flight). Dedupes and caches, so scrubbing back and forth never re-hits the
// network for a cell already seen.
const tempCache = new Map();
function dailyMeanTempC(lat, lon, time) {
  const ymd = ymdUTC(time);
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${ymd}`;
  const hit = tempCache.get(key);
  if (hit !== undefined) return hit; // number | null | Promise
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(3)}` +
    `&longitude=${lon.toFixed(3)}&start_date=${ymd}&end_date=${ymd}` +
    `&daily=temperature_2m_mean&timezone=UTC`;
  const p = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const arr = j && j.daily && j.daily.temperature_2m_mean;
      const v = Array.isArray(arr) && typeof arr[0] === "number" ? arr[0] : null;
      tempCache.set(key, v);
      return v;
    })
    .catch(() => {
      tempCache.set(key, null);
      return null;
    });
  tempCache.set(key, p);
  return p;
}

let journeyMap = null; // current Leaflet instance — torn down before each remount
let scrubTimer = null; // play-animation interval — cleared on remount / pause

function mountMap(j, state) {
  const el = document.getElementById("journey-map");
  const scrub = document.getElementById("map-scrubber");
  // Stop any in-flight playback before tearing the old map down.
  if (scrubTimer) {
    clearInterval(scrubTimer);
    scrubTimer = null;
  }
  if (!el) return;
  if (scrub) scrub.innerHTML = "";

  // Leaflet refuses to re-init a container; always tear the old one down first.
  if (journeyMap) {
    journeyMap.remove();
    journeyMap = null;
  }
  if (!window.L) {
    el.innerHTML = `<div class="map-fallback">Map unavailable (Leaflet failed to load).</div>`;
    return;
  }

  const pts = j.points || [];
  if (pts.length === 0) {
    el.innerHTML = `<div class="map-fallback">No track yet.</div>`;
    return;
  }

  // Track points are [lon, lat]; Leaflet wants [lat, lon].
  const latlngs = pts.map((p) => [p[1], p[0]]);
  const times = j.times && j.times.length === latlngs.length ? j.times : null;
  const start = latlngs[0];
  const end = latlngs[latlngs.length - 1];
  const color = trackColor(state);

  const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  });
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
  );

  const map = L.map(el, { layers: [street], scrollWheelZoom: true, worldCopyJump: true });
  L.control.layers({ Street: street, Satellite: satellite }, null, { collapsed: false }).addTo(map);
  journeyMap = map;

  // The full route, drawn faint, with a brighter "travelled so far" overlay the
  // scrubber reveals. At rest the bright line covers the whole route (latest fix).
  const base = L.polyline(latlngs, {
    color,
    weight: 2.5,
    opacity: 0.3,
    lineJoin: "round",
    lineCap: "round",
  }).addTo(map);
  const progress = L.polyline(latlngs, {
    color,
    weight: 3.5,
    opacity: 0.95,
    lineJoin: "round",
    lineCap: "round",
  }).addTo(map);

  // Subtle GPS acquisition points — thinned to ~40 so inflections are visible
  // without crowding, each revealing its fix date on hover.
  if (times) {
    const dotStep = Math.max(1, Math.ceil(latlngs.length / 40));
    for (let i = dotStep; i < latlngs.length - 1; i += dotStep) {
      L.circleMarker(latlngs[i], {
        radius: 2.5,
        color: "#fff",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.6,
      })
        .addTo(map)
        .bindTooltip(fmtDate(times[i]), { direction: "top" });
    }
  }

  L.circleMarker(start, {
    radius: 5,
    color: "#fff",
    weight: 2,
    fillColor: "#7a6a4e",
    fillOpacity: 1,
  })
    .addTo(map)
    .bindTooltip(`Start${j.startPlace ? " · " + j.startPlace : ""}`, { direction: "top" });

  // End marker: a divIcon so LIVE tracks can carry a CSS pulse ring.
  const endIcon = L.divIcon({
    className: "end-marker",
    html: `<span class="end-dot ${state === "LIVE" ? "is-live" : ""}" style="--c:${color}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  const endMarker = L.marker(end, { icon: endIcon, keyboard: false }).addTo(map);
  const endLabel = j.landmarkCrossed || (j.latestPlace ? "Last fix · " + j.latestPlace : "Last fix");
  endMarker.bindTooltip(endLabel, {
    permanent: Boolean(j.landmarkCrossed),
    direction: "top",
    className: "landmark-tip",
    offset: [0, -6],
  });

  // The scrubber's moving position marker (non-interactive — the readout carries
  // the detail). Sits above everything so it's never hidden by the track.
  const posIcon = L.divIcon({
    className: "scrub-marker",
    html: `<span class="scrub-dot" style="--c:${color}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  const posMarker = L.marker(end, {
    icon: posIcon,
    keyboard: false,
    interactive: false,
    zIndexOffset: 1000,
  }).addTo(map);

  map.fitBounds(base.getBounds(), { padding: [28, 28], maxZoom: 11 });
  // The container was just inserted; ensure Leaflet measured it correctly.
  setTimeout(() => map && map.invalidateSize(), 0);

  mountScrubber(scrub, { latlngs, times, progress, posMarker });
}

// The time scrubber on a FIXED, uniform time axis. Dragging moves through real
// elapsed time — NOT through GPS-fix index. Fixes are unevenly spaced in time, so
// an index slider would deform time (a day of dense fixes and a week of sparse
// ones would occupy the same travel). Here the thumb maps linearly to time and
// the position is INTERPOLATED between the two bracketing fixes, so motion is
// smooth and honest. Month ticks make the scale legible; a local-conditions line
// names the season and (live) the ERA5 daily-mean temperature at the scrubbed
// place & date. Needs aligned timestamps and a few points; else the map stands alone.
const SCRUB_STEPS = 1000; // slider resolution over the [t0, tLast] interval
function mountScrubber(scrub, { latlngs, times, progress, posMarker }) {
  if (!scrub || !times || latlngs.length < 3) return;

  const last = latlngs.length - 1;
  const t0 = times[0];
  const tLast = times[last];
  const span = Math.max(1, tLast - t0);
  const cum = [0];
  for (let i = 1; i <= last; i++) cum[i] = cum[i - 1] + haversineKm(latlngs[i - 1], latlngs[i]);
  const totalDays = Math.max(1, Math.round(span / MS_PER_DAY));

  // Position + distance covered at an arbitrary instant: find the bracketing
  // fixes by binary search and lerp between them.
  const at = (time) => {
    const t = Math.max(t0, Math.min(tLast, time));
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const j = Math.min(lo, last - 1); // lower-bracket fix index
    const seg = times[j + 1] - times[j];
    const f = seg > 0 ? (t - times[j]) / seg : 0;
    const lat = latlngs[j][0] + (latlngs[j + 1][0] - latlngs[j][0]) * f;
    const lon = latlngs[j][1] + (latlngs[j + 1][1] - latlngs[j][1]) * f;
    const km = cum[j] + (cum[j + 1] - cum[j]) * f;
    return { j, latlng: [lat, lon], km, time: t };
  };

  scrub.innerHTML = `
    <button class="scrub-play" type="button" aria-label="Replay journey">▶</button>
    <div class="scrub-track">
      <input class="scrub-range" type="range" min="0" max="${SCRUB_STEPS}" value="${SCRUB_STEPS}" step="1"
             aria-label="Journey timeline (uniform time scale)" />
      <div class="scrub-axis"></div>
    </div>
    <div class="scrub-readout" aria-live="polite"></div>
    <div class="scrub-conditions"></div>`;
  const range = scrub.querySelector(".scrub-range");
  const readout = scrub.querySelector(".scrub-readout");
  const playBtn = scrub.querySelector(".scrub-play");
  const cond = scrub.querySelector(".scrub-conditions");
  buildAxis(scrub.querySelector(".scrub-axis"), t0, tLast, span);

  const seasonChip = (s) =>
    `<span class="cond"><span class="cond-ico">${s.ico}</span>` +
    `<span class="cond-txt"><strong>${s.name}</strong> · ${s.hemi}. hemisphere</span></span>`;
  const tempChip = (val) => {
    if (val === undefined) return `<span class="cond-ico">🌡️</span><span class="cond-src">fetching temperature…</span>`;
    if (val === null) return `<span class="cond-ico">🌡️</span><span class="cond-na">temperature unavailable</span>`;
    return (
      `<span class="cond-ico">🌡️</span><span class="cond-txt"><strong>~${Math.round(val)}°C</strong> daily mean</span>` +
      ` <span class="cond-src">ERA5</span>`
    );
  };

  // Season is synchronous; temperature is a network fetch, so it's DEBOUNCED —
  // a drag fires many input events, but only the settled cell hits the archive.
  let condReq = 0;
  let condTimer = null;
  const renderConditions = (latlng, time) => {
    const s = seasonAt(time, latlng[0]);
    const ymd = ymdUTC(time);
    const key = `${latlng[0].toFixed(2)},${latlng[1].toFixed(2)},${ymd}`;
    const cached = tempCache.get(key);
    const ready = typeof cached === "number" || cached === null;
    cond.innerHTML = seasonChip(s) + `<span class="cond cond-temp">${tempChip(ready ? cached : undefined)}</span>`;
    if (ready) return;
    const my = ++condReq;
    clearTimeout(condTimer);
    condTimer = setTimeout(() => {
      Promise.resolve(dailyMeanTempC(latlng[0], latlng[1], time)).then((val) => {
        if (my !== condReq) return; // a later scrub superseded this fetch
        const el = cond.querySelector(".cond-temp");
        if (el) el.innerHTML = tempChip(val);
      });
    }, 280);
  };

  const setFraction = (frac) => {
    const f = Math.max(0, Math.min(1, frac));
    const pos = at(t0 + f * span);
    posMarker.setLatLng(pos.latlng);
    progress.setLatLngs(latlngs.slice(0, pos.j + 1).concat([pos.latlng]));
    const dayN = Math.round((pos.time - t0) / MS_PER_DAY);
    readout.innerHTML = `<strong>${fmtDate(pos.time)}</strong> · ${Math.round(
      pos.km,
    ).toLocaleString()} km · day ${dayN}/${totalDays}`;
    renderConditions(pos.latlng, pos.time);
  };

  const stopPlay = () => {
    if (scrubTimer) {
      clearInterval(scrubTimer);
      scrubTimer = null;
    }
    playBtn.textContent = "▶";
    playBtn.classList.remove("is-playing");
  };
  const startPlay = () => {
    // Advance by a fixed time-step per frame, so playback speed is constant in
    // real time regardless of how the fixes are spaced.
    let v = Number(range.value) >= SCRUB_STEPS ? 0 : Number(range.value); // replay from start if at end
    const stepPerFrame = SCRUB_STEPS / 110; // ~110 frames ≈ 4.4 s end-to-end
    playBtn.textContent = "❚❚";
    playBtn.classList.add("is-playing");
    scrubTimer = setInterval(() => {
      v = Math.min(SCRUB_STEPS, v + stepPerFrame);
      range.value = String(Math.round(v));
      setFraction(v / SCRUB_STEPS);
      if (v >= SCRUB_STEPS) return stopPlay();
    }, 40);
  };

  range.addEventListener("input", () => {
    stopPlay();
    setFraction(Number(range.value) / SCRUB_STEPS);
  });
  playBtn.addEventListener("click", () => (scrubTimer ? stopPlay() : startPlay()));

  setFraction(1); // rest at the latest fix
}

// Month/year ticks on the scrubber, spaced by REAL elapsed time so the axis is
// uniform (equal pixels = equal time). Labels thin out on long tracks; the first
// tick of each year carries the year and a taller mark.
function buildAxis(axis, t0, tLast, span) {
  if (!axis) return;
  const ticks = [];
  const d0 = new Date(t0);
  let t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
  if (t < t0) t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1);
  while (t <= tLast) {
    const dd = new Date(t);
    ticks.push({ t, month: dd.getUTCMonth(), year: dd.getUTCFullYear() });
    t = Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, 1);
  }
  const stride = Math.ceil(ticks.length / 12) || 1; // keep labels legible (≤ ~12)
  axis.innerHTML = ticks
    .map((tk, i) => {
      const left = (100 * (tk.t - t0)) / span;
      const isYear = tk.month === 0;
      const labelled = i % stride === 0 || isYear; // never drop a year boundary
      const label = !labelled ? "" : isYear ? `${MONTHS[tk.month]} ’${String(tk.year).slice(2)}` : MONTHS[tk.month];
      return `<span class="scrub-tick${isYear ? " is-year" : ""}" style="left:${left.toFixed(2)}%">${esc(label)}</span>`;
    })
    .join("");
}

// --------------------------------------------------------------------------
// experiment dashboard
// --------------------------------------------------------------------------

async function loadExperiment() {
  const r = await apiExperiment();
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

// ?view=experiment opens the dashboard directly; ?animal=<id> pins the subject
// (loadRoster honors it as the initial open).
const params = new URL(location.href).searchParams;
if (params.get("view") === "experiment") switchView("experiment");
loadRoster();
