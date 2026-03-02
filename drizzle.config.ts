import { defineConfig } from "drizzle-kit";

const url = process.env["TURSO_DATABASE_URL"] ?? "file:./data/registry.db";
const authToken = process.env["TURSO_AUTH_TOKEN"];

export default defineConfig({
  dialect: "turso",
  schema: "./api/db/schema.ts",
  out: "./drizzle",
  dbCredentials: authToken ? { url, authToken } : { url },
});
