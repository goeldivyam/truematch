import { Hono } from "hono";
import { gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const agentsRoute = new Hono();

// Agents not seen in this window are considered stale.
const LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Haversine distance in kilometres between two lat/lng points.
 */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * GET /v1/agents
 *
 * Returns agents active within the last 24 hours. Accepts optional proximity
 * query parameters. Responses never include coordinates or distances — only
 * pubkeys and card URLs — to prevent trilateration attacks.
 *
 * Query params (all optional):
 *   lat       — requester's latitude  (float)
 *   lng       — requester's longitude (float)
 *   radius_km — requester's max distance preference (float, km)
 *
 * Filtering logic when lat/lng/radius_km are all present:
 *   Include a candidate if ANY of:
 *   1. Candidate has location_anywhere=1 (open to global matching)
 *   2. Candidate has a geocoded location AND:
 *      - distance(candidate, requester) <= requester's radius_km
 *      - distance(candidate, requester) <= candidate's own distance_radius_km (if set)
 *   3. Candidate has location_resolution='unresolved' — included by default
 *      (graceful degradation for vague inputs)
 *
 * When query params are absent, all active agents are returned (requester
 * has no location preference or is open to anyone).
 */
agentsRoute.get("/", rateLimit, async (c) => {
  const latParam = c.req.query("lat");
  const lngParam = c.req.query("lng");
  const radiusParam = c.req.query("radius_km");

  const hasProximityFilter =
    latParam !== undefined &&
    lngParam !== undefined &&
    radiusParam !== undefined;

  let reqLat = 0;
  let reqLng = 0;
  let reqRadius = Infinity;

  if (hasProximityFilter) {
    reqLat = parseFloat(latParam!);
    reqLng = parseFloat(lngParam!);
    reqRadius = parseFloat(radiusParam!);
    if (isNaN(reqLat) || isNaN(reqLng) || isNaN(reqRadius) || reqRadius <= 0) {
      return c.json({ error: "Invalid proximity parameters" }, 400);
    }
  }

  const cutoff = new Date(Date.now() - LIVENESS_WINDOW_MS);
  const rows = await db
    .select({
      pubkey: agents.pubkey,
      cardUrl: agents.cardUrl,
      lastSeen: agents.lastSeen,
      protocolVersion: agents.protocolVersion,
      locationLat: agents.locationLat,
      locationLng: agents.locationLng,
      locationResolution: agents.locationResolution,
      locationAnywhere: agents.locationAnywhere,
      distanceRadiusKm: agents.distanceRadiusKm,
    })
    .from(agents)
    .where(gt(agents.lastSeen, cutoff));

  const filtered = hasProximityFilter
    ? rows.filter((a) => {
        // Candidate accepts global matching
        if (a.locationAnywhere) return true;

        // Candidate has geocoded coordinates — apply mutual radius check
        if (a.locationLat !== null && a.locationLng !== null) {
          const dist = haversineKm(
            a.locationLat,
            a.locationLng,
            reqLat,
            reqLng,
          );
          // Requester's radius filter
          if (dist > reqRadius) return false;
          // Candidate's own outbound radius preference
          if (a.distanceRadiusKm !== null && dist > a.distanceRadiusKm)
            return false;
          return true;
        }

        // Unresolved location — include by default (graceful degradation)
        if (
          a.locationResolution === "unresolved" ||
          a.locationResolution === null
        )
          return true;

        return false;
      })
    : rows;

  // Strip internal location fields before responding — never expose coordinates
  const response = filtered.map((a) => ({
    pubkey: a.pubkey,
    cardUrl: a.cardUrl,
    lastSeen: a.lastSeen,
    protocolVersion: a.protocolVersion,
  }));

  return c.json({ agents: response, count: response.length });
});
