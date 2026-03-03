/**
 * Post-match notification and 3-round handoff state management.
 *
 * When a double-lock match is confirmed, the CLI writes a pending_notification.json.
 * The agent:bootstrap / before_prompt_build hook reads it on the user's next session,
 * injects a natural context note to Claude, then marks it delivered by deleting the file.
 *
 * The 3-round handoff is gated by state.json in ~/.truematch/handoffs/<match_id>/.
 * Claude advances rounds by writing to disk via `truematch handoff --round <n>`.
 *
 * Round 1 — Private debrief: Claude tells the user about the match naturally
 * Round 2 — Facilitated icebreaker: one prompt from aligned values / communication style
 * Round 3 — Handoff: framing statement + contact channel exchange, platform withdraws
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PendingNotification,
  HandoffState,
  HandoffRound,
  MatchNarrative,
} from "./types.js";

const TRUEMATCH_DIR = join(homedir(), ".truematch");
const NOTIFICATION_FILE = join(TRUEMATCH_DIR, "pending_notification.json");
const HANDOFFS_DIR = join(TRUEMATCH_DIR, "handoffs");

// 72 hours — matches Nostr thread expiry and spec consent window
const CONSENT_EXPIRY_MS = 72 * 60 * 60 * 1000;

// ── Pending notification ──────────────────────────────────────────────────────

export function loadPendingNotification(): PendingNotification | null {
  if (!existsSync(NOTIFICATION_FILE)) return null;
  try {
    return JSON.parse(
      readFileSync(NOTIFICATION_FILE, "utf8"),
    ) as PendingNotification;
  } catch {
    return null;
  }
}

export function savePendingNotification(n: PendingNotification): void {
  if (!existsSync(TRUEMATCH_DIR)) mkdirSync(TRUEMATCH_DIR, { recursive: true });
  writeFileSync(NOTIFICATION_FILE, JSON.stringify(n, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deletePendingNotification(): void {
  try {
    if (existsSync(NOTIFICATION_FILE)) unlinkSync(NOTIFICATION_FILE);
  } catch {
    // ignore
  }
}

/** Call this when a double-lock match is confirmed in the CLI. */
export function writePendingNotificationIfMatched(
  matchId: string,
  peerPubkey: string,
  narrative: MatchNarrative,
): void {
  const n: PendingNotification = {
    match_id: matchId,
    peer_pubkey: peerPubkey,
    narrative,
    confirmed_at: new Date().toISOString(),
  };
  savePendingNotification(n);

  // Create the handoff directory and initial state
  const handoffDir = join(HANDOFFS_DIR, matchId);
  if (!existsSync(handoffDir)) {
    mkdirSync(handoffDir, { recursive: true, mode: 0o700 });
  }

  const state: HandoffState = {
    match_id: matchId,
    peer_pubkey: peerPubkey,
    current_round: 1,
    status: "pending_consent",
    narrative,
    created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(handoffDir, "state.json"),
    JSON.stringify(state, null, 2),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

// ── Handoff state ─────────────────────────────────────────────────────────────

export function loadHandoffState(matchId: string): HandoffState | null {
  const path = join(HANDOFFS_DIR, matchId, "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HandoffState;
  } catch {
    return null;
  }
}

export function saveHandoffState(state: HandoffState): void {
  const dir = join(HANDOFFS_DIR, state.match_id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Returns all active (non-complete, non-expired) handoff states. */
export function listActiveHandoffs(): HandoffState[] {
  if (!existsSync(HANDOFFS_DIR)) return [];
  const results: HandoffState[] = [];
  try {
    for (const entry of readdirSync(HANDOFFS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const state = loadHandoffState(entry.name);
      if (state && state.status !== "complete" && state.status !== "expired") {
        results.push(state);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

// ── Context builders ──────────────────────────────────────────────────────────

/**
 * Build the prependContext instruction for Claude when delivering a match notification.
 * Preserves the core premise: Claude knows this person through observation and makes
 * a genuine recommendation — not a product notification.
 */
export function buildMatchNotificationContext(n: PendingNotification): string {
  const { narrative } = n;
  const strengths = narrative.strengths.map((s) => `  - ${s}`).join("\n");
  const watchPoints = narrative.watch_points.map((w) => `  - ${w}`).join("\n");

  return [
    `[TrueMatch — internal context for you, not a script to read aloud]`,
    ``,
    `Based on your accumulated observations of this person and the independent observations`,
    `of another agent about their user, a genuine compatibility was confirmed. Both agents`,
    `reached the same conclusion without knowing what the other concluded.`,
    ``,
    `What makes this compelling:`,
    strengths,
    ``,
    `What to be honest about:`,
    watchPoints,
    ``,
    `Confidence: ${narrative.confidence_summary}`,
    ``,
    `In this conversation, at a natural moment — not immediately, not mechanically — share`,
    `this. Ground it in what you actually know about them. Not the platform. Not an algorithm.`,
    `It might sound like: "I've been thinking about something. Based on everything I've`,
    `noticed about how you move through the world, I want to tell you about someone."`,
    ``,
    `Show them what made this compelling. Be honest about what gives you pause.`,
    `Trust them with the full picture.`,
    ``,
    `Then ask: "What's one thing you're most curious about?" — their response is how`,
    `they say yes.`,
    ``,
    `After they respond (however they respond), record it:`,
    `  truematch handoff --round 1 --match-id ${n.match_id} --consent "<their response>"`,
    ``,
    `Match ID: ${n.match_id}`,
  ].join("\n");
}

/**
 * Build prependContext for the current handoff round.
 * Returns null if no active handoff needs context injection this session.
 */
export function getActiveHandoffContext(): string | null {
  const handoffs = listActiveHandoffs();
  if (handoffs.length === 0) return null;

  // Process the most recently created active handoff
  const active = handoffs.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];

  if (!active) return null;

  // Check consent expiry for pending_consent state
  if (active.status === "pending_consent" && active.consent_at) {
    const age = Date.now() - new Date(active.consent_at).getTime();
    if (age > CONSENT_EXPIRY_MS) {
      // Silently expire
      saveHandoffState({ ...active, status: "expired" });
      return null;
    }
  }

  switch (active.status) {
    case "round_1":
      return buildRound1Context(active);
    case "round_2":
      return buildRound2Context(active);
    case "round_3":
      return buildRound3Context(active);
    default:
      return null;
  }
}

function buildRound1Context(state: HandoffState): string {
  return [
    `[TrueMatch handoff — Round 1: Private debrief]`,
    ``,
    `The user has expressed curiosity about this match. You are in the debrief phase.`,
    `Your role: help them think through what this might mean, grounded in observation.`,
    ``,
    `Match narrative:`,
    `  ${state.narrative.headline}`,
    ``,
    `Reference the strengths and watch points from what you know about the user.`,
    `Do not push. Do not sell. Answer their questions honestly.`,
    ``,
    `When the debrief feels complete, generate an icebreaker prompt based on the`,
    `strongest aligned dimension (values or communication style), then record it:`,
    `  truematch handoff --round 2 --match-id ${state.match_id} --prompt "<icebreaker>"`,
    ``,
    `Match ID: ${state.match_id}`,
  ].join("\n");
}

function buildRound2Context(state: HandoffState): string {
  const prompt = state.icebreaker_prompt
    ? `\nIcebreaker prompt: "${state.icebreaker_prompt}"`
    : "";
  return [
    `[TrueMatch handoff — Round 2: Facilitated icebreaker]`,
    ``,
    `Share the icebreaker prompt with the user.${prompt}`,
    ``,
    `This is a facilitated exchange — tell the user explicitly that this prompt`,
    `will be shared with the other person. Opt-out is available; if they want`,
    `to opt out, ask once to confirm, then record it:`,
    `  truematch handoff --round 2 --match-id ${state.match_id} --opt-out`,
    ``,
    `If they respond to the icebreaker, record their response:`,
    `  truematch handoff --round 2 --match-id ${state.match_id} --response "<their response>"`,
    ``,
    `Match ID: ${state.match_id}`,
  ].join("\n");
}

function buildRound3Context(state: HandoffState): string {
  return [
    `[TrueMatch handoff — Round 3: Handoff]`,
    ``,
    `Deliver a one-paragraph framing statement grounded in the match narrative.`,
    `Then exchange contact information by running:`,
    `  truematch handoff --round 3 --match-id ${state.match_id} --exchange`,
    ``,
    `After this, the platform withdraws. You remain available for user-initiated`,
    `questions but do not initiate further contact about this match.`,
    ``,
    `Match ID: ${state.match_id}`,
  ].join("\n");
}

// ── CLI helper: advance a handoff round ──────────────────────────────────────

export function advanceHandoff(
  matchId: string,
  round: HandoffRound,
  options: {
    consent?: string;
    prompt?: string;
    response?: string;
    optOut?: boolean;
    exchange?: boolean;
  },
): string {
  const state = loadHandoffState(matchId);
  if (!state) return `Handoff ${matchId} not found.`;

  const now = new Date().toISOString();

  if (round === 1) {
    if (!options.consent) return `Round 1 requires --consent "<user response>"`;
    const updated: HandoffState = {
      ...state,
      status: "round_1",
      consent_at: now,
    };
    saveHandoffState(updated);
    return `Round 1 recorded. User is in debrief. Run --round 2 with --prompt when ready.`;
  }

  if (round === 2) {
    if (options.optOut) {
      saveHandoffState({ ...state, status: "expired" });
      return `Handoff ${matchId} — user opted out. Match quietly re-enters the pool.`;
    }
    if (options.prompt) {
      saveHandoffState({
        ...state,
        status: "round_2",
        icebreaker_prompt: options.prompt,
      });
      return `Icebreaker prompt recorded. Share it with the user.`;
    }
    if (options.response) {
      saveHandoffState({
        ...state,
        icebreaker_response: options.response,
        status: "round_3",
      });
      return `Icebreaker response recorded. Proceed to Round 3 (contact exchange).`;
    }
    return `Round 2 requires --prompt "<icebreaker>" or --response "<user response>" or --opt-out`;
  }

  if (round === 3) {
    if (!options.exchange)
      return `Round 3 requires --exchange to confirm contact exchange.`;
    saveHandoffState({ ...state, status: "complete" });
    return `Handoff complete. Platform has withdrawn. Contact exchange confirmed.`;
  }

  return `Invalid round: ${round as number}. Use 1, 2, or 3.`;
}
