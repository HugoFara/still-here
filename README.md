# Still Here — a continuity-first parasocial animal tracker

> Engineer **continuity of attachment across the discontinuity of the data.**
> The map is the commodity; staying with the user when the signal stops is the product.

A low-friction app where a person follows **one named, individuated, real wild animal**
sourced from [Movebank](https://www.movebank.org), receives grounded present-tense
narrative updates about its journey, and — when the tag goes quiet or the animal dies —
experiences a **designed narrative resolution and a graceful handoff to a successor**,
never a broken map pin. At emotional peaks it offers exactly **one** consequential action
and **measures whether attachment actually transfers to that action** via a built-in A/B test.

This repo implements the [build brief](./movebank-parasocial-drief.md) as a runnable
vertical slice. The **runtime is zero-dependency**: everything runs on the Node ≥ 24
standard library (native TypeScript, `node:sqlite`, `node:test`, the built-in HTTP server,
global `fetch`) with no install. `npm install` pulls only **dev-only** tooling
(`typescript` + `@types/node`) for the optional `npm run typecheck` gate.

---

## Decisions taken (brief §9)

| Decision | Choice |
|---|---|
| Scope | Full vertical slice, milestones 1–7, runnable end-to-end (real API behind fixtures, LLM mocked) |
| Geography | **Europe-focused** — migratory birds whose ranges sweep past a Geneva user |
| Target behavior | **Recruit-a-follower (diffusion)** — measurable in-app, drives reach, feeds the dynamic-norms stretch goal |
| Licensing posture | **Fully-public studies only**; per-study license + attribution surfaced and respected |

---

## Quick start

```bash
# 1. Seed the curated roster + run ingestion once (offline, deterministic)
npm run seed

# 2. Start the follow app
npm start
# → open http://localhost:8787

# other commands
npm test          # 65 unit/integration tests (all pure modules + client fixtures)
npm run typecheck # tsc --noEmit (strict); dev-only deps
npm run curate    # print the ranked curation report with provenance (§4 deliverable)
npm run ingest    # re-run ingestion against existing fixtures (a few×/day in prod)
npm run live:check # read a real fully-public Movebank study through the live client
```

The offline demo's clock is anchored to the snapshot instant (2026-06-26), so the
real tracks' five continuity states stay stable and honest; `MOVEBANK_MODE=live`
uses the real clock and reads live positions.

---

## What you'll see

A roster of seven **real, named** European individuals — drawn from fully-public
Movebank studies and chosen so their genuine last-fix recency exercises **every**
continuity state — plus one synthetic demonstrator for the one state that cannot
be sourced from public data:

| Animal | Species | Source study | State (from real recency) |
|---|---|---|---|
| **Louis** | White Stork | LifeTrack SW Germany · `21231406` | `LIVE` — back on the Upper Rhine after wintering in Catalonia |
| **Noé** | White Stork | LifeTrack Sarralbe · `1562253659` | `LIVE` — breeding in NE France; winters in Iberia |
| **Mistral**¹ | European Turtle Dove | Habitrack · `3413045568` | `LIVE` — Menorca-tagged, now in the **Rhône valley** (nearest Geneva) |
| **Pilgrim**¹ | European Honey Buzzard | NABU Mössingen · `186178781` | `LIVE` — long-distance Afro-Palearctic migrant |
| **Rosel** | White Stork | MPIAB ELSA 2.0 · `3883692006` | `QUIET` — genuinely silent ~14 days; framed as resting, not alarm |
| **Europa** | White Stork | LifeTrack SW Germany · `21231406` | `RESOLVED_UNKNOWN` — signal stopped 64 days ago; honest closure |
| **Aare**¹ | Red Kite | Milvus atlantis · `672882373` | `RESOLVED_KNOWN` — Swiss deployment ended 2022; designed ending + successor |
| **Pip** | _synthetic demo_ | — | `PERMISSION_LOST` — access revoked; **retires silently**, never shown as "disappeared" |

¹ Name **assigned by us** (no personal name in the study record) and labelled as such in the UI.

> ⚠︎ **Honesty.** Every track above except **Pip** is a **real, unmodified Movebank
> snapshot** of a named individual from a fully-public study (license terms suspended),
> captured 2026-06-26 and downsampled for the offline build (`src/roster/real-tracks.generated.ts`;
> live ingestion reads full resolution). Their continuity states are **not engineered** — they
> fall out of each bird's real last-fix recency. But `provenance.verified` is still **false**:
> the exact license, PI and citation must be confirmed on each study's Movebank page before any
> of them is published as vetted — the binding human step (see "Going live"). The UI shows a
> "provenance pending verification" banner accordingly, kept **distinct** from the synthetic
> warning. **Pip** is the lone synthetic entry: a public study cannot revoke your access, so the
> PERMISSION_LOST mechanism (denial ≠ tag death, §2.3) cannot be sourced from real public data.

---

## Architecture

```
[ Movebank public-JSON / v2-REST ]      ← MovebankClient (fixture | live transport)
            │  poll a few×/day
            ▼
[ Ingestion worker ] → [ SQLite store: studies, individuals, fixes, status, events ]
            │                    │
            │                    ▼
            │            [ Continuity engine ]  ← pure, fully unit-tested (the differentiator)
            │                    │
            ▼                    ▼
[ Roster curation (scoring) ]   [ Narrative generator ] ← grounded packet → mock | Anthropic LLM
                                     │
                                     ▼
                  [ HTTP API + follow UI ]  ← one-animal view, A/B arms, action bridge + funnel
```

Layout:

```
src/
  domain/        types.ts · continuity.ts (state machine) · geo.ts · places.ts (gazetteer) · geocode.ts (Geocoder seam)
  movebank/      client.ts · transport.ts · errors.ts · types.ts · live-check.ts
  store/         repository.ts (interface) · sqlite-store.ts · async-repository.ts · postgres-store.ts
  roster/        scoring.ts · seed.ts (REAL roster) · real-tracks.generated.ts · track-builder.ts · successor.ts · report.ts
  narrative/     grounding.ts (pure) · generator.ts (cache + provider)
  llm/           provider.ts (MockLLMProvider | AnthropicLLMProvider)
  experiment/    ab.ts (assignment · action bridge · funnel)
  ingestion/     worker.ts · seed-runner.ts · run.ts · scheduler.ts
  server/        app.ts (HTTP) · roster-service.ts
  web/           index.html · styles.css · app.js (the follow UI)
test/            *.test.ts (continuity, client, store, scoring, narrative, ingestion, ab,
                 real-shape, geocode, postgres)
fixtures/        recorded Movebank responses (incl. fixtures/movebank/real/ from the live API)
```

The **continuity state machine** (`src/domain/continuity.ts`) is pure — no I/O, no clock
access; the caller injects `now` and grounded inputs. It is the heart of the product and
the most heavily tested module.

---

## The continuity engine (brief §5)

`computeStatus(input)` is total and deterministic. Priority order (highest first):

1. `PERMISSION_LOST` — the API now denies data. **Orthogonal to tag silence** and wins
   over everything → retire silently. *This is the §2.3 invariant: permission-denied is
   never conflated with a quiet tag.*
2. `RESOLVED_KNOWN` — owner/data says death · tag-removed · study-ended.
3. gap-based: `LIVE` (within cadence) → `QUIET` (past cadence, still hopeful) →
   `RESOLVED_UNKNOWN` (beyond the lost threshold).

Every state emits **directives** (framing, tone, whether to show the action, whether to
offer a successor, whether to retire). The invariant `alarm: false` holds across all
states and is asserted in tests — a quiet tag is "resting / out of signal", never an error.

---

## Honesty / grounding (brief §6)

The narrative generator can only speak facts present in a **grounding packet**
(`src/narrative/grounding.ts`) built purely from real fixes + status + metadata. A test
asserts the packet exposes only whitelisted fields — there is no channel for un-grounded
biography. The default provider is a deterministic, fully-grounded template renderer
(`MockLLMProvider`), so the offline slice produces honest prose with no API and no
hallucination. Set `NARRATIVE_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` to use a real
model under a system prompt that forbids inventing anything outside the packet. Narratives
are cached keyed to the fix batch (cost + consistency).

---

## The action bridge + A/B harness (brief §7)

Success is a **behavior, not a feeling**. At emotional peaks (a landmark crossed, or a
resolution) the product surfaces **exactly one** action — recruit a follower (or hand off
to a successor). The control arm sees a **plain map** with no individuated narrative; the
treatment arm sees the full individuated story. Both arms get the same action so the
experiment isolates individuation.

`GET /api/experiment` (and the **Experiment** tab in the UI) reports the funnel
`follow → view → engage → action_shown → action_taken` per arm, plus the narrative arm's
**lift** over the control on `follow → action`. The seeded traffic is constructed with
*equal* conversion across arms (lift ≈ 1.0) — the demo shows the **instrument**, not a
fabricated win. **Assume attachment does NOT transfer to the action until the lift is real.**

---

## Validated against live Movebank (2026-06-27)

The live read path is proven end-to-end, not just mocked:

```bash
npm run live:check          # reads a real fully-public study through the real client
# → Parsed 16028 fixes through the real client.  (study 2911040, Galapagos Albatrosses)
```

What this established and hard-wired:

- The **public JSON service requires `sensor_type`** — omitting it returns HTTP 500, *not*
  an empty result. `LiveTransport` now always sends it (default `gps`).
- The real location shape is `{ individuals: [ { individual_local_identifier,
  individual_taxon_canonical_name, locations: [ { timestamp (ms), location_long,
  location_lat } ] } ] }` — exactly what the normalizer targets. A trimmed real response is
  checked in at `fixtures/movebank/real/` with a regression test (`test/real-shape.test.ts`)
  so contract drift is caught.
- Study **listing / `direct-read` require auth** (HTTP 401 without a token) — confirming the
  §2.3 model: enumerating public studies is the human/credentialed step, not an open API.

### The roster is real (wired from live Movebank)

The `?entity_type=study` endpoint *does* return a tokenless directory of the **164
fully-public studies** (`suspend_license_terms=true`). We filtered it to European
birds, **read live fixes** to confirm taxon / recency / geography, and selected the
seven named individuals above. Their downsampled tracks are committed in
`src/roster/real-tracks.generated.ts` (regenerate with `node scripts/capture-real-roster.mjs`).

- `npm run seed` builds the roster from that real snapshot offline (deterministic).
- `MOVEBANK_MODE=live npm run ingest` re-reads them from the **live** public service
  end to end — proven: e.g. *Mistral* +31k, *Pilgrim* +49k real fixes pulled.
- Two facts this surfaced and hardened: (a) a single individual can return **>500k**
  fixes, so `normalizeFixes` pushes in a loop (spreading overflowed the arg stack) and
  live reads are **bounded** to `MOVEBANK_LOOKBACK_DAYS` (default 120); (b) the demo
  clock is anchored to the capture instant so a frozen snapshot stays honest.

## Going live (what to swap)

- **Data**: set `MOVEBANK_MODE=live`. Public studies read with no token via the public JSON
  service (validated above); the v2-REST surface and study enumeration need a free Movebank
  account + token. The client already implements the license-acceptance handshake and the
  permission-denied vs no-data distinction.
- **Verify provenance (the one binding human step)**: the roster is already real (above),
  but `provenance.verified` is `false`. For each study, open its Movebank page, confirm the
  exact license + PI + citation/DOI, fill them into `realProvenance()` in `src/roster/seed.ts`,
  and flip `verified = true`. `npm run curate` ranks the candidates and prints exactly what
  needs confirming. Owner resolutions (death/tag-removed/study-end) should come from real
  deployment + mortality reference data via a metadata sync into `repo.setResolution` —
  the one we apply to the Swiss kite (`study-ended`) is an honest placeholder pending that.
- **Source the missing species**: the fully-public live set is stork-heavy. There is currently
  **no** fully-public Northern Bald Ibis or live European osprey, so those families (and the
  "over Lake Geneva" flagship) need either a licensed study (a human license-acceptance step)
  or a different fully-public source.
- **Places**: a `Geocoder` seam exists (`src/domain/geocode.ts`) — `GazetteerGeocoder`
  (offline default) and `NominatimGeocoder` (live OSM reverse-geocode, cached + UA per the
  usage policy). In production, resolve names during ingestion so grounding stays pure.
- **Narrative**: flip to the Anthropic provider (`NARRATIVE_PROVIDER=anthropic`).
- **Scheduling**: `npm run schedule` runs the ingestion loop in-process
  (`INGEST_INTERVAL_MIN`, default 6h, graceful shutdown); or point a real cron / k8s CronJob
  at `npm run ingest`.
- **Store**: `SqliteRepository` (sync) implements `Repository`. For Postgres, an
  `AsyncRepository` seam + `PostgresRepository` (`src/store/postgres-store.ts`, driver-agnostic
  via an injected `SqlClient`; no hard `pg` dependency) are provided and unit-tested against a
  fake client; `toAsync()` lets the sqlite store satisfy the same async interface. Wire a real
  `pg` Pool + run the DDL to go live.

---

## Stretch (brief §8.8)

Dynamic norms ("a growing number of people following Aila have invited a friend") are not
precluded: the funnel already records per-arm trajectories over time, so the surface can
be added once real follower-action data accumulates.
