/**
 * Live smoke check against a confirmed fully-public Movebank study, exercising
 * the real read path (MovebankClient + LiveTransport + global fetch). Needs
 * network; not part of `npm test`.
 *
 *   node src/movebank/live-check.ts [studyId]
 *
 * Default study 2911040 = "Galapagos Albatrosses" (Wikelski et al.), fully public
 * on Movebank — used here purely to validate the live path end to end.
 */

import { MovebankClient } from "./client.ts";
import { LiveTransport } from "./transport.ts";
import { loadConfig } from "../config.ts";

const STUDY = process.argv[2] ?? "2911040";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new MovebankClient({
    transport: new LiveTransport({
      apiBase: config.movebank.apiBase,
      publicBase: config.movebank.publicBase,
      accessToken: config.movebank.accessToken,
      defaultSensorType: "gps",
    }),
    defaultSurface: "public-json",
  });

  console.log(`Reading public study ${STUDY} (sensor_type=gps) …`);
  const fixes = await client.getLocations({ studyId: STUDY });
  console.log(`Parsed ${fixes.length} fixes through the real client.`);
  if (fixes.length > 0) {
    const first = fixes[0]!;
    const last = fixes[fixes.length - 1]!;
    console.log(
      `  first: ${new Date(first.timestamp).toISOString()} @ ${first.lat.toFixed(3)}, ${first.lon.toFixed(3)}`,
    );
    console.log(
      `  last:  ${new Date(last.timestamp).toISOString()} @ ${last.lat.toFixed(3)}, ${last.lon.toFixed(3)}`,
    );
  }
}

main().catch((err) => {
  console.error("live-check failed:", err);
  process.exit(1);
});
