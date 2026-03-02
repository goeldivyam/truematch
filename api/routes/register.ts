import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { attachRawBody, verifySignature } from "../middleware/verify.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { HonoVariables } from "../types.js";
import { encrypt } from "../crypto.js";

export const register = new Hono<{ Variables: HonoVariables }>();

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;
const CARD_URL_RE = /^https?:\/\/.+/;
const CONTACT_TYPES = new Set(["email", "discord", "telegram"]);

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

  if (typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey)) {
    return c.json({ error: "Invalid pubkey" }, 400);
  }
  if (typeof card_url !== "string" || !CARD_URL_RE.test(card_url)) {
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
    if (!truematch || typeof truematch["nostrPubkey"] !== "string") {
      throw new Error("Invalid agent card");
    }
    if (truematch["nostrPubkey"] !== pubkey) {
      return c.json(
        { error: "Card nostrPubkey does not match registration pubkey" },
        400,
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Card nostrPubkey does not match registration pubkey"
    ) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Could not reach or validate agent card" }, 422);
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
    })
    .onConflictDoUpdate({
      target: agents.pubkey,
      set: { cardUrl: card_url, lastSeen: now },
    });

  return c.json({ enrolled: true, pubkey }, 201);
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
