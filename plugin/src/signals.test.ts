import { describe, it, expect } from "vitest";
import {
  pickPendingSignal,
  buildSignalInstruction,
  recordSignalDelivered,
} from "./signals.js";
import { emptyObservation } from "./observation.js";
import type { ObservationSummary, SignalsFile } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeObs(overrides?: Partial<ObservationSummary>): ObservationSummary {
  const base = emptyObservation();
  // Set a high-confidence attachment dimension to ensure one dimension qualifies
  return {
    ...base,
    conversation_count: 3,
    observation_span_days: 10,
    dealbreaker_gate_state: "confirmed",
    attachment: {
      confidence: 0.7,
      observation_count: 8,
      behavioral_context_diversity: "medium",
    },
    ...overrides,
  };
}

function emptySignals(): SignalsFile {
  return { schema_version: 1, per_dimension: {} };
}

// ── pickPendingSignal ─────────────────────────────────────────────────────────

describe("pickPendingSignal", () => {
  it("returns null when conversation_count < 2", () => {
    const obs = makeObs({ conversation_count: 1 });
    expect(pickPendingSignal(obs, emptySignals())).toBeNull();
  });

  it("returns null when all dimensions are below the minimum signal confidence", () => {
    const obs = emptyObservation();
    obs.conversation_count = 3;
    // All confidence values are 0 — none qualify
    expect(pickPendingSignal(obs, emptySignals())).toBeNull();
  });

  it("returns the qualifying dimension on first crossing", () => {
    const result = pickPendingSignal(makeObs(), emptySignals());
    expect(result).not.toBeNull();
    expect(result?.dimension).toBe("attachment");
    expect(result?.confidence).toBe(0.7);
  });

  it("returns null when the quiet period has not elapsed since last signal", () => {
    const signals: SignalsFile = {
      schema_version: 1,
      per_dimension: {
        attachment: {
          last_signaled_confidence: 0.5,
          signaled_at: new Date().toISOString(), // just now — quiet period active
        },
      },
    };
    const obs = makeObs();
    const result = pickPendingSignal(obs, signals);
    // attachment is in quiet period; no other dimension qualifies
    expect(result).toBeNull();
  });

  it("returns null when delta is too small since last signal", () => {
    // Signaled at 0.65, now at 0.70 → delta = 0.05, which is below MIN_DELTA (0.15)
    const oldDate = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 10 days ago
    const signals: SignalsFile = {
      schema_version: 1,
      per_dimension: {
        attachment: {
          last_signaled_confidence: 0.65,
          signaled_at: oldDate,
        },
      },
    };
    expect(pickPendingSignal(makeObs(), signals)).toBeNull();
  });

  it("returns the dimension with the highest delta when multiple qualify", () => {
    const obs: ObservationSummary = {
      ...emptyObservation(),
      conversation_count: 3,
      observation_span_days: 10,
      dealbreaker_gate_state: "confirmed",
      attachment: {
        confidence: 0.6,
        observation_count: 5,
        behavioral_context_diversity: "medium",
      },
      core_values: {
        confidence: 0.75,
        observation_count: 8,
        behavioral_context_diversity: "high",
      },
    };
    const result = pickPendingSignal(obs, emptySignals());
    // core_values has higher confidence (and therefore higher delta on first crossing)
    expect(result?.dimension).toBe("core_values");
  });
});

// ── buildSignalInstruction ────────────────────────────────────────────────────

describe("buildSignalInstruction", () => {
  it("includes the confidence value", () => {
    const instruction = buildSignalInstruction("attachment", 0.72);
    expect(instruction).toContain("0.72");
  });

  it("includes the dimension label for attachment", () => {
    const instruction = buildSignalInstruction("attachment", 0.72);
    expect(instruction).toContain("closeness and trust");
  });

  it("includes the dimension label for humor", () => {
    const instruction = buildSignalInstruction("humor", 0.55);
    expect(instruction).toContain("humor");
  });

  it("is addressed to Claude, not the user", () => {
    const instruction = buildSignalInstruction("core_values", 0.6);
    expect(instruction).toContain("[TrueMatch");
    expect(instruction).toContain("not for the user");
  });
});

// ── recordSignalDelivered ─────────────────────────────────────────────────────

describe("recordSignalDelivered", () => {
  it("records the dimension in per_dimension", () => {
    const signals = emptySignals();
    const updated = recordSignalDelivered(signals, "humor", 0.55);
    expect(updated.per_dimension["humor"]).toBeDefined();
    expect(updated.per_dimension["humor"]?.last_signaled_confidence).toBe(0.55);
  });

  it("does not mutate the original signals object (immutable update)", () => {
    const signals = emptySignals();
    recordSignalDelivered(signals, "humor", 0.55);
    expect(signals.per_dimension["humor"]).toBeUndefined();
  });

  it("preserves other dimension states", () => {
    const signals: SignalsFile = {
      schema_version: 1,
      per_dimension: {
        attachment: {
          last_signaled_confidence: 0.6,
          signaled_at: new Date().toISOString(),
        },
      },
    };
    const updated = recordSignalDelivered(signals, "humor", 0.5);
    expect(updated.per_dimension["attachment"]).toBeDefined();
    expect(updated.per_dimension["humor"]).toBeDefined();
  });
});
