import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./api/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["DB_PATH"] ?? "./data/registry.db",
  },
});
