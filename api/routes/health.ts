import { Hono } from "hono";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { sql } from "drizzle-orm";

export const health = new Hono();

health.get("/", async (c) => {
  try {
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .get();
    return c.json({ status: "ok", agents: result?.count ?? 0 });
  } catch {
    return c.json({ status: "error" }, 503);
  }
});
