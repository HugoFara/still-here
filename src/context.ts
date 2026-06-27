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
    defaultSurface: "v2-rest",
    licensePolicy,
  });

  const generator = new NarrativeGenerator(providerFromConfig(config), repo);
  const worker = new IngestionWorker(repo, client, generator);

  return { config, repo, client, generator, worker };
}
