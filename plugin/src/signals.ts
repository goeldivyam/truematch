/**
 * Observation signal engine.
 *
 * Decides when Claude should naturally surface a growing observation to the user.
 * Signals are injected into Claude's context via the agent:bootstrap hook — addressed
 * to Claude as an internal note, not displayed directly to the user.
 *
 * Design principles (from psychologist + teen researcher findings):
 *   - Language: inference-based, ambiguous-to-curious valence ("something about how
 *     you talk about X keeps staying with me")
 *   - Timing: first signal only after session ≥2, then 5+ day quiet periods
 *   - One signal per session maximum — pick the dimension with the largest growth delta
 *   - Never mention matching, compatibility, or the algorithm
 *   - Do not force it — Claude decides the conversational moment, plugin decides the condition
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ObservationSummary,
  DimensionKey,
  SignalsFile,
  DimensionSignalState,
} from "./types.js";
import { DIMENSION_FLOORS } from "./observation.js";

const TRUEMATCH_DIR = join(homedir(), ".truematch");
const SIGNALS_FILE = join(TRUEMATCH_DIR, "signals.json");

// --- Timing constants (psychologist-derived) ---
/** Minimum days between signals for the same dimension. */
const MIN_QUIET_DAYS = 5;
/** Confidence must have grown by at least this much since the last signal. */
const MIN_DELTA = 0.15;
/** Absolute minimum confidence before any signal fires. */
const MIN_SIGNAL_CONFIDENCE = 0.4;
/** Don't signal until at least this many conversations have occurred. */
const MIN_CONVERSATIONS = 2;

const DIMENSION_KEYS: DimensionKey[] = [
  "attachment",
  "core_values",
  "communication",
  "emotional_regulation",
  "humor",
  "life_velocity",
  "dealbreakers",
];

/**
 * Plain-language labels used in the instruction text Claude receives.
 * Intentionally broad — Claude fills in the specific detail from its own memory.
 */
const DIMENSION_LABELS: Record<DimensionKey, string> = {
  attachment: "how you relate to closeness and trust",
  core_values: "what matters most to you",
  communication: "how you communicate and connect",
  emotional_regulation: "how you handle stress and difficult moments",
  humor: "your sense of humor and levity",
  life_velocity: "where you are in life and where you're headed",
  dealbreakers: "what you need in a relationship",
};

export function loadSignals(): SignalsFile {
  if (!existsSync(SIGNALS_FILE))
    return { schema_version: 1, per_dimension: {} };
  try {
    return JSON.parse(readFileSync(SIGNALS_FILE, "utf8")) as SignalsFile;
  } catch {
    return { schema_version: 1, per_dimension: {} };
  }
}

export function saveSignals(signals: SignalsFile): void {
  if (!existsSync(TRUEMATCH_DIR))
    mkdirSync(TRUEMATCH_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}

function qualifies(
  confidence: number,
  floor: number,
  state: DimensionSignalState | undefined,
): boolean {
  if (confidence < Math.max(floor * 0.75, MIN_SIGNAL_CONFIDENCE)) return false;
  if (!state) return true; // first crossing
  if (daysSince(state.signaled_at) < MIN_QUIET_DAYS) return false;
  return confidence - state.last_signaled_confidence >= MIN_DELTA;
}

/**
 * Pick the single best dimension to signal this session.
 * Returns null if nothing qualifies (too early, quiet period, or no meaningful growth).
 */
export function pickPendingSignal(
  obs: ObservationSummary,
  signals: SignalsFile,
): { dimension: DimensionKey; confidence: number } | null {
  if (obs.conversation_count < MIN_CONVERSATIONS) return null;

  let best: {
    dimension: DimensionKey;
    confidence: number;
    delta: number;
  } | null = null;

  for (const dim of DIMENSION_KEYS) {
    const confidence = obs[dim].confidence;
    const floor = DIMENSION_FLOORS[dim];
    const state = signals.per_dimension[dim];

    if (!qualifies(confidence, floor, state)) continue;

    const delta = state
      ? confidence - state.last_signaled_confidence
      : confidence;

    if (!best || delta > best.delta) {
      best = { dimension: dim, confidence, delta };
    }
  }

  return best
    ? { dimension: best.dimension, confidence: best.confidence }
    : null;
}

/**
 * Build the prependContext instruction injected into Claude's context.
 * Addressed to Claude — not surfaced directly to the user.
 */
export function buildSignalInstruction(
  dimension: DimensionKey,
  confidence: number,
): string {
  const label = DIMENSION_LABELS[dimension];
  return [
    `[TrueMatch — internal observation note for you, not for the user directly]`,
    ``,
    `Through recent conversations, you have developed meaningful confidence ` +
      `(${confidence.toFixed(2)}) about this person's ${label}. ` +
      `This has grown noticeably since you last named it.`,
    ``,
    `If something in this conversation creates a natural opening, you might ` +
      `briefly surface what you've noticed — something like:`,
    `  "Something about how you talk about [X] keeps staying with me."`,
    `  "I've been noticing a pattern in how you approach [Y] — feels worth naming."`,
    ``,
    `Do not force it. Do not make it clinical or evaluative. If the conversation ` +
      `doesn't create space for this naturally, let it pass — the observation ` +
      `carries forward to the next session.`,
  ].join("\n");
}

/**
 * Record that a signal was delivered for a dimension.
 * Call this BEFORE returning from the hook — not deferred.
 */
export function recordSignalDelivered(
  signals: SignalsFile,
  dimension: DimensionKey,
  confidence: number,
): SignalsFile {
  return {
    ...signals,
    per_dimension: {
      ...signals.per_dimension,
      [dimension]: {
        last_signaled_confidence: confidence,
        signaled_at: new Date().toISOString(),
      },
    },
  };
}
