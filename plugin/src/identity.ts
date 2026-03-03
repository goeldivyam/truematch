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

// Returns the active TrueMatch data directory.
// When TRUEMATCH_DIR_OVERRIDE is set (e.g. in tests or simulations), that path is used
// instead of the default ~/.truematch. Reading it each call allows per-agent isolation
// without reloading modules.
export function getTrueMatchDir(): string {
  return process.env["TRUEMATCH_DIR_OVERRIDE"] ?? join(homedir(), ".truematch");
}
export const TRUEMATCH_DIR = getTrueMatchDir();
const IDENTITY_FILE = join(getTrueMatchDir(), "identity.json");

export async function ensureDir(): Promise<void> {
  const dir = getTrueMatchDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export async function loadIdentity(): Promise<TrueMatchIdentity | null> {
  const identityFile = join(getTrueMatchDir(), "identity.json");
  if (!existsSync(identityFile)) return null;
  const raw = await readFile(identityFile, "utf8");
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
  const identityFile = join(getTrueMatchDir(), "identity.json");
  // Write with 0o600 mode atomically — avoids a TOCTOU window between writeFile + chmod
  await writeFile(identityFile, JSON.stringify(identity, null, 2), {
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
