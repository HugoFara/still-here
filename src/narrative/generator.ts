/**
 * Narrative generator (brief §6). Orchestrates: build grounding packet → check
 * cache (keyed to the fix batch) → call provider → store. The honesty constraint
 * lives upstream in grounding.ts; this module only adds caching and provider
 * selection.
 */

import {
  AnthropicLLMProvider,
  MockLLMProvider,
  type LLMProvider,
} from "../llm/provider.ts";
import {
  buildGroundingPacket,
  cacheKeyFor,
  type GroundingContext,
  type GroundingPacket,
} from "./grounding.ts";
import type { Config } from "../config.ts";
import type { Repository } from "../store/repository.ts";
import type { ContinuityStatus, Fix, Individual } from "../domain/types.ts";

export interface GeneratedNarrative {
  text: string;
  packet: GroundingPacket;
  cached: boolean;
  cacheKey: string;
}

export class NarrativeGenerator {
  private readonly provider: LLMProvider;
  private readonly repo: Repository | undefined;

  constructor(provider: LLMProvider, repo?: Repository) {
    this.provider = provider;
    this.repo = repo;
  }

  async generate(
    individual: Individual,
    fixes: Fix[],
    status: ContinuityStatus,
    ctx: GroundingContext,
  ): Promise<GeneratedNarrative> {
    const packet = buildGroundingPacket(individual, fixes, status, ctx);
    const cacheKey = cacheKeyFor(packet);

    const hit = this.repo?.getNarrative(cacheKey);
    if (hit) return { text: hit.text, packet, cached: true, cacheKey };

    const text = await this.provider.generate(packet);
    this.repo?.saveNarrative({
      cacheKey,
      individualId: individual.id,
      kind: packet.kind,
      text,
      groundingJson: JSON.stringify(packet),
      createdAt: ctx.now,
    });
    return { text, packet, cached: false, cacheKey };
  }
}

/** Pick a provider from config. Defaults to the grounded mock. */
export function providerFromConfig(config: Config): LLMProvider {
  if (config.narrative.provider === "anthropic") {
    if (!config.narrative.apiKey) {
      throw new Error("NARRATIVE_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    }
    return new AnthropicLLMProvider({
      apiKey: config.narrative.apiKey,
      model: config.narrative.model,
    });
  }
  return new MockLLMProvider();
}
