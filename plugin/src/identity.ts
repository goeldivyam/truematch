import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1";
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

export async function generateIdentity(): Promise<TrueMatchIdentity> {
  await ensureDir();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const identity: TrueMatchIdentity = {
    nsec: bytesToHex(secretKey),
    npub: pubkey,
    created_at: new Date().toISOString(),
  };
  await writeFile(IDENTITY_FILE, JSON.stringify(identity, null, 2), "utf8");
  await chmod(IDENTITY_FILE, 0o600); // owner read/write only
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
