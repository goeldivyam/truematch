import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/libsql/migrator";
import { lt } from "drizzle-orm";
import { validateEncryptionKey } from "../api/crypto.js";
import { db } from "../api/db/index.js";
import { agents } from "../api/db/schema.js";
import { agentsRoute } from "../api/routes/agents.js";
import { health } from "../api/routes/health.js";
import { register } from "../api/routes/register.js";

// ── Startup validation ────────────────────────────────────────────────────────

validateEncryptionKey();

// ── Database migration ────────────────────────────────────────────────────────

await migrate(db, { migrationsFolder: "./drizzle" });

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE"] }));

app.route("/health", health);
app.route("/v1/register", register);
app.route("/v1/agents", agentsRoute);

app.get("/skill.md", async (c) => {
  try {
    const content = await readFile("./skill/skill.md", "utf8");
    return c.text(content, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  } catch {
    return c.text("Not found", 404);
  }
});

// ── Background: stale agent pruning ──────────────────────────────────────────

const LIVENESS_WINDOW_HOURS = Number(
  process.env["LIVENESS_WINDOW_HOURS"] ?? 24,
);
const HEALTH_CHECK_INTERVAL_MINUTES = Number(
  process.env["HEALTH_CHECK_INTERVAL_MINUTES"] ?? 60,
);

async function pruneStaleAgents(): Promise<void> {
  const cutoff = new Date(Date.now() - LIVENESS_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await db
    .select({ pubkey: agents.pubkey, cardUrl: agents.cardUrl })
    .from(agents)
    .where(lt(agents.lastSeen, cutoff));

  for (const agent of rows) {
    try {
      const res = await fetch(agent.cardUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        // Agent is alive — update lastSeen
        await db
          .update(agents)
          .set({ lastSeen: new Date() })
          .where(lt(agents.lastSeen, cutoff));
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      // Agent unreachable — remove from pool
      await db.delete(agents).where(lt(agents.lastSeen, cutoff));
      console.log(`Pruned stale agent: ${agent.pubkey.slice(0, 12)}...`);
    }
  }
}

setInterval(
  () => {
    pruneStaleAgents().catch(console.error);
  },
  HEALTH_CHECK_INTERVAL_MINUTES * 60 * 1000,
);

// ── Server ────────────────────────────────────────────────────────────────────

const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`TrueMatch registry running on port ${port}`);
  console.log(
    `Stale agent pruning every ${HEALTH_CHECK_INTERVAL_MINUTES} minutes (window: ${LIVENESS_WINDOW_HOURS}h)`,
  );
});
