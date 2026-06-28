/**
 * The LLM boundary (brief §3, §6): a small, mockable interface so the narrative
 * generator can be tested in isolation and so the real model is one swap away.
 *
 * Every provider receives ONLY a {@link GroundingPacket} of real facts. The mock
 * provider (default) renders deterministic, fully-grounded prose from templates —
 * so the offline slice produces honest narrative with no API and no fabrication.
 * The Anthropic provider sends the same packet to a real model under a system
 * prompt that forbids inventing anything not in the packet.
 */

import type { GroundingPacket } from "../narrative/grounding.ts";

export interface LLMProvider {
  readonly id: string;
  generate(packet: GroundingPacket): Promise<string>;
}

// ---------------------------------------------------------------------------
// formatting helpers (shared)
// ---------------------------------------------------------------------------

function roundKm(km: number): number {
  if (km < 10) return Math.round(km);
  if (km < 100) return Math.round(km / 5) * 5;
  return Math.round(km / 10) * 10;
}

function pronouns(sex: GroundingPacket["sex"]): { subj: string; obj: string; poss: string } {
  if (sex === "f") return { subj: "she", obj: "her", poss: "her" };
  if (sex === "m") return { subj: "he", obj: "him", poss: "his" };
  return { subj: "they", obj: "them", poss: "their" };
}

/** Subject-verb agreement: singular "he/she" vs. singular-"they" (plural verb).
 *  Most real Movebank individuals have no recorded sex, so "they" is common. */
function agree(sex: GroundingPacket["sex"], singular: string, plural: string): string {
  return sex === "unknown" ? plural : singular;
}

function placePhrase(p: GroundingPacket["latestPlace"]): string {
  if (!p) return "an unknown location";
  const where = p.near ? `near ${p.place.name}` : `in ${p.place.region}`;
  return where;
}

// ---------------------------------------------------------------------------
// Mock provider — deterministic, grounded template renderer (the default).
// ---------------------------------------------------------------------------

export class MockLLMProvider implements LLMProvider {
  readonly id = "mock";

  async generate(p: GroundingPacket): Promise<string> {
    switch (p.kind) {
      case "update":
        return this.update(p);
      case "recap":
        return this.recap(p);
      case "resolution":
        return this.resolution(p);
    }
  }

  private update(p: GroundingPacket): string {
    const parts: string[] = [];
    parts.push(`${p.name} is ${placePhrase(p.latestPlace)}.`);
    if (p.lastLegKm !== null && p.lastLegKm >= 1 && p.direction) {
      const span =
        p.lastLegHours !== null && p.lastLegHours <= 36 ? "since yesterday" : "on the latest leg";
      parts.push(`About ${roundKm(p.lastLegKm)} km ${p.direction} ${span}.`);
    } else {
      parts.push(`${pronouns(p.sex).subj} ${agree(p.sex, "has", "have")} stayed put since the last fix.`);
    }
    if (p.landmarkCrossed) {
      parts.push(`${pronouns(p.sex).subj} recently passed ${p.landmarkCrossed}.`);
    }
    if (p.startPlace && p.totalTrackKm > 50) {
      parts.push(`That's ${roundKm(p.totalTrackKm)} km tracked since ${p.startPlace.place.name}.`);
    }
    return capitalizeJoin(parts);
  }

  private recap(p: GroundingPacket): string {
    const pr = pronouns(p.sex);
    const days = p.gapDays !== null ? Math.max(1, Math.round(p.gapDays)) : null;
    const parts: string[] = [];
    parts.push(
      days
        ? `${p.name} has been quiet ${placePhrase(p.latestPlace)} for ${days} day${days === 1 ? "" : "s"} — most likely resting or briefly out of signal.`
        : `${p.name} is quiet ${placePhrase(p.latestPlace)} for now.`,
    );
    if (p.startPlace && p.daysTracked >= 1) {
      parts.push(
        `Over ${Math.round(p.daysTracked)} days we've followed ${pr.obj} ${roundKm(p.totalTrackKm)} km from ${p.startPlace.place.name}.`,
      );
    }
    parts.push(`We'll keep the place warm until ${pr.subj} ${agree(p.sex, "checks", "check")} back in.`);
    return capitalizeJoin(parts);
  }

  private resolution(p: GroundingPacket): string {
    const pr = pronouns(p.sex);
    const parts: string[] = [];
    if (p.state === "RESOLVED_KNOWN") {
      const note = p.ownerResolution?.note ? ` ${p.ownerResolution.note}` : "";
      parts.push(`${p.name}'s journey with us has reached its end.${note}`);
    } else {
      const days = p.gapDays !== null ? Math.round(p.gapDays) : null;
      parts.push(
        days
          ? `We've lost ${p.name}'s signal — the last fix came ${days} days ago ${placePhrase(p.latestPlace)}, and we won't pretend to know what came next.`
          : `We've lost ${p.name}'s signal, and we won't pretend to know what came next.`,
      );
    }
    if (p.startPlace && p.latestPlace && p.daysTracked >= 1) {
      const landmark = p.landmarkCrossed ? `, by way of ${p.landmarkCrossed},` : "";
      parts.push(
        `Across ${Math.round(p.daysTracked)} days ${pr.subj} travelled ${roundKm(p.totalTrackKm)} km${landmark} from ${p.startPlace.place.name} to ${p.latestPlace.place.name}.`,
      );
    }
    parts.push(`Thank you for following ${pr.obj}.`);
    return capitalizeJoin(parts);
  }
}

function capitalizeJoin(parts: string[]): string {
  return parts
    .filter((s) => s.trim().length > 0)
    .map((s) => {
      const t = s.trim();
      return t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Anthropic provider — real model, optional. Same packet, grounding-enforced.
// ---------------------------------------------------------------------------

const GROUNDING_SYSTEM = `You write a single short update about ONE individual tracked wild animal for people who follow it.
You are given a JSON "grounding packet" of REAL, current facts. Use ONLY facts present in the packet.
Hard rules:
- Never invent events, emotions, motives, biography, places, or numbers. If a field is null, do not mention it.
- No coordinates. No species-level lecturing. No saccharine anthropomorphism.
- Warm, concrete, present-tense for updates; respectful past-tense for resolutions.
- 2-3 sentences. Distinguish observed fact from gentle framing.
- For QUIET, frame as resting/out-of-signal, never alarm.
Return only the update text.`;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = "anthropic";
  private readonly opts: AnthropicOptions;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generate(packet: GroundingPacket): Promise<string> {
    const kindHint =
      packet.kind === "resolution"
        ? "Write a respectful closing retrospective."
        : packet.kind === "recap"
          ? "The animal is quiet; reassure and recap the journey so far."
          : "Write a present-tense movement update.";
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 200,
        system: GROUNDING_SYSTEM,
        messages: [
          {
            role: "user",
            content: `${kindHint}\n\nGrounding packet (only source of truth):\n${JSON.stringify(packet, null, 2)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim();
    if (!text) throw new Error("Anthropic API returned no text");
    return text;
  }
}
