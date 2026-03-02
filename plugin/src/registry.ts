import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TRUEMATCH_DIR, signPayload } from "./identity.js";
import type {
  ContactChannel,
  RegistrationRecord,
  TrueMatchIdentity,
} from "./types.js";

const REGISTRY_URL = "https://clawmatch.org";
const REGISTRATION_FILE = join(TRUEMATCH_DIR, "registration.json");

export async function loadRegistration(): Promise<RegistrationRecord | null> {
  if (!existsSync(REGISTRATION_FILE)) return null;
  const raw = await readFile(REGISTRATION_FILE, "utf8");
  return JSON.parse(raw) as RegistrationRecord;
}

export async function register(
  identity: TrueMatchIdentity,
  cardUrl: string,
  contact: ContactChannel,
): Promise<RegistrationRecord> {
  const body = JSON.stringify({
    pubkey: identity.npub,
    card_url: cardUrl,
    contact_channel: contact,
  });
  const rawBody = new TextEncoder().encode(body);
  const sig = signPayload(identity.nsec, rawBody);

  const res = await fetch(`${REGISTRY_URL}/v1/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TrueMatch-Sig": sig,
    },
    body,
  });

  if (!res.ok) {
    const err = (await res.json()) as { error: string };
    throw new Error(`Registry error ${res.status}: ${err.error}`);
  }

  const record: RegistrationRecord = {
    pubkey: identity.npub,
    card_url: cardUrl,
    contact_channel: contact,
    registered_at: new Date().toISOString(),
    enrolled: true,
  };
  await writeFile(REGISTRATION_FILE, JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function deregister(identity: TrueMatchIdentity): Promise<void> {
  const body = JSON.stringify({ pubkey: identity.npub });
  const rawBody = new TextEncoder().encode(body);
  const sig = signPayload(identity.nsec, rawBody);

  const res = await fetch(`${REGISTRY_URL}/v1/register`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-TrueMatch-Sig": sig,
    },
    body,
  });

  if (!res.ok && res.status !== 404) {
    const err = (await res.json()) as { error: string };
    throw new Error(`Registry error ${res.status}: ${err.error}`);
  }

  if (existsSync(REGISTRATION_FILE)) {
    const rec = await loadRegistration();
    if (rec) {
      rec.enrolled = false;
      await writeFile(REGISTRATION_FILE, JSON.stringify(rec, null, 2), "utf8");
    }
  }
}

export async function listAgents(): Promise<
  Array<{ pubkey: string; cardUrl: string; lastSeen: string }>
> {
  const res = await fetch(`${REGISTRY_URL}/v1/agents`);
  if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
  const data = (await res.json()) as {
    agents: Array<{ pubkey: string; cardUrl: string; lastSeen: string }>;
  };
  return data.agents;
}
