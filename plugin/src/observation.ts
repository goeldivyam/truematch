import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TRUEMATCH_DIR } from "./identity.js";
import type { ObservationSummary } from "./types.js";

const OBSERVATION_FILE = join(TRUEMATCH_DIR, "observation.json");
const AGENT_VERSION = "0.1.0";

// Minimum thresholds to enter the matching pool (per skill spec)
const MIN_CONVERSATIONS = 5;
const MIN_DAYS_SPAN = 3;
const MIN_TOTAL_SIGNALS = 15;
const MIN_DIMENSION_CONFIDENCE = 0.4;

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
  if (obs.conversation_count < MIN_CONVERSATIONS) return false;
  if (obs.observation_span_days < MIN_DAYS_SPAN) return false;
  if (obs.total_signals < MIN_TOTAL_SIGNALS) return false;
  const dimensions = [
    obs.attachment,
    obs.core_values,
    obs.communication,
    obs.emotional_regulation,
    obs.humor,
    obs.life_velocity,
    obs.dealbreakers,
  ];
  return dimensions.every((d) => d.confidence >= MIN_DIMENSION_CONFIDENCE);
}

export function emptyObservation(): ObservationSummary {
  const now = new Date().toISOString();
  const emptyDim = <T>(value: T) => ({
    value,
    confidence: 0,
    observation_count: 0,
    last_updated: now,
    evidence_summary: "",
  });

  return {
    agent_version: AGENT_VERSION,
    created_at: now,
    updated_at: now,
    conversation_count: 0,
    observation_span_days: 0,
    total_signals: 0,
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
    obs.conversation_count >= MIN_CONVERSATIONS,
    `${obs.conversation_count} / ${MIN_CONVERSATIONS} required`,
  );
  pass(
    "Observation span",
    obs.observation_span_days >= MIN_DAYS_SPAN,
    `${obs.observation_span_days} days / ${MIN_DAYS_SPAN} required`,
  );
  pass(
    "Total signals",
    obs.total_signals >= MIN_TOTAL_SIGNALS,
    `${obs.total_signals} / ${MIN_TOTAL_SIGNALS} required`,
  );

  const dims = [
    ["Attachment", obs.attachment.confidence],
    ["Core values", obs.core_values.confidence],
    ["Communication", obs.communication.confidence],
    ["Emotional regulation", obs.emotional_regulation.confidence],
    ["Humor", obs.humor.confidence],
    ["Life velocity", obs.life_velocity.confidence],
    ["Dealbreakers", obs.dealbreakers.confidence],
  ] as [string, number][];

  for (const [name, conf] of dims) {
    pass(
      name,
      conf >= MIN_DIMENSION_CONFIDENCE,
      `confidence ${conf.toFixed(2)} / ${MIN_DIMENSION_CONFIDENCE} required`,
    );
  }

  return lines.join("\n");
}
