# Build Brief: Continuity-First Parasocial Animal Tracker (Movebank API)

**Audience:** an autonomous coding agent (and the human reviewing its output).
**Status:** spec to execute against. Opinionated on purpose. Where it says MUST, treat it as a hard constraint, not a suggestion.

---

## 1. Why this exists (read before coding)

The "follow a real tracked animal" space is already built. Max Planck's *Animal Tracker* (free, research-framed) and *Fahlo* (commercial, bracelet-gated, >$5M donated) both exist on top of the same underlying infrastructure: Movebank.

They share one failure mode that nobody has fixed, and it is the entire reason this project exists:

> **The parasocial bond is only as durable as the tag battery.** When a tag stops transmitting — battery death, animal death, tag loss, signal gap — the followed animal silently goes dark. The emotional investment the product spent months building collapses, with no graceful handoff. Fahlo's own app-store reviews describe exactly this: users discovering all their tracked animals can no longer be tracked, and disengaging.

So the product thesis is **not** "show animal locations on a map." That is solved and commoditized. The thesis is:

**Engineer continuity of attachment across the discontinuity of the data.**

Everything below serves that. If a feature does not either (a) build individuated attachment, (b) survive tag-death gracefully, or (c) convert attachment into one concrete action, it is out of scope for v1.

### Psychological design constraints (these are requirements, not flavor)

These are grounded in established findings. The agent does not need to re-derive them; it needs to honor them in the UX and data model.

1. **Individuation over aggregation.** One named individual with a face and a continuous story outperforms any statistic about populations. Aggregation *destroys* the effect. The unit of the product is **one animal**, not a species or a dashboard. (Identifiable-victim effect; scope insensitivity.)
2. **Collapse psychological distance.** Make it present-tense, concrete, and as spatially/socially close to the user as the data allows. Prefer animals whose range overlaps or approaches the user's region. Avoid the maximally-distant "polar bear on distant ice" framing. (Construal-level theory.)
3. **Continuity across tag-death is the core feature, not an error state.** When data stops, the product MUST transition the relationship into a resolved narrative (see §5), never a broken map pin or a silent stall.
4. **Bridge feeling to one action.** Attachment that goes nowhere is wasted or worse (single-action licensing). At emotional high points, the product MUST offer exactly one concrete, consequential action — and the system MUST be able to measure whether attachment actually transfers to that action. Caring is not the success metric; the action is.
5. **Dynamic norms if reachable.** Where possible, surface the *trajectory* of others' engagement/action ("a growing number of people following Stork-7 have done X"), not static counts. (Sparkman & Walton.) This is a stretch goal for v1; design the data model so it is not precluded.

### Explicit non-goals for v1
- No species-level dashboards, no climate-stripe-style data viz, no "explain global warming with graphs." That is the information-deficit approach this whole project rejects.
- No hardware/bracelet. No commerce. No account wall for the core follow experience (lower friction = more reach; mirror Seek's no-account-needed posture).
- No attempt to track every animal. v1 curates a small, hand-validated roster (see §4).

---

## 2. Data source: Movebank — capabilities and hard constraints

Movebank is a free Max-Planck-run platform: ~3B location records, 1000+ species, near-real-time feeds from 20+ tag manufacturers. It is the right and only sensible backend. But its access model has sharp edges the agent MUST respect.

### 2.1 Two API surfaces
- **Public JSON service** (no login, for fully-public studies):
  `https://www.movebank.org/movebank/service/public/json?...`
  Originally designed precisely to display tracks on external maps. Use this as the default read path for public studies.
- **REST API v2** (token-based, richer):
  `https://api.movebank.org/v2/studies`
  `https://api.movebank.org/v2/study-ids/{STUDY_ID}/individuals`
  `https://api.movebank.org/v2/individuals/{INDIVIDUAL_ID}/locations?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&access_token=...`
  Returns JSON. Requires an account + access token. With credentials, results are scoped to what that account may see; without, scoped to fully-public data.

The agent should build a thin **MovebankClient** abstraction that can target either surface, so the product is not coupled to one.

### 2.2 Data model (the agent must internalize this)
- **Study** — owner-managed container. Has permissions, a license, a Study Type, and metadata. *Not all studies are public.*
- **Individual / deployment** — a specific animal, linked to a taxon (genus + species) and ideally reference data. **This is the product's atomic unit.**
- **Event / location** — timestamped fixes, plus sensor type (`gps`, `gnss`, `argos-doppler-shift`, etc.) and quality indicators.
- **Reference data** — per-animal metadata; sometimes names, sometimes photos. Often sparse — see §4.

### 2.3 Hard legal/operational constraints — DO NOT VIOLATE
- **Public ≠ reusable.** A study being viewable does not grant reuse rights. Each study sets its own **License Terms** on top of the **General Movebank Terms of Use**. The agent MUST surface and respect per-study license terms and attribution, and MUST NOT assume a blanket license.
- **License-acceptance flow.** Some studies require the caller to accept license terms before first download (the public service supports passing an MD5 hash of the accepted license terms). The client MUST implement this acceptance handshake rather than failing or scraping around it.
- **Data owners are people.** For anything beyond fully-public display, contact and credit the study PI. Build attribution in from day one (study name, PI, citation/DOI) — it is both required and good for trust.
- **Rate / load.** Cache aggressively (see §6). Do not hammer the live service for data that updates a few times a day at most.
- **Failure semantics.** Requesting data you lack permission for returns an explicit "no data available / contact owner" response. The client MUST distinguish *permission-denied* from *tag-went-quiet* — they look superficially similar (no points) but mean completely different things and drive different product behavior.

---

## 3. Architecture (suggested, not sacred)

```
[ Movebank public JSON / v2 REST ]
              │   (poll a few×/day, never realtime-spam)
              ▼
[ Ingestion worker ] ──► [ Datastore: studies, individuals, fixes, status ]
              │                         │
              │                         ▼
              │                 [ Continuity engine ]  ← the differentiator (§5)
              │                         │
              ▼                         ▼
[ Roster curation (§4) ]      [ Narrative generator (LLM) ]
                                        │
                                        ▼
                          [ API / app: one-animal follow view + action CTA ]
```

Stack is the agent's choice; code is cheap, so optimize for clarity and for making the continuity engine and narrative generator easy to test in isolation. Suggested defaults: a typed backend (TS or Python), a job scheduler for ingestion, a normal relational store, an LLM call boundary that is mockable. Keep the **continuity state machine** (§5) as a pure, unit-tested module — it is the heart of the product and must not be entangled with I/O.

---

## 4. Roster curation — the unglamorous part that determines success

The product is only as good as the individual animals it picks. Most Movebank individuals are **bad** product subjects: no name, no photo, sparse fixes, dead tag, or maximally distant species. The agent MUST build a **selection pipeline**, not just "fetch all individuals."

Selection criteria for a candidate individual (score and rank):
- **Public + permissively licensed** (or PI contact obtained). Hard gate.
- **Currently or recently transmitting** with a usable fix cadence (e.g. ≥ a few fixes/week). Hard gate for "live" roster.
- **Individuated potential:** has or can be given a name; ideally a reference photo or a representative species image. If no name exists, the product assigns a stable, respectful one (and labels it as assigned, not faked biography).
- **Distance-collapsing:** range overlaps or trends toward populated regions / the user's geography. Migratory birds (storks, ospreys, ibises) are strong because the journey itself is a narrative.
- **Narrative legibility:** movement that reads as a *story* (migration, homing, territory) beats a random-walk blob.

Deliverable: a curated roster table with provenance (study ID, PI, license, citation) for every animal shown. Start with **5–15 individuals**, hand-validated, not thousands.

> Honest note for the human: the binding constraint on this whole product is curation + licensing, not code. Budget real time here. A polished app over a roster of dead-tagged anonymous blobs fails.

---

## 5. The continuity engine (the actual differentiator — build this well)

A per-animal **state machine**. The product never shows a raw broken state; every state has a designed experience.

| State | Trigger | Product behavior |
|---|---|---|
| `LIVE` | recent fixes within expected cadence | normal follow view, story updates |
| `QUIET` | no fixes for > expected gap but < threshold | "resting / out of signal" framing; soft, hopeful, *not* alarm; keep engagement via past-journey recap |
| `RESOLVED_KNOWN` | owner/data indicates death, tag removal, study end | a designed *ending* to the story (see below) + the action bridge |
| `RESOLVED_UNKNOWN` | quiet beyond threshold, cause unknown | honest "we lost the signal" narrative closure + handoff to a successor animal |
| `PERMISSION_LOST` | API now denies data (≠ tag death) | quietly retire from roster; never surface as the animal "disappearing" |

Design rules:
- **Tag-death is a story beat, not a 404.** When an animal resolves, generate a respectful retrospective of its tracked journey (distance traveled, places, season survived) and *then* offer (a) the action and (b) an invitation to follow a successor. This is the exact moment Fahlo drops the user; capture it instead.
- **Honesty constraint:** never fabricate that an animal is alive/moving when data is absent. Do not invent biography. Narration may be warm and interpretive ("Stork-7 has paused near the river for three days") but MUST be grounded in actual fixes/metadata. Distinguish observed fact from framing.
- **Successor handoff:** maintain enough roster depth that any resolution can offer a thematically similar next animal, preserving the *relationship pattern* even when the individual ends.

---

## 6. Narrative generation

An LLM turns fix data + metadata into short, present-tense, individuated updates.

- **Grounding is mandatory.** The generator receives only real, current data (latest fixes, deltas, place names via reverse-geocode, season, study facts). It MUST NOT hallucinate events. Treat un-grounded biographical claims as bugs.
- **Tone:** concrete and warm, not anthropomorphic-saccharine and not data-dump. "Crossed the Strait of Gibraltar overnight — about 60 km since yesterday" beats both "Stork-7 felt brave today" and "lat 36.1, lon -5.3."
- **Cadence:** match the data. Don't manufacture daily drama from weekly fixes.
- **Cache** generated narratives keyed to the fix batch so you don't re-generate (cost + consistency).

---

## 7. The action bridge + measurement (do not skip — this is how you know it worked)

The product's success metric is **a behavior**, not a feeling. Pick the target behavior explicitly before launch. Options, by leverage:
- **High:** policy/petition action, recruiting another follower (diffusion), recurring support for the *specific* study/PI behind the animal.
- **Lower:** one-off donation, a personal consumption pledge.

Requirements:
- At emotional peaks (a milestone reached, a resolution), surface **exactly one** action. Not a menu. (Avoid choice overload and single-action licensing.)
- **Instrument the funnel:** follow → engagement depth → action taken. The system MUST be able to answer: *does attachment to an individual animal actually transfer to the target action, vs. produce warm feelings that go nowhere?* Assume it does NOT transfer until measured.
- **Ship an A/B harness from v1.** Minimum: individuated-narrative arm vs. plain-map arm, measured against the action. Code is cheap; running the experiment is the point. A polished untested product teaches you nothing.

---

## 8. Build order (milestones for the agent)

1. **MovebankClient** abstraction over public-JSON + v2-REST, with: auth/token handling, the license-acceptance handshake, and *correct* distinction between permission-denied and no-data. Unit-tested against recorded fixtures.
2. **Ingestion + datastore** for studies/individuals/fixes/status, polling a few×/day, caching.
3. **Roster curation pipeline + 5–15 hand-validated individuals** with full provenance/licensing. (Expect this to take longer than it looks.)
4. **Continuity state machine** as a pure, fully unit-tested module.
5. **Narrative generator** with hard grounding + cache.
6. **Single-animal follow UI** (one animal, present-tense, low friction, no account).
7. **Action bridge + funnel instrumentation + A/B harness.**
8. (Stretch) **Dynamic-norms surface** once enough follower-action data exists to show a real trajectory.

---

## 9. Open decisions for the human (resolve before/early, don't let the agent silently pick)

- **Target behavior** for the action bridge (§7) — this determines a lot downstream.
- **Geography:** global roster, or localized to the user's region to maximize distance-collapse? Localization is psychologically stronger but harder to source.
- **Licensing posture:** fully-public studies only (simpler, smaller roster) vs. PI outreach for richer/closer animals (better roster, real human-relationship overhead).
- **Relationship to existing players:** is this a standalone product, a contribution proposal to Max Planck's Animal Tracker (which is non-commercial and aligned), or a reference implementation others can fork? "Joining" beats "founding" if Animal Tracker will take the continuity engine as a contribution.

---

## 10. One-paragraph summary for the agent

Build a low-friction app where a user follows **one named, individuated, real wild animal** sourced from the Movebank API, receives grounded present-tense narrative updates about its journey, and — critically — when that animal's tag goes quiet or it dies, experiences a **designed narrative resolution and a graceful handoff to a successor**, never a broken map. At emotional peaks, offer exactly one consequential action and **measure whether attachment actually transfers to that action** via a built-in A/B test. Respect Movebank's per-study licenses and terms absolutely. The map is the commodity; the **continuity of attachment across data discontinuity** is the product.
