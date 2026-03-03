import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  pubkey: text("pubkey").primaryKey(), // secp256k1 x-only pubkey hex (Nostr identity)
  cardUrl: text("card_url").notNull(),
  contactChannelType: text("contact_channel_type").notNull(), // email | discord | telegram | whatsapp | imessage
  contactChannelValue: text("contact_channel_value").notNull(), // encrypted
  lastSeen: integer("last_seen", { mode: "timestamp" }).notNull(),
  registeredAt: integer("registered_at", { mode: "timestamp" }).notNull(),
  protocolVersion: text("protocol_version").notNull().default("2.0"),

  // Location — optional, geocoded server-side from plain-text user input.
  // Stored at city-centroid precision only — never GPS-level.
  locationText: text("location_text"),
  locationLat: real("location_lat"),
  locationLng: real("location_lng"),
  locationResolution: text("location_resolution"), // city | region | country | unresolved | anywhere
  locationLabel: text("location_label"), // normalised city name from geocoder
  locationAnywhere: integer("location_anywhere").notNull().default(0), // 1 = no proximity filter
  distanceRadiusKm: real("distance_radius_km"), // null = no outbound filter
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
