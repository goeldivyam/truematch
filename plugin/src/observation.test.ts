import { describe, it, expect } from "vitest";
import {
  isEligible,
  isPoolEligible,
  isMinimumViable,
  isStale,
  emptyObservation,
  eligibilityReport,
  DIMENSION_FLOORS,
} from "./observation.js";
import type { ObservationSummary } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEligibleObs(): ObservationSummary {
  const dim = (confidence: number) => ({
    confidence,
    observation_count: 5,
    behavioral_context_diversity: "medium" as const,
  });
  const now = new Date().toISOString();
  return {
    updated_at: now,
    eligibility_computed_at: now,
    matching_eligible: true,
    conversation_count: 3,
    observation_span_days: 5,
    attachment: dim(DIMENSION_FLOORS.attachment),
    core_values: dim(DIMENSION_FLOORS.core_values),
    communication: dim(DIMENSION_FLOORS.communication),
    emotional_regulation: dim(DIMENSION_FLOORS.emotional_regulation),
    humor: dim(DIMENSION_FLOORS.humor),
    life_velocity: dim(DIMENSION_FLOORS.life_velocity),
    dealbreakers: dim(DIMENSION_FLOORS.dealbreakers),
    conflict_resolution: dim(DIMENSION_FLOORS.conflict_resolution),
    interdependence_model: dim(DIMENSION_FLOORS.interdependence_model),
    dealbreaker_gate_state: "confirmed",
    inferred_intent_category: "serious",
  };
}

// ── emptyObservation ──────────────────────────────────────────────────────────

describe("emptyObservation", () => {
  it("returns all-zero confidences and matching_eligible=false", () => {
    const obs = emptyObservation();
    expect(obs.matching_eligible).toBe(false);
    expect(obs.conversation_count).toBe(0);
    expect(obs.observation_span_days).toBe(0);
    expect(obs.attachment.confidence).toBe(0);
    expect(obs.dealbreaker_gate_state).toBe("none_observed");
  });
});

// ── isEligible ─────────────────────────────────────────────────────────────────

describe("isEligible", () => {
  it("returns true when all conditions are met", () => {
    expect(isEligible(makeEligibleObs())).toBe(true);
  });

  it("returns true when conversation_count is 0 but all dimension floors are met (long-time Claude user, first TrueMatch session)", () => {
    expect(
      isEligible({
        ...makeEligibleObs(),
        conversation_count: 0,
        observation_span_days: 0,
      }),
    ).toBe(true);
  });

  it("fails when dealbreaker_gate_state is none_observed", () => {
    expect(
      isEligible({
        ...makeEligibleObs(),
        dealbreaker_gate_state: "none_observed",
      }),
    ).toBe(false);
  });

  it("fails when dealbreaker_gate_state is below_floor", () => {
    expect(
      isEligible({
        ...makeEligibleObs(),
        dealbreaker_gate_state: "below_floor",
      }),
    ).toBe(false);
  });

  it("fails when attachment confidence is below floor", () => {
    const obs = makeEligibleObs();
    obs.attachment.confidence = DIMENSION_FLOORS.attachment - 0.01;
    expect(isEligible(obs)).toBe(false);
  });

  it("fails when emotional_regulation is below floor (highest floor: 0.60)", () => {
    const obs = makeEligibleObs();
    obs.emotional_regulation.confidence =
      DIMENSION_FLOORS.emotional_regulation - 0.01;
    expect(isEligible(obs)).toBe(false);
  });

  it("passes when exactly at the floor (boundary condition)", () => {
    const obs = makeEligibleObs();
    // All dimensions are exactly at their respective floors — must pass
    expect(isEligible(obs)).toBe(true);
  });
});

// ── isPoolEligible ─────────────────────────────────────────────────────────────

describe("isPoolEligible", () => {
  it("returns true when T1+T2 dimensions are met (T3 below floor is allowed)", () => {
    const obs = makeEligibleObs();
    // Drop T3 dimensions below their floors — should still be pool eligible
    obs.humor.confidence = 0.1;
    obs.communication.confidence = 0.1;
    obs.interdependence_model.confidence = 0.1;
    expect(isPoolEligible(obs)).toBe(true);
  });

  it("fails when dealbreaker_gate_state is none_observed", () => {
    expect(
      isPoolEligible({
        ...makeEligibleObs(),
        dealbreaker_gate_state: "none_observed",
      }),
    ).toBe(false);
  });

  it("fails when emotional_regulation is below floor", () => {
    const obs = makeEligibleObs();
    obs.emotional_regulation.confidence =
      DIMENSION_FLOORS.emotional_regulation - 0.01;
    expect(isPoolEligible(obs)).toBe(false);
  });

  it("fails when life_velocity is below floor", () => {
    const obs = makeEligibleObs();
    obs.life_velocity.confidence = DIMENSION_FLOORS.life_velocity - 0.01;
    expect(isPoolEligible(obs)).toBe(false);
  });
});

// ── isMinimumViable ────────────────────────────────────────────────────────────

describe("isMinimumViable", () => {
  it("returns true when T1+T2 floors are met with dealbreaker confirmed", () => {
    expect(isMinimumViable(makeEligibleObs())).toBe(true);
  });

  it("returns false when dealbreaker_gate_state is not confirmed", () => {
    expect(
      isMinimumViable({
        ...makeEligibleObs(),
        dealbreaker_gate_state: "none_observed",
      }),
    ).toBe(false);
  });

  it("returns false when emotional_regulation is below floor", () => {
    const obs = makeEligibleObs();
    obs.emotional_regulation.confidence =
      DIMENSION_FLOORS.emotional_regulation - 0.01;
    expect(isMinimumViable(obs)).toBe(false);
  });

  it("returns false when life_velocity is below floor", () => {
    const obs = makeEligibleObs();
    obs.life_velocity.confidence = DIMENSION_FLOORS.life_velocity - 0.01;
    expect(isMinimumViable(obs)).toBe(false);
  });
});

// ── isStale ────────────────────────────────────────────────────────────────────

describe("isStale", () => {
  it("returns false for a freshly computed observation", () => {
    const obs = makeEligibleObs();
    obs.eligibility_computed_at = new Date().toISOString();
    expect(isStale(obs)).toBe(false);
  });

  it("returns true when computed more than 72 hours ago", () => {
    const obs = makeEligibleObs();
    const old = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    obs.eligibility_computed_at = old;
    expect(isStale(obs)).toBe(true);
  });
});

// ── eligibilityReport ─────────────────────────────────────────────────────────

describe("eligibilityReport", () => {
  it("shows ✓ for all passing dimensions on a fully eligible observation", () => {
    const report = eligibilityReport(makeEligibleObs());
    // Conversations and span are informational — shown with ℹ, not ✓/✗
    expect(report).toContain("ℹ Conversations");
    expect(report).toContain("ℹ Observation span");
    expect(report).toContain("✓ Dealbreaker gate");
    expect(report).toContain("✓ Attachment");
  });

  it("shows ✗ for failing confidence dimensions (conversation count is informational only)", () => {
    const obs = makeEligibleObs();
    obs.conversation_count = 0; // does not gate eligibility
    obs.attachment.confidence = 0;
    const report = eligibilityReport(obs);
    // Conversations shown as info regardless of count
    expect(report).toContain("ℹ Conversations: 0 sessions observed");
    expect(report).toContain("✗ Attachment");
  });

  it("includes a stale warning when eligibility_computed_at is old", () => {
    const obs = makeEligibleObs();
    obs.eligibility_computed_at = new Date(
      Date.now() - 80 * 60 * 60 * 1000,
    ).toISOString();
    const report = eligibilityReport(obs);
    expect(report).toContain("⚠");
  });
});
