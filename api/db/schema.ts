import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  pubkey: text("pubkey").primaryKey(), // Ed25519 pubkey hex
  cardUrl: text("card_url").notNull(),
  inboxUrl: text("inbox_url").notNull(),
  contactChannelType: text("contact_channel_type").notNull(), // email | discord | telegram
  contactChannelValue: text("contact_channel_value").notNull(), // encrypted
  lastSeen: integer("last_seen", { mode: "timestamp" }).notNull(),
  registeredAt: integer("registered_at", { mode: "timestamp" }).notNull(),
  protocolVersion: text("protocol_version").notNull().default("1.0"),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
