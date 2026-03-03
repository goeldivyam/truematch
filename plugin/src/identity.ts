// NOTE: Throughout this codebase, "nsec" refers to the raw hex-encoded private key
// (32 bytes as a 64-char hex string), NOT the bech32 "nsec1..." encoding used by
// Nostr clients. Do not pass bech32-encoded keys to any function expecting nsec.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import type { TrueMatchIdentity } from "./types.js";

export const TRUEMATCH_DIR = join(homedir(), ".truematch");
const IDENTITY_FILE = join(TRUEMATCH_DIR, "identity.json");

export async function ensureDir(): Promise<void> {
  if (!existsSync(TRUEMATCH_DIR)) {
    await mkdir(TRUEMATCH_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadIdentity(): Promise<TrueMatchIdentity | null> {
  if (!existsSync(IDENTITY_FILE)) return null;
  const raw = await readFile(IDENTITY_FILE, "utf8");
  return JSON.parse(raw) as TrueMatchIdentity;
}

async function generateIdentity(): Promise<TrueMatchIdentity> {
  await ensureDir();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const identity: TrueMatchIdentity = {
    nsec: bytesToHex(secretKey),
    npub: pubkey,
    created_at: new Date().toISOString(),
  };
  // Write with 0o600 mode atomically — avoids a TOCTOU window between writeFile + chmod
  await writeFile(IDENTITY_FILE, JSON.stringify(identity, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return identity;
}

export async function getOrCreateIdentity(): Promise<TrueMatchIdentity> {
  const existing = await loadIdentity();
  if (existing) return existing;
  return generateIdentity();
}

// Sign a raw payload with BIP340 Schnorr for the X-TrueMatch-Sig header.
// The registry verifies: schnorr.verify(sig, sha256(rawBody), pubkey)
export function signPayload(nsecHex: string, payload: Uint8Array): string {
  const secretKey = hexToBytes(nsecHex);
  const msgHash = createHash("sha256").update(payload).digest();
  const sig = schnorr.sign(msgHash, secretKey);
  return bytesToHex(sig);
}
