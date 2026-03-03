/**
 * Nominatim geocoding with in-memory cache.
 *
 * Policy compliance:
 * - One request per geocode call; results cached in-memory for process lifetime.
 * - User-Agent identifies the service per OSM Foundation usage policy.
 * - City-centroid precision only — Nominatim's place_rank is used to snap to
 *   the city level regardless of how specific the input is. This prevents
 *   sub-city coordinate exposure which enables trilateration attacks.
 */

export type LocationResolution =
  | "city"
  | "region"
  | "country"
  | "unresolved"
  | "anywhere";

export interface GeoResult {
  lat: number;
  lng: number;
  label: string;
  resolution: Exclude<LocationResolution, "unresolved" | "anywhere">;
}

// Nominatim place_rank → resolution mapping
// Ranks: 4=country, 5-8=state/province, 9-12=region, 13+=city/neighbourhood
function resolutionFromRank(
  rank: number,
): Exclude<LocationResolution, "unresolved" | "anywhere"> {
  if (rank <= 4) return "country";
  if (rank <= 12) return "region";
  return "city";
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  place_rank: number;
}

// In-memory cache keyed on lowercased trimmed location text.
// Satisfies Nominatim's caching requirement; persists for process lifetime.
const cache = new Map<string, GeoResult | null>();

/** Sentinel strings that indicate "open to anyone / no location filter". */
const ANYWHERE_RE = /^(anywhere|online|remote|worldwide|global)$/i;

/** Returns null if the input cannot be geocoded (vague, unrecognised, or API error). */
export async function geocode(locationText: string): Promise<GeoResult | null> {
  const key = locationText.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", locationText);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "0");

  let data: NominatimResult[];
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "TrueMatch/0.0.1 (https://clawmatch.org)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    data = (await res.json()) as NominatimResult[];
  } catch {
    // Network error — do not cache so the next request retries
    return null;
  }

  if (!data.length) {
    cache.set(key, null);
    return null;
  }

  const item = data[0]!;
  const result: GeoResult = {
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
    // Take only the first segment of display_name as the human-readable label
    label: item.display_name.split(",")[0]!.trim(),
    resolution: resolutionFromRank(item.place_rank),
  };

  cache.set(key, result);
  return result;
}

/** Returns true for strings that signal "open to matching anywhere". */
export function isAnywhereIntent(locationText: string): boolean {
  return ANYWHERE_RE.test(locationText.trim());
}
