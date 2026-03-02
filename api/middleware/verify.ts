import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { HonoVariables } from "../types.js";

// Verifies the X-TrueMatch-Sig header against the raw request body.
// Expects the header value to be a hex-encoded BIP340 Schnorr signature
// over sha256(rawBody). Pubkey is x-only secp256k1 (32 bytes / 64 hex chars).
// Routes must call verifySignature() with the parsed body's pubkey field.

export function verifySignature(
  pubkeyHex: string,
  signatureHex: string,
  messageBytes: Uint8Array,
): boolean {
  try {
    const pubkey = hexToBytes(pubkeyHex);
    const sig = hexToBytes(signatureHex);
    const msgHash = createHash("sha256").update(messageBytes).digest();
    return schnorr.verify(sig, msgHash, pubkey);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Attaches raw body bytes to the context so routes can verify signatures.
export const attachRawBody = createMiddleware<{ Variables: HonoVariables }>(
  async (c, next) => {
    const body = await c.req.arrayBuffer();
    c.set("rawBody", new Uint8Array(body));
    await next();
  },
);
