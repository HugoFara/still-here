/**
 * Zero-dependency HTTP server (node:http) exposing the follow API + static UI.
 * No account wall for the core follow experience (brief §1, §non-goals) — the
 * client mints an anonymous session id and the server derives the A/B arm from
 * it. Run: `npm start`, then open http://localhost:8787.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { createContext } from "../context.ts";
import { RosterService } from "./roster-service.ts";
import { computeFunnel } from "../experiment/ab.ts";
import { DEMO_NOW } from "../roster/seed.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  // Prevent path traversal.
  const full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

export function startServer(port: number): { close: () => void } {
  const ctx = createContext();
  const service = new RosterService(ctx.repo, ctx.generator);
  // In the offline fixture demo, the snapshot is frozen — anchor "now" to the
  // capture instant so states match what was ingested. Live mode uses real time.
  const liveMode = ctx.config.movebank.mode === "live";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const now = liveMode ? Date.now() : DEMO_NOW;

      if (req.method === "GET" && path === "/api/roster") {
        return sendJson(res, 200, { roster: service.listRoster(now) });
      }

      if (req.method === "GET" && path === "/api/animal") {
        const id = url.searchParams.get("id") ?? "";
        const session = url.searchParams.get("session") ?? "anon";
        const from = url.searchParams.get("from"); // set when arriving via a handoff
        const payload = await service.getAnimal(id, session, now, from);
        if (!payload) return sendJson(res, 404, { error: "not found or retired" });
        return sendJson(res, 200, payload);
      }

      if (req.method === "POST" && path === "/api/follow") {
        const body = (await readBody(req)) as {
          sessionId?: string;
          individualId?: string;
          meta?: Record<string, unknown>;
        };
        if (!body.sessionId || !body.individualId) return sendJson(res, 400, { error: "missing fields" });
        const arm = service.recordEvent(body.sessionId, body.individualId, "follow", now, body.meta);
        return sendJson(res, 200, { ok: true, arm });
      }

      if (req.method === "POST" && path === "/api/event") {
        const body = (await readBody(req)) as {
          sessionId?: string;
          individualId?: string;
          type?: "engage" | "action_taken";
          meta?: Record<string, unknown>;
        };
        if (!body.sessionId || !body.individualId || !body.type) {
          return sendJson(res, 400, { error: "missing fields" });
        }
        const arm = service.recordEvent(body.sessionId, body.individualId, body.type, now, body.meta);
        return sendJson(res, 200, { ok: true, arm });
      }

      if (req.method === "GET" && path === "/api/experiment") {
        const report = computeFunnel(ctx.repo.allEvents());
        return sendJson(res, 200, {
          ...report,
          note: "Includes synthetic seed traffic until real sessions accumulate. Assume no transfer until the lift is significant.",
        });
      }

      if (req.method === "GET") return serveStatic(res, path);

      res.writeHead(405).end("method not allowed");
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: "internal error" });
    }
  });

  server.listen(port, () => {
    console.log(`Continuity tracker on http://localhost:${port}`);
  });
  return {
    close: () => {
      server.close();
      ctx.repo.close();
    },
  };
}

// Run when invoked directly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { loadConfig } = await import("../config.ts");
  startServer(loadConfig().server.port);
}
