import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TRUEMATCH_DIR } from "./identity.js";
import type { UserPreferences } from "./types.js";

const PREFERENCES_FILE = join(TRUEMATCH_DIR, "preferences.json");

export async function loadPreferences(): Promise<UserPreferences> {
  if (!existsSync(PREFERENCES_FILE)) return {};
  const raw = await readFile(PREFERENCES_FILE, "utf8");
  return JSON.parse(raw) as UserPreferences;
}

export async function savePreferences(prefs: UserPreferences): Promise<void> {
  await writeFile(PREFERENCES_FILE, JSON.stringify(prefs, null, 2), "utf8");
}

// Check whether a candidate agent card passes Layer 0 filters.
// Returns true (pass) if no preferences are set or all set filters are satisfied.
// In practice, the agent does the semantic check — this is the structural gate.
export function preferencesGateDescription(prefs: UserPreferences): string {
  const filters: string[] = [];
  if (prefs.gender_preference?.length) {
    filters.push(`gender: ${prefs.gender_preference.join(" or ")}`);
  }
  if (prefs.location) {
    filters.push(`location: ${prefs.location}`);
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

export function formatPreferences(prefs: UserPreferences): string {
  return preferencesGateDescription(prefs);
}
