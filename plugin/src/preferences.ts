import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTrueMatchDir } from "./identity.js";
import type { UserPreferences } from "./types.js";

function getPreferencesFile(): string {
  return join(getTrueMatchDir(), "preferences.json");
}

export async function loadPreferences(): Promise<UserPreferences> {
  if (!existsSync(getPreferencesFile())) return {};
  try {
    const raw = await readFile(getPreferencesFile(), "utf8");
    return JSON.parse(raw) as UserPreferences;
  } catch {
    return {};
  }
}

export async function savePreferences(prefs: UserPreferences): Promise<void> {
  await writeFile(getPreferencesFile(), JSON.stringify(prefs, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function formatPreferences(prefs: UserPreferences): string {
  const filters: string[] = [];
  if (prefs.gender_preference?.length) {
    filters.push(`gender: ${prefs.gender_preference.join(" or ")}`);
  }
  if (prefs.location) {
    const radius =
      prefs.distance_radius_km !== undefined
        ? ` (within ${prefs.distance_radius_km} km)`
        : "";
    filters.push(`location: ${prefs.location}${radius}`);
  }
  if (prefs.age_range) {
    const { min, max } = prefs.age_range;
    if (min !== undefined && max !== undefined)
      filters.push(`age: ${min}–${max}`);
    else if (min !== undefined) filters.push(`age: ${min}+`);
    else if (max !== undefined) filters.push(`age: up to ${max}`);
  }
  if (filters.length === 0)
    return "No preferences set — open to all candidates";
  return `Active filters: ${filters.join(", ")}`;
}
