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
  locationText?: string,
  distanceRadiusKm?: number,
): Promise<RegistrationRecord> {
  const bodyObj: Record<string, unknown> = {
    pubkey: identity.npub,
    card_url: cardUrl,
    contact_channel: contact,
  };
  if (locationText) bodyObj["location"] = locationText;
  if (distanceRadiusKm !== undefined)
    bodyObj["distance_radius_km"] = distanceRadiusKm;

  const body = JSON.stringify(bodyObj);
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

  const resp = (await res.json()) as {
    enrolled: boolean;
    pubkey: string;
    location_lat?: number | null;
    location_lng?: number | null;
    location_label?: string | null;
    location_resolution?: string | null;
  };

  const record: RegistrationRecord = {
    pubkey: identity.npub,
    card_url: cardUrl,
    contact_channel: contact,
    registered_at: new Date().toISOString(),
    enrolled: true,
    location_lat: resp.location_lat ?? null,
    location_lng: resp.location_lng ?? null,
    location_label: resp.location_label ?? null,
    location_resolution: resp.location_resolution ?? null,
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

export interface ProximityOpts {
  lat: number;
  lng: number;
  radiusKm: number;
}

export async function listAgents(
  proximity?: ProximityOpts,
): Promise<Array<{ pubkey: string; cardUrl: string; lastSeen: string }>> {
  const url = new URL(`${REGISTRY_URL}/v1/agents`);
  if (proximity) {
    url.searchParams.set("lat", String(proximity.lat));
    url.searchParams.set("lng", String(proximity.lng));
    url.searchParams.set("radius_km", String(proximity.radiusKm));
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
  const data = (await res.json()) as {
    agents: Array<{ pubkey: string; cardUrl: string; lastSeen: string }>;
  };
  return data.agents;
}
