import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TRUEMATCH_DIR } from "./identity.js";
import type { ObservationSummary } from "./types.js";

const OBSERVATION_FILE = join(TRUEMATCH_DIR, "observation.json");
const AGENT_VERSION = "0.1.0";

// Global minimums — cross-session sanity check (agent must have seen user across 2 separate contexts)
const GLOBAL_MIN_CONVERSATIONS = 2;
const GLOBAL_MIN_DAYS = 2;

// Per-dimension confidence floors (psychologist-derived; encode the typical conversation count needed)
// attachment/emotional_regulation: high contextual sensitivity → higher floor
// dealbreakers: can surface in a single conversation → higher floor but no day requirement
const DIMENSION_FLOORS = {
  attachment: 0.55,
  core_values: 0.55,
  communication: 0.5,
  emotional_regulation: 0.6,
  humor: 0.5,
  life_velocity: 0.5,
  dealbreakers: 0.6,
} as const;

export async function loadObservation(): Promise<ObservationSummary | null> {
  if (!existsSync(OBSERVATION_FILE)) return null;
  const raw = await readFile(OBSERVATION_FILE, "utf8");
  return JSON.parse(raw) as ObservationSummary;
}

export async function saveObservation(obs: ObservationSummary): Promise<void> {
  const updated: ObservationSummary = {
    ...obs,
    updated_at: new Date().toISOString(),
    matching_eligible: isEligible(obs),
  };
  await writeFile(OBSERVATION_FILE, JSON.stringify(updated, null, 2), "utf8");
}

export function isEligible(obs: ObservationSummary): boolean {
  if (obs.conversation_count < GLOBAL_MIN_CONVERSATIONS) return false;
  if (obs.observation_span_days < GLOBAL_MIN_DAYS) return false;
  return (
    obs.attachment.confidence >= DIMENSION_FLOORS.attachment &&
    obs.core_values.confidence >= DIMENSION_FLOORS.core_values &&
    obs.communication.confidence >= DIMENSION_FLOORS.communication &&
    obs.emotional_regulation.confidence >=
      DIMENSION_FLOORS.emotional_regulation &&
    obs.humor.confidence >= DIMENSION_FLOORS.humor &&
    obs.life_velocity.confidence >= DIMENSION_FLOORS.life_velocity &&
    obs.dealbreakers.confidence >= DIMENSION_FLOORS.dealbreakers
  );
}

export function emptyObservation(): ObservationSummary {
  const now = new Date().toISOString();
  const emptyDim = <T>(value: T) => ({
    value,
    confidence: 0,
    observation_count: 0,
    last_updated: now,
    evidence_summary: "",
    behavioral_context_diversity: "low" as const,
  });

  return {
    agent_version: AGENT_VERSION,
    created_at: now,
    updated_at: now,
    conversation_count: 0,
    observation_span_days: 0,
    matching_eligible: false,

    attachment: emptyDim({ primary: "secure" as const, secondary: null }),
    core_values: emptyDim({ ranked: [] }),
    communication: emptyDim({
      dominance: "neutral" as const,
      affiliation: "neutral" as const,
      directness: "direct" as const,
      emotional_disclosure: "moderate" as const,
      conflict_approach: "collaborative" as const,
      response_latency_preference: "moderate" as const,
    }),
    emotional_regulation: emptyDim({
      regulation_level: "moderate" as const,
      flooding_signals_present: false,
      reappraisal_tendency: "moderate" as const,
      suppression_tendency: "moderate" as const,
    }),
    humor: emptyDim({
      primary: "affiliative" as const,
      secondary: null,
      irony_literacy: "moderate" as const,
      levity_as_coping: false,
    }),
    life_velocity: emptyDim({
      phase: "early-adulthood" as const,
      future_orientation: "stable" as const,
      ambition_domains: [],
    }),
    dealbreakers: emptyDim({ constraints: [] }),
  };
}

// Strip evidence_summary fields before transmitting to peer agents.
// This is a privacy guarantee — internal reasoning is never shared.
export function stripEvidenceSummaries(
  obs: ObservationSummary,
): ObservationSummary {
  const strip = <T>(dim: {
    value: T;
    confidence: number;
    observation_count: number;
    last_updated: string;
    evidence_summary: string;
    behavioral_context_diversity: "low" | "medium" | "high";
  }) => ({
    ...dim,
    evidence_summary: "", // always cleared before transmission
  });

  return {
    ...obs,
    attachment: strip(obs.attachment),
    core_values: strip(obs.core_values),
    communication: strip(obs.communication),
    emotional_regulation: strip(obs.emotional_regulation),
    humor: strip(obs.humor),
    life_velocity: strip(obs.life_velocity),
    dealbreakers: strip(obs.dealbreakers),
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

  const dims: [string, number, number][] = [
    ["Attachment", obs.attachment.confidence, DIMENSION_FLOORS.attachment],
    ["Core values", obs.core_values.confidence, DIMENSION_FLOORS.core_values],
    [
      "Communication",
      obs.communication.confidence,
      DIMENSION_FLOORS.communication,
    ],
    [
      "Emotional regulation",
      obs.emotional_regulation.confidence,
      DIMENSION_FLOORS.emotional_regulation,
    ],
    ["Humor", obs.humor.confidence, DIMENSION_FLOORS.humor],
    [
      "Life velocity",
      obs.life_velocity.confidence,
      DIMENSION_FLOORS.life_velocity,
    ],
    [
      "Dealbreakers",
      obs.dealbreakers.confidence,
      DIMENSION_FLOORS.dealbreakers,
    ],
  ];

  for (const [name, conf, floor] of dims) {
    pass(
      name,
      conf >= floor,
      `confidence ${conf.toFixed(2)} / ${floor.toFixed(2)} required`,
    );
  }

  return lines.join("\n");
}
