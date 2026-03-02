import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

const url = process.env["TURSO_DATABASE_URL"] ?? "file:./data/registry.db";
const authToken = process.env["TURSO_AUTH_TOKEN"];

const client = createClient(authToken ? { url, authToken } : { url });

export const db = drizzle(client, { schema });
