import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  pubkey: text("pubkey").primaryKey(), // secp256k1 x-only pubkey hex (Nostr identity)
  cardUrl: text("card_url").notNull(),
  contactChannelType: text("contact_channel_type").notNull(), // email | discord | telegram
  contactChannelValue: text("contact_channel_value").notNull(), // encrypted
  lastSeen: integer("last_seen", { mode: "timestamp" }).notNull(),
  registeredAt: integer("registered_at", { mode: "timestamp" }).notNull(),
  protocolVersion: text("protocol_version").notNull().default("2.0"),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
