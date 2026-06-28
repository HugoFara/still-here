/**
 * Composition root. Builds the wired application graph from config so the CLI,
 * the server, and tests all share one assembly. Swapping fixture↔live transport
 * or mock↔real LLM happens here and nowhere else.
 */

import { loadConfig, type Config } from "./config.ts";
import { SqliteRepository } from "./store/sqlite-store.ts";
import { MovebankClient, type LicensePolicy } from "./movebank/client.ts";
import { FixtureTransport, LiveTransport } from "./movebank/transport.ts";
import { NarrativeGenerator, providerFromConfig } from "./narrative/generator.ts";
import { IngestionWorker } from "./ingestion/worker.ts";
import type { Repository } from "./store/repository.ts";

/** Where the seed writes runtime fixtures the fixture-mode client reads. */
export const RUNTIME_FIXTURE_DIR = "data/fixtures-runtime";

export interface AppContext {
  config: Config;
  repo: Repository;
  client: MovebankClient;
  generator: NarrativeGenerator;
  worker: IngestionWorker;
}

export function createContext(config: Config = loadConfig()): AppContext {
  const repo = SqliteRepository.open(config.db.path);

  // Default license policy refuses (accepting terms is a human/legal act), but
  // records any acceptance to the audit trail when an accepting policy is used.
  const licensePolicy: LicensePolicy = {
    accept: () => false,
    onAccepted: (studyId, md5) => repo.recordLicenseAcceptance(studyId, md5),
  };

  const transport =
    config.movebank.mode === "live"
      ? new LiveTransport({
          apiBase: config.movebank.apiBase,
          publicBase: config.movebank.publicBase,
          accessToken: config.movebank.accessToken,
        })
      : new FixtureTransport(RUNTIME_FIXTURE_DIR);

  const client = new MovebankClient({
    transport,
    // Fully-public studies read tokenless through the public-JSON service (keyed
    // by study_id + individual_local_identifiers + sensor_type, validated live).
    // The v2-REST surface needs an account token and is opt-in per call.
    defaultSurface: "public-json",
    licensePolicy,
  });

  const generator = new NarrativeGenerator(providerFromConfig(config), repo);
  // Bound live reads to a recent window; the offline fixture transport ignores it.
  const worker = new IngestionWorker(
    repo,
    client,
    generator,
    config.movebank.mode === "live"
      ? { lookbackMs: config.movebank.ingestLookbackDays * 86_400_000 }
      : {},
  );

  return { config, repo, client, generator, worker };
}
