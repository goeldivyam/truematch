import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { attachRawBody, verifySignature } from "../middleware/verify.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { HonoVariables } from "../types.js";
import { encrypt } from "../crypto.js";
import { geocode, isAnywhereIntent } from "../geocode.js";

export const register = new Hono<{ Variables: HonoVariables }>();

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;
const CARD_URL_RE = /^https:\/\/.+/; // HTTPS only — prevents cleartext transmission of agent cards
const CONTACT_TYPES = new Set([
  "email",
  "discord",
  "telegram",
  "whatsapp",
  "imessage",
]);

// Block SSRF to private / loopback addresses
function isPrivateUrl(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return true; // unparseable — reject
  }
  if (hostname === "localhost") return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (AWS metadata)
  }
  return false;
}

register.post("/", rateLimit, attachRawBody, async (c) => {
  const rawBody = c.get("rawBody") as Uint8Array;
  const sig = c.req.header("x-truematch-sig");

  if (!sig || !SIG_RE.test(sig)) {
    return c.json({ error: "Missing or invalid X-TrueMatch-Sig header" }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("pubkey" in body) ||
    !("card_url" in body) ||
    !("contact_channel" in body)
  ) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  const { pubkey, card_url, contact_channel } = body as Record<string, unknown>;
  const bodyRecord = body as Record<string, unknown>;

  if (typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey)) {
    return c.json({ error: "Invalid pubkey" }, 400);
  }
  if (typeof card_url !== "string" || !CARD_URL_RE.test(card_url)) {
    return c.json({ error: "Invalid card_url" }, 400);
  }
  if (isPrivateUrl(card_url)) {
    return c.json({ error: "Invalid card_url" }, 400);
  }
  if (
    typeof contact_channel !== "object" ||
    contact_channel === null ||
    !("type" in contact_channel) ||
    !("value" in contact_channel) ||
    typeof (contact_channel as Record<string, unknown>)["type"] !== "string" ||
    typeof (contact_channel as Record<string, unknown>)["value"] !== "string" ||
    !CONTACT_TYPES.has(
      (contact_channel as Record<string, unknown>)["type"] as string,
    )
  ) {
    return c.json({ error: "Invalid contact_channel" }, 400);
  }

  // Optional location fields — validated but not required
  const rawLocation = bodyRecord["location"];
  const rawDistance = bodyRecord["distance_radius_km"];

  if (rawLocation !== undefined && typeof rawLocation !== "string") {
    return c.json({ error: "location must be a string" }, 400);
  }
  if (
    rawDistance !== undefined &&
    (typeof rawDistance !== "number" || rawDistance <= 0)
  ) {
    return c.json(
      { error: "distance_radius_km must be a positive number" },
      400,
    );
  }

  if (!verifySignature(pubkey, sig, rawBody)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Fetch and validate the agent card.
  try {
    const cardRes = await fetch(card_url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!cardRes.ok) throw new Error("Card unreachable");
    const card = (await cardRes.json()) as Record<string, unknown>;
    const truematch = card["truematch"] as Record<string, unknown> | undefined;
    if (
      !truematch ||
      typeof truematch["nostrPubkey"] !== "string" ||
      typeof truematch["matchContext"] !== "string"
    ) {
      throw new Error("Invalid agent card");
    }
    if (truematch["nostrPubkey"] !== pubkey) {
      return c.json(
        { error: "Card nostrPubkey does not match registration pubkey" },
        400,
      );
    }
  } catch {
    return c.json({ error: "Could not reach or validate agent card" }, 422);
  }

  // Resolve location — geocode plain-text input, detect "anywhere" intent
  const locationText =
    typeof rawLocation === "string" ? rawLocation.trim() : null;
  const distanceKm = typeof rawDistance === "number" ? rawDistance : null;

  let locationLat: number | null = null;
  let locationLng: number | null = null;
  let locationResolution: string | null = null;
  let locationLabel: string | null = null;
  let locationAnywhere = 0;

  if (!locationText || isAnywhereIntent(locationText)) {
    locationAnywhere = 1;
    locationResolution = "anywhere";
  } else {
    const geo = await geocode(locationText);
    if (geo) {
      locationLat = geo.lat;
      locationLng = geo.lng;
      locationResolution = geo.resolution;
      locationLabel = geo.label;
    } else {
      locationResolution = "unresolved";
    }
  }

  const cc = contact_channel as { type: string; value: string };
  const now = new Date();

  await db
    .insert(agents)
    .values({
      pubkey,
      cardUrl: card_url,
      contactChannelType: cc.type,
      contactChannelValue: encrypt(cc.value),
      lastSeen: now,
      registeredAt: now,
      locationText,
      locationLat,
      locationLng,
      locationResolution,
      locationLabel,
      locationAnywhere,
      distanceRadiusKm: distanceKm,
    })
    .onConflictDoUpdate({
      target: agents.pubkey,
      set: {
        cardUrl: card_url,
        contactChannelType: cc.type,
        contactChannelValue: encrypt(cc.value),
        lastSeen: now,
        locationText,
        locationLat,
        locationLng,
        locationResolution,
        locationLabel,
        locationAnywhere,
        distanceRadiusKm: distanceKm,
      },
    });

  return c.json(
    {
      enrolled: true,
      pubkey,
      // Return geocoded coordinates so the agent can store them locally for
      // use as query parameters when calling GET /v1/agents.
      // Null when location is unresolved or anywhere.
      location_lat: locationLat,
      location_lng: locationLng,
      location_label: locationLabel,
      location_resolution: locationResolution,
    },
    201,
  );
});

register.delete("/", rateLimit, attachRawBody, async (c) => {
  const rawBody = c.get("rawBody") as Uint8Array;
  const sig = c.req.header("x-truematch-sig");

  if (!sig || !SIG_RE.test(sig)) {
    return c.json({ error: "Missing or invalid X-TrueMatch-Sig header" }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("pubkey" in body) ||
    typeof (body as Record<string, unknown>)["pubkey"] !== "string"
  ) {
    return c.json({ error: "Missing pubkey" }, 400);
  }

  const { pubkey } = body as { pubkey: string };

  if (!PUBKEY_RE.test(pubkey)) {
    return c.json({ error: "Invalid pubkey" }, 400);
  }
  if (!verifySignature(pubkey, sig, rawBody)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const [deleted] = await db
    .delete(agents)
    .where(eq(agents.pubkey, pubkey))
    .returning({ pubkey: agents.pubkey });
  if (!deleted) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json({ deregistered: true, pubkey });
});
