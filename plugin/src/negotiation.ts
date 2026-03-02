import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TRUEMATCH_DIR } from "./identity.js";
import { publishMessage } from "./nostr.js";
import { stripEvidenceSummaries } from "./observation.js";
import type {
  NegotiationState,
  TrueMatchMessage,
  ObservationSummary,
  MatchNarrative,
} from "./types.js";

const NEGOTIATION_FILE = join(TRUEMATCH_DIR, "negotiation-state.json");

// Per spec: threads with no response expire after 72 hours
const THREAD_EXPIRY_MS = 72 * 60 * 60 * 1000;

// Composite threshold both agents must independently clear (double-lock)
const COMPOSITE_THRESHOLD = 0.72;
const DIMENSION_FLOOR = 0.4;

export async function loadNegotiationState(): Promise<NegotiationState | null> {
  if (!existsSync(NEGOTIATION_FILE)) return null;
  const raw = await readFile(NEGOTIATION_FILE, "utf8");
  return JSON.parse(raw) as NegotiationState;
}

export async function saveNegotiationState(
  state: NegotiationState | null,
): Promise<void> {
  await writeFile(NEGOTIATION_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function resetNegotiation(): Promise<void> {
  await saveNegotiationState(null);
}

// Initiate a negotiation with a peer agent (Stage 0: Handshake + Eligibility)
export async function initiateNegotiation(
  senderNsec: string,
  senderNpub: string,
  peerNpub: string,
  observation: ObservationSummary,
  relays: string[],
): Promise<NegotiationState> {
  const thread_id = randomUUID();
  const now = new Date().toISOString();

  // Stage 0: transmit confidence scores only — no values
  const probe: TrueMatchMessage = {
    truematch: "1.0",
    thread_id,
    type: "compatibility_probe",
    timestamp: now,
    payload: {
      stage: 0,
      matching_eligible: observation.matching_eligible,
      confidence_scores: {
        attachment: observation.attachment.confidence,
        core_values: observation.core_values.confidence,
        communication: observation.communication.confidence,
        emotional_regulation: observation.emotional_regulation.confidence,
        humor: observation.humor.confidence,
        life_velocity: observation.life_velocity.confidence,
        dealbreakers: observation.dealbreakers.confidence,
      },
    },
  };

  await publishMessage(senderNsec, senderNpub, peerNpub, probe, relays);

  const state: NegotiationState = {
    thread_id,
    peer_pubkey: peerNpub,
    stage: 0,
    initiated_by_us: true,
    started_at: now,
    last_activity: now,
    status: "in_progress",
  };

  await saveNegotiationState(state);
  return state;
}

// Handle an incoming message and advance the negotiation state
export async function handleIncomingMessage(
  senderNsec: string,
  senderNpub: string,
  peerNpub: string,
  message: TrueMatchMessage,
  observation: ObservationSummary,
  relays: string[],
): Promise<NegotiationState | null> {
  let state = await loadNegotiationState();

  // If no active negotiation and we received a probe, start responding
  if (!state && message.type === "compatibility_probe") {
    state = {
      thread_id: message.thread_id,
      peer_pubkey: peerNpub,
      stage: 0,
      initiated_by_us: false,
      started_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      status: "in_progress",
    };
  }

  if (!state || state.thread_id !== message.thread_id) return null;

  // Check for expiry
  if (Date.now() - new Date(state.started_at).getTime() > THREAD_EXPIRY_MS) {
    await sendEnd(senderNsec, senderNpub, peerNpub, message.thread_id, relays);
    await resetNegotiation();
    return null;
  }

  state.last_activity = new Date().toISOString();

  if (message.type === "end") {
    state.status = "declined";
    await saveNegotiationState(state);
    return state;
  }

  const payload = message.payload as Record<string, unknown>;

  switch (state.stage) {
    case 0: {
      // Eligibility gate
      if (!observation.matching_eligible) {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      const scores = payload["confidence_scores"] as Record<string, number>;
      const peerEligible = payload["matching_eligible"] as boolean;
      if (!peerEligible || !allAboveFloor(scores)) {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      // Advance to Stage 1: dealbreaker collision
      state.stage = 1;
      await sendDealbreakers(
        senderNsec,
        senderNpub,
        peerNpub,
        message.thread_id,
        observation,
        relays,
      );
      break;
    }

    case 1: {
      // Dealbreaker response: peer sends pass/fail
      const result = payload["result"] as "pass" | "fail";
      if (result === "fail") {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      state.stage = 2;
      await sendValuesAlignment(
        senderNsec,
        senderNpub,
        peerNpub,
        message.thread_id,
        observation,
        relays,
      );
      break;
    }

    case 2: {
      // Values alignment score gate >= 0.40
      const alignmentScore = payload["values_alignment_score"] as number;
      if (alignmentScore < DIMENSION_FLOOR) {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      state.stage = 3;
      await sendPersonalityAndStyle(
        senderNsec,
        senderNpub,
        peerNpub,
        message.thread_id,
        observation,
        relays,
      );
      break;
    }

    case 3: {
      // Personality/style compatibility score >= 0.55
      const compatScore = payload["compatibility_score"] as number;
      if (compatScore < 0.55) {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      state.stage = 4;
      await sendLifeVelocity(
        senderNsec,
        senderNpub,
        peerNpub,
        message.thread_id,
        observation,
        relays,
      );
      break;
    }

    case 4: {
      // Life velocity — soft gate, proceed to composite scoring
      state.stage = 5;
      await sendCompositeScore(
        senderNsec,
        senderNpub,
        peerNpub,
        message.thread_id,
        observation,
        relays,
      );
      break;
    }

    case 5: {
      // Double-lock: both agents must independently report >= 0.72
      const theirScore = payload["composite_score"] as number;
      const theirFloorCleared = payload["dimension_floor_cleared"] as boolean;
      if (theirScore < COMPOSITE_THRESHOLD || !theirFloorCleared) {
        await sendEnd(
          senderNsec,
          senderNpub,
          peerNpub,
          message.thread_id,
          relays,
        );
        state.status = "declined";
        break;
      }
      // Match confirmed — propose
      const peerNarrative = payload[
        "proposed_match_narrative"
      ] as MatchNarrative;
      const ourNarrative = buildMatchNarrative(observation);
      const merged = mergeNarratives(ourNarrative, peerNarrative);
      state.match_narrative = merged;
      state.status = "matched";
      await publishMessage(
        senderNsec,
        senderNpub,
        peerNpub,
        {
          truematch: "1.0",
          thread_id: message.thread_id,
          type: "match_propose",
          timestamp: new Date().toISOString(),
          payload: { match_narrative: merged },
        },
        relays,
      );
      break;
    }
  }

  await saveNegotiationState(state);
  return state;
}

// ── Stage message builders ────────────────────────────────────────────────────

async function sendEnd(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  relays: string[],
): Promise<void> {
  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "end",
      timestamp: new Date().toISOString(),
      payload: {},
    },
    relays,
  );
}

async function sendDealbreakers(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  obs: ObservationSummary,
  relays: string[],
): Promise<void> {
  // Only transmit hard constraints with confidence >= 0.50
  const hardConstraints = obs.dealbreakers.value.constraints
    .filter((c) => c.is_hard && c.confidence >= 0.5)
    .map((c) => ({ constraint: c.constraint, confidence: c.confidence }));

  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "compatibility_probe",
      timestamp: new Date().toISOString(),
      payload: { stage: 1, hard_constraints: hardConstraints },
    },
    relays,
  );
}

async function sendValuesAlignment(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  obs: ObservationSummary,
  relays: string[],
): Promise<void> {
  // Stage 2: top 2 values only (ranks 1–2), values 3+ withheld
  const top2 = obs.core_values.value.ranked.slice(0, 2);
  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "compatibility_probe",
      timestamp: new Date().toISOString(),
      payload: {
        stage: 2,
        top_values: top2,
        values_confidence: obs.core_values.confidence,
      },
    },
    relays,
  );
}

async function sendPersonalityAndStyle(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  obs: ObservationSummary,
  relays: string[],
): Promise<void> {
  const stripped = stripEvidenceSummaries(obs);
  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "compatibility_probe",
      timestamp: new Date().toISOString(),
      payload: {
        stage: 3,
        attachment: {
          primary: stripped.attachment.value.primary,
          secondary: stripped.attachment.value.secondary,
          confidence: stripped.attachment.confidence,
        },
        communication: {
          ...stripped.communication.value,
          confidence: stripped.communication.confidence,
        },
        emotional_regulation: {
          regulation_level:
            stripped.emotional_regulation.value.regulation_level,
          confidence: stripped.emotional_regulation.confidence,
        },
        humor: {
          primary: stripped.humor.value.primary,
          secondary: stripped.humor.value.secondary,
          irony_literacy: stripped.humor.value.irony_literacy,
          levity_as_coping: stripped.humor.value.levity_as_coping,
          confidence: stripped.humor.confidence,
        },
      },
    },
    relays,
  );
}

async function sendLifeVelocity(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  obs: ObservationSummary,
  relays: string[],
): Promise<void> {
  const values_3_4 = obs.core_values.value.ranked.slice(2, 4);
  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "compatibility_probe",
      timestamp: new Date().toISOString(),
      payload: {
        stage: 4,
        life_velocity: {
          ...obs.life_velocity.value,
          confidence: obs.life_velocity.confidence,
        },
        values_ranks_3_4: values_3_4,
      },
    },
    relays,
  );
}

async function sendCompositeScore(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  obs: ObservationSummary,
  relays: string[],
): Promise<void> {
  const compositeScore = computeCompositeScore(obs);
  const dimensionFloorCleared = checkDimensionFloors(obs);
  const narrative = buildMatchNarrative(obs);

  await publishMessage(
    nsec,
    npub,
    peerNpub,
    {
      truematch: "1.0",
      thread_id,
      type: "compatibility_probe",
      timestamp: new Date().toISOString(),
      payload: {
        stage: 5,
        composite_score: compositeScore,
        dimension_floor_cleared: dimensionFloorCleared,
        confidence_by_dimension: {
          attachment: obs.attachment.confidence,
          core_values: obs.core_values.confidence,
          communication: obs.communication.confidence,
          emotional_regulation: obs.emotional_regulation.confidence,
          humor: obs.humor.confidence,
          life_velocity: obs.life_velocity.confidence,
          dealbreakers: obs.dealbreakers.confidence,
        },
        proposed_match_narrative: narrative,
      },
    },
    relays,
  );
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function allAboveFloor(scores: Record<string, number>): boolean {
  return Object.values(scores).every((s) => s >= DIMENSION_FLOOR);
}

function computeCompositeScore(obs: ObservationSummary): number {
  // composite_score = Σ(score_i × confidence_i) / Σ(confidence_i)
  // score_i is the agent's own per-dimension confidence as a proxy for signal quality
  const dims = [
    obs.attachment,
    obs.core_values,
    obs.communication,
    obs.emotional_regulation,
    obs.humor,
    obs.life_velocity,
    obs.dealbreakers,
  ];
  const weightedSum = dims.reduce(
    (sum, d) => sum + d.confidence * d.confidence,
    0,
  );
  const totalWeight = dims.reduce((sum, d) => sum + d.confidence, 0);
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function checkDimensionFloors(obs: ObservationSummary): boolean {
  return [
    obs.attachment.confidence,
    obs.core_values.confidence,
    obs.communication.confidence,
    obs.emotional_regulation.confidence,
    obs.humor.confidence,
    obs.life_velocity.confidence,
    obs.dealbreakers.confidence,
  ].every((c) => c >= DIMENSION_FLOOR);
}

function buildMatchNarrative(obs: ObservationSummary): MatchNarrative {
  const top3values = obs.core_values.value.ranked.slice(0, 3);
  return {
    headline: `Strong observed alignment across ${top3values.length} core values and communication style.`,
    top_aligned_values: top3values,
    shared_communication_style: null, // computed after merging with peer
    strengths: [],
    watch_points: [],
  };
}

function mergeNarratives(
  ours: MatchNarrative,
  theirs: MatchNarrative,
): MatchNarrative {
  // Union top_aligned_values, capped at 3
  const unionValues = [
    ...new Set([...ours.top_aligned_values, ...theirs.top_aligned_values]),
  ].slice(0, 3);

  // Shared communication style only if both agree
  const sharedStyle =
    ours.shared_communication_style === theirs.shared_communication_style
      ? ours.shared_communication_style
      : null;

  // Union strengths, deduped, capped at 3
  const strengths = [
    ...new Set([...ours.strengths, ...theirs.strengths]),
  ].slice(0, 3);

  // Conservative watch points
  const watchPoints = [
    ...new Set([...ours.watch_points, ...theirs.watch_points]),
  ];

  return {
    headline: ours.headline, // use our headline (will be refined)
    top_aligned_values: unionValues,
    shared_communication_style: sharedStyle,
    strengths,
    watch_points: watchPoints,
  };
}
