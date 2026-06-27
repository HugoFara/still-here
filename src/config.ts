/**
 * Runtime configuration. Pure reads of process.env with safe defaults so the
 * offline fixture slice runs with zero setup.
 */

export interface Config {
  movebank: {
    mode: "fixture" | "live";
    apiBase: string;
    publicBase: string;
    username: string | undefined;
    password: string | undefined;
    accessToken: string | undefined;
  };
  narrative: {
    provider: "mock" | "anthropic";
    apiKey: string | undefined;
    model: string;
  };
  server: { port: number };
  db: { path: string };
}

function env(key: string, fallback?: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): Config {
  return {
    movebank: {
      mode: (env("MOVEBANK_MODE", "fixture") as "fixture" | "live"),
      apiBase: env("MOVEBANK_API_BASE", "https://api.movebank.org/v2")!,
      publicBase: env(
        "MOVEBANK_PUBLIC_BASE",
        "https://www.movebank.org/movebank/service/public/json",
      )!,
      username: env("MOVEBANK_USERNAME"),
      password: env("MOVEBANK_PASSWORD"),
      accessToken: env("MOVEBANK_ACCESS_TOKEN"),
    },
    narrative: {
      provider: (env("NARRATIVE_PROVIDER", "mock") as "mock" | "anthropic"),
      apiKey: env("ANTHROPIC_API_KEY"),
      model: env("NARRATIVE_MODEL", "claude-haiku-4-5-20251001")!,
    },
    server: { port: Number(env("PORT", "8787")) },
    db: { path: env("DB_PATH", "data/continuity.db")! },
  };
}
