// Visual-regression helper: capture the follow UI in both A/B arms with Playwright.
//
// Prereqs: a running server with a seeded roster —
//     npm run seed && npm start        (in another terminal)
// then:
//     npm run shots                    # writes PNGs to ./screenshots
//     npm run shots stork-noe kite-aare   # capture specific animals instead
//
// Env: SHOTS_BASE (default http://localhost:8787), SHOTS_DIR (default ./screenshots).
// Playwright is a devDependency; the Chromium binary lives in ~/.cache (not the repo).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.SHOTS_BASE ?? "http://localhost:8787";
const DIR = process.env.SHOTS_DIR ?? "screenshots";

// Default tour: a resolution (bridge + handoff thread) and a long migration (to
// show the Leaflet basemap at flyway scale).
const DEFAULT_ANIMALS = ["stork-europa", "buzzard-pilgrim"];

// The journey map uses online tiles (OSM/Esri); give them a beat to paint before
// the screenshot so the basemap isn't a grey void.
const TILE_SETTLE_MS = 1800;

async function reachable() {
  try {
    const r = await fetch(`${BASE}/api/roster`);
    return r.ok;
  } catch {
    return false;
  }
}

/** A session id that lands in each A/B arm (the arm is derived server-side). */
async function findArms() {
  const out = {};
  for (let i = 0; i < 80 && (!out.narrative || !out.map); i++) {
    const s = `shots-${i}`;
    const p = await (await fetch(`${BASE}/api/animal?id=stork-europa&session=${s}`)).json();
    out[p.arm] ??= s;
  }
  if (!out.narrative || !out.map) throw new Error("could not find both A/B arms");
  return out;
}

async function main() {
  if (!(await reachable())) {
    console.error(`No server at ${BASE}. Start one first:\n  npm run seed && npm start`);
    process.exit(1);
  }
  await mkdir(DIR, { recursive: true });
  const animals = process.argv.slice(2);
  const arms = await findArms();
  const shots = [];

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1120, height: 1500 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  const shoot = async (file, sel) => {
    if (sel) await page.waitForSelector(sel, { timeout: 10000 });
    const path = `${DIR}/${file}`;
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    console.error(`  ✓ ${path}`);
  };

  if (animals.length === 0) {
    // Curated default tour.
    console.error("narrative arm:");
    await page.goto(`${BASE}/?session=${arms.narrative}&animal=stork-europa`, { waitUntil: "networkidle" });
    await shoot("01-narrative-europa.png", ".successor .bridge");
    console.error("  bridge:", (await page.textContent(".successor .bridge")).trim());

    await page.click(".successor button");
    await shoot("02-narrative-louis-continued.png", ".continued-banner");

    await page.goto(`${BASE}/?session=${arms.narrative}&animal=buzzard-pilgrim`, { waitUntil: "networkidle" });
    await page.waitForSelector(".leaflet-container", { timeout: 10000 });
    await page.waitForTimeout(TILE_SETTLE_MS);
    await shoot("03-narrative-pilgrim-migration.png");

    console.error("control (map) arm:");
    await page.goto(`${BASE}/?session=${arms.map}&animal=stork-europa`, { waitUntil: "networkidle" });
    await shoot("04-control-europa.png", ".successor");
  } else {
    for (const id of animals) {
      await page.goto(`${BASE}/?session=${arms.narrative}&animal=${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
      await page.waitForSelector(".leaflet-container", { timeout: 10000 });
      await page.waitForTimeout(TILE_SETTLE_MS);
      await shoot(`${id}.png`);
    }
  }

  await browser.close();
  console.error(`\n${shots.length} screenshot(s) in ${DIR}/`);
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
