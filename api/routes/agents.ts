import { Hono } from "hono";
import { gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";

export const agentsRoute = new Hono();

// Agents not seen in this window are considered stale.
const LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

agentsRoute.get("/", async (c) => {
  const cutoff = new Date(Date.now() - LIVENESS_WINDOW_MS);
  const rows = await db
    .select({
      pubkey: agents.pubkey,
      cardUrl: agents.cardUrl,
      lastSeen: agents.lastSeen,
      protocolVersion: agents.protocolVersion,
    })
    .from(agents)
    .where(gt(agents.lastSeen, cutoff));

  return c.json({ agents: rows, count: rows.length });
});
