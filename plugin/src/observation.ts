import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTrueMatchDir } from "./identity.js";
import type { ObservationSummary, DimensionMeta } from "./types.js";

function getObservationFile(): string {
  return join(getTrueMatchDir(), "observation.json");
}

// Global minimums — cross-session sanity check
const GLOBAL_MIN_CONVERSATIONS = 2;
const GLOBAL_MIN_DAYS = 2;

// Per-dimension confidence floors (psychologist-derived)
// attachment/emotional_regulation: high contextual sensitivity → higher floor
// dealbreakers: can surface in a single conversation → higher floor, no day req
// communication: 0.55 (Knapp et al. — equal predictive weight to attachment)
// conflict_resolution: 0.55 (Gottman Four Horsemen — distinct from emotional_regulation)
// interdependence_model: 0.50 (Baxter & Montgomery — connection-autonomy dialectic)
export const DIMENSION_FLOORS = {
  attachment: 0.55,
  core_values: 0.55,
  communication: 0.55,
  emotional_regulation: 0.6,
  humor: 0.5,
  life_velocity: 0.5,
  dealbreakers: 0.6,
  conflict_resolution: 0.55,
  interdependence_model: 0.5,
} as const;

// Manifest is stale if eligibility was last computed more than this many hours ago.
// Bridge should trigger re-synthesis if stale.
export const ELIGIBILITY_FRESHNESS_HOURS = 72;

export async function loadObservation(): Promise<ObservationSummary | null> {
  if (!existsSync(getObservationFile())) return null;
  try {
    const raw = await readFile(getObservationFile(), "utf8");
    return JSON.parse(raw) as ObservationSummary;
  } catch {
    return null;
  }
}

export async function saveObservation(obs: ObservationSummary): Promise<void> {
  const now = new Date().toISOString();
  const updated: ObservationSummary = {
    ...obs,
    updated_at: now,
    eligibility_computed_at: now,
    matching_eligible: isPoolEligible(obs),
  };
  const dir = getTrueMatchDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(getObservationFile(), JSON.stringify(updated, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// isEligible: full 9-dimension check — used for reporting and manual inspection.
export function isEligible(obs: ObservationSummary): boolean {
  if (obs.conversation_count < GLOBAL_MIN_CONVERSATIONS) return false;
  if (obs.observation_span_days < GLOBAL_MIN_DAYS) return false;
  if (obs.dealbreaker_gate_state === "below_floor") return false;
  if (obs.dealbreaker_gate_state === "none_observed") return false;
  return (
    obs.attachment.confidence >= DIMENSION_FLOORS.attachment &&
    obs.core_values.confidence >= DIMENSION_FLOORS.core_values &&
    obs.communication.confidence >= DIMENSION_FLOORS.communication &&
    obs.emotional_regulation.confidence >=
      DIMENSION_FLOORS.emotional_regulation &&
    obs.humor.confidence >= DIMENSION_FLOORS.humor &&
    obs.life_velocity.confidence >= DIMENSION_FLOORS.life_velocity &&
    obs.dealbreakers.confidence >= DIMENSION_FLOORS.dealbreakers &&
    obs.conflict_resolution.confidence >=
      DIMENSION_FLOORS.conflict_resolution &&
    obs.interdependence_model.confidence >=
      DIMENSION_FLOORS.interdependence_model
  );
}

// isPoolEligible: gates entry into the matching pool.
// Requires T1 (dealbreakers, core_values, life_velocity) and T2 (attachment,
// conflict_resolution, emotional_regulation) dimensions only — T3 dimensions
// (humor, communication, interdependence_model) resolve later in negotiation
// and must NOT block pool entry.
export function isPoolEligible(obs: ObservationSummary): boolean {
  if (obs.conversation_count < GLOBAL_MIN_CONVERSATIONS) return false;
  if (obs.observation_span_days < GLOBAL_MIN_DAYS) return false;
  if (obs.dealbreaker_gate_state === "below_floor") return false;
  if (obs.dealbreaker_gate_state === "none_observed") return false;
  return (
    obs.dealbreakers.confidence >= DIMENSION_FLOORS.dealbreakers &&
    obs.core_values.confidence >= DIMENSION_FLOORS.core_values &&
    obs.life_velocity.confidence >= DIMENSION_FLOORS.life_velocity &&
    obs.attachment.confidence >= DIMENSION_FLOORS.attachment &&
    obs.conflict_resolution.confidence >=
      DIMENSION_FLOORS.conflict_resolution &&
    obs.emotional_regulation.confidence >= DIMENSION_FLOORS.emotional_regulation
  );
}

// Minimum Viable Evidence (MVE) for a quick match proposal — T1 + T2 dimensions.
// Agents can propose when MVE is met. T3 dimensions appear as watch_points.
// Dealbreaker floor is non-negotiable and never lowered.
export function isMinimumViable(obs: ObservationSummary): boolean {
  if (obs.dealbreaker_gate_state !== "confirmed") return false;
  return (
    obs.dealbreakers.confidence >= DIMENSION_FLOORS.dealbreakers &&
    obs.core_values.confidence >= DIMENSION_FLOORS.core_values &&
    obs.life_velocity.confidence >= DIMENSION_FLOORS.life_velocity &&
    obs.attachment.confidence >= DIMENSION_FLOORS.attachment &&
    obs.conflict_resolution.confidence >=
      DIMENSION_FLOORS.conflict_resolution &&
    obs.emotional_regulation.confidence >= DIMENSION_FLOORS.emotional_regulation
  );
}

export function isStale(obs: ObservationSummary): boolean {
  const computedAt = new Date(obs.eligibility_computed_at).getTime();
  return Date.now() - computedAt > ELIGIBILITY_FRESHNESS_HOURS * 60 * 60 * 1000;
}

export function emptyObservation(): ObservationSummary {
  const now = new Date().toISOString();
  const emptyDim: DimensionMeta = {
    confidence: 0,
    observation_count: 0,
    behavioral_context_diversity: "low",
  };

  return {
    updated_at: now,
    eligibility_computed_at: now,
    matching_eligible: false,
    conversation_count: 0,
    observation_span_days: 0,
    attachment: { ...emptyDim },
    core_values: { ...emptyDim },
    communication: { ...emptyDim },
    emotional_regulation: { ...emptyDim },
    humor: { ...emptyDim },
    life_velocity: { ...emptyDim },
    dealbreakers: { ...emptyDim },
    conflict_resolution: { ...emptyDim },
    interdependence_model: { ...emptyDim },
    dealbreaker_gate_state: "none_observed",
    inferred_intent_category: "unclear",
  };
}

export function eligibilityReport(obs: ObservationSummary): string {
  const lines: string[] = [];
  const pass = (label: string, ok: boolean, detail: string) =>
    lines.push(`${ok ? "✓" : "✗"} ${label}: ${detail}`);

  pass(
    "Conversations",
    obs.conversation_count >= GLOBAL_MIN_CONVERSATIONS,
    `${obs.conversation_count} / ${GLOBAL_MIN_CONVERSATIONS} required`,
  );
  pass(
    "Observation span",
    obs.observation_span_days >= GLOBAL_MIN_DAYS,
    `${obs.observation_span_days} days / ${GLOBAL_MIN_DAYS} required`,
  );
  pass(
    "Dealbreaker gate",
    obs.dealbreaker_gate_state !== "below_floor" &&
      obs.dealbreaker_gate_state !== "none_observed",
    obs.dealbreaker_gate_state,
  );

  const dims: [string, DimensionMeta, number][] = [
    ["Attachment", obs.attachment, DIMENSION_FLOORS.attachment],
    ["Core values", obs.core_values, DIMENSION_FLOORS.core_values],
    ["Communication", obs.communication, DIMENSION_FLOORS.communication],
    [
      "Emotional regulation",
      obs.emotional_regulation,
      DIMENSION_FLOORS.emotional_regulation,
    ],
    ["Humor", obs.humor, DIMENSION_FLOORS.humor],
    ["Life velocity", obs.life_velocity, DIMENSION_FLOORS.life_velocity],
    ["Dealbreakers", obs.dealbreakers, DIMENSION_FLOORS.dealbreakers],
    [
      "Conflict resolution",
      obs.conflict_resolution,
      DIMENSION_FLOORS.conflict_resolution,
    ],
    [
      "Interdependence model",
      obs.interdependence_model,
      DIMENSION_FLOORS.interdependence_model,
    ],
  ];

  for (const [name, dim, floor] of dims) {
    const diversity =
      dim.behavioral_context_diversity !== "low" ? "" : " [low diversity]";
    pass(
      name,
      dim.confidence >= floor,
      `confidence ${dim.confidence.toFixed(2)} / ${floor.toFixed(2)} required (${dim.observation_count} signals)${diversity}`,
    );
  }

  const stale = isStale(obs);
  if (stale) {
    lines.push(
      `⚠ Manifest stale — last computed ${obs.eligibility_computed_at}. Run: truematch observe --update`,
    );
  }

  return lines.join("\n");
}
