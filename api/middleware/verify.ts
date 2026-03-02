import { ed25519 } from "@noble/curves/ed25519.js";
import { createMiddleware } from "hono/factory";
import type { HonoVariables } from "../types.js";

// Verifies the X-TrueMatch-Sig header against the raw request body.
// Expects the header value to be a hex-encoded Ed25519 signature.
// The pubkey is extracted from the parsed body after this middleware runs —
// routes must call verifySignature() themselves with the parsed body's pubkey.

export function verifySignature(
  pubkeyHex: string,
  signatureHex: string,
  messageBytes: Uint8Array,
): boolean {
  try {
    const pubkey = hexToBytes(pubkeyHex);
    const sig = hexToBytes(signatureHex);
    return ed25519.verify(sig, messageBytes, pubkey);
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
