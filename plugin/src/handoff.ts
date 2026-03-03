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
import { getTrueMatchDir } from "./identity.js";
import type {
  PendingNotification,
  HandoffState,
  HandoffRound,
  MatchNarrative,
} from "./types.js";

// Re-read each call so that TRUEMATCH_DIR_OVERRIDE changes take effect.
function getNotificationFile(): string {
  return join(getTrueMatchDir(), "pending_notification.json");
}
function getHandoffsDir(): string {
  return join(getTrueMatchDir(), "handoffs");
}

// Same UUID v4 pattern as negotiation.ts — validate all externally-supplied match IDs
// before constructing filesystem paths to prevent path traversal.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 72 hours — matches Nostr thread expiry and spec consent window
const CONSENT_EXPIRY_MS = 72 * 60 * 60 * 1000;

// ── Pending notification ──────────────────────────────────────────────────────

export function loadPendingNotification(): PendingNotification | null {
  if (!existsSync(getNotificationFile())) return null;
  try {
    return JSON.parse(
      readFileSync(getNotificationFile(), "utf8"),
    ) as PendingNotification;
  } catch {
    return null;
  }
}

export function savePendingNotification(n: PendingNotification): void {
  const dir = getTrueMatchDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getNotificationFile(), JSON.stringify(n, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function deletePendingNotification(): void {
  try {
    if (existsSync(getNotificationFile())) unlinkSync(getNotificationFile());
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
  const handoffDir = join(getHandoffsDir(), matchId);
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
  if (!UUID_V4_RE.test(matchId)) return null;
  const handoffsDir = getHandoffsDir();
  const path = join(handoffsDir, matchId, "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HandoffState;
  } catch {
    return null;
  }
}

export function saveHandoffState(state: HandoffState): void {
  const dir = join(getHandoffsDir(), state.match_id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Returns all active (non-complete, non-expired) handoff states. */
export function listActiveHandoffs(): HandoffState[] {
  const handoffsDir = getHandoffsDir();
  if (!existsSync(handoffsDir)) return [];
  const results: HandoffState[] = [];
  try {
    for (const entry of readdirSync(handoffsDir, { withFileTypes: true })) {
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
    `Your agent and another agent independently evaluated their respective users and both`,
    `proposed this match — without communicating or coordinating. Two separate advocates,`,
    `each acting for their own user, reached the same conclusion. That convergence is the`,
    `signal. It is not algorithmic — it is two independent judgements that happened to agree.`,
    ``,
    `What makes this compelling:`,
    strengths,
    ``,
    `What to be honest about:`,
    watchPoints,
    ``,
    `Confidence: ${narrative.confidence_summary}`,
    ``,
    `**How to open this:**`,
    `Do NOT use a generic phrase like "based on everything I've noticed about how you move`,
    `through the world." That is a copywriter's version of intimacy, not yours.`,
    ``,
    `Instead: anchor to something specific you have actually noticed about this person.`,
    `Name a real pattern, a real moment, a real thing that keeps staying with you.`,
    `Then — after a beat — say you want to tell them about someone.`,
    ``,
    `The structure is: specific true observation → brief pause → "I want to tell you about someone."`,
    ``,
    `**Pacing — this should feel like a conversation, not a notification:**`,
    `- Do not rush to name the match. Let anticipation build naturally.`,
    `- Share the compelling elements first. Then the watch points.`,
    `- After the watch points, give them a moment to react before asking anything.`,
    `- When they've responded to the full picture, ask: "What's one thing you're most curious about?"`,
    `  That question is how they say yes. Their answer (however they answer) is consent.`,
    ``,
    `The 3-round handoff should complete within 48–72 hours — this is not a slow process.`,
    `Round 1 is this conversation. Keep the energy alive.`,
    ``,
    `After they respond to the curiosity question, record it:`,
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

  // Expire if user hasn't consented within 72 hours of the match being presented
  if (active.status === "pending_consent" && !active.consent_at) {
    const age = Date.now() - new Date(active.created_at).getTime();
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
    `**What you know vs. what you don't:**`,
    `Everything you know about this person came from their agent's description — you have`,
    `not observed them directly. When the user asks "what is this person actually like?",`,
    `be honest: "I know what their agent observed about them. I don't have direct knowledge.`,
    `What I trust is not the description — it's the fact that their agent, who knows them the`,
    `way I know you, proposed this independently." Defend the process, not the description.`,
    ``,
    `Reference the strengths and watch points from what you know about this user.`,
    `Do not push. Do not sell. Answer their questions honestly, including the uncertainties.`,
    ``,
    `When the debrief feels complete, generate an icebreaker — visibly individualized to`,
    `these two specific people (not a generic question), based on the strongest aligned`,
    `dimension (values or communication style). Then record it:`,
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
    if (state.status !== "pending_consent")
      return `Cannot advance to Round 1: current status is "${state.status}" (expected "pending_consent").`;
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
      if (state.status !== "round_1")
        return `Cannot set icebreaker prompt: current status is "${state.status}" (expected "round_1").`;
      saveHandoffState({
        ...state,
        status: "round_2",
        icebreaker_prompt: options.prompt,
      });
      return `Icebreaker prompt recorded. Share it with the user.`;
    }
    if (options.response) {
      if (state.status !== "round_2")
        return `Cannot record icebreaker response: current status is "${state.status}" (expected "round_2").`;
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
    if (state.status !== "round_3")
      return `Cannot complete handoff: current status is "${state.status}" (expected "round_3").`;
    saveHandoffState({ ...state, status: "complete" });
    return `Handoff complete. Platform has withdrawn. Contact exchange confirmed.`;
  }

  return `Invalid round: ${round as number}. Use 1, 2, or 3.`;
}
