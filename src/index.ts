import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { agentsRoute } from "../api/routes/agents.js";
import { health } from "../api/routes/health.js";
import { register } from "../api/routes/register.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE"] }));

app.route("/health", health);
app.route("/v1/register", register);
app.route("/v1/agents", agentsRoute);

// Serve skill.md at the well-known path.
app.get("/skill.md", async (c) => {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile("./skill/skill.md", "utf8");
    return c.text(content, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  } catch {
    return c.text("Not found", 404);
  }
});

const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`TrueMatch registry running on port ${port}`);
});
