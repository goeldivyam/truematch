import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TRUEMATCH_DIR } from "./identity.js";
import { publishMessage } from "./nostr.js";
import { DIMENSION_FLOORS } from "./observation.js";
import type {
  NegotiationState,
  NegotiationMessage,
  TrueMatchMessage,
  ObservationSummary,
  MatchNarrative,
} from "./types.js";

const THREADS_DIR = join(TRUEMATCH_DIR, "threads");

// Per spec: threads with no response expire after 72 hours
const THREAD_EXPIRY_MS = 72 * 60 * 60 * 1000;

// Double-lock: both agents must independently clear this threshold
// Composite threshold used by the skeptical-advocate persona when deciding
// whether to propose. Enforced by Claude's judgment, not programmatically.
const COMPOSITE_THRESHOLD = 0.74;

// Confidence cap for dimensions observed in only one behavioral context
const LOW_DIVERSITY_CAP = 0.65;

// Maximum rounds before hard termination
export const MAX_ROUNDS = 10;

async function ensureThreadsDir(): Promise<void> {
  if (!existsSync(THREADS_DIR)) {
    await mkdir(THREADS_DIR, { recursive: true });
  }
}

function threadFile(thread_id: string): string {
  return join(THREADS_DIR, `${thread_id}.json`);
}

export async function loadThread(
  thread_id: string,
): Promise<NegotiationState | null> {
  const path = threadFile(thread_id);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as NegotiationState;
}

export async function saveThread(state: NegotiationState): Promise<void> {
  await ensureThreadsDir();
  await writeFile(
    threadFile(state.thread_id),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export async function listActiveThreads(): Promise<NegotiationState[]> {
  await ensureThreadsDir();
  const files = await readdir(THREADS_DIR);
  const threads: NegotiationState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await readFile(join(THREADS_DIR, f), "utf8");
    const t = JSON.parse(raw) as NegotiationState;
    if (t.status === "in_progress") threads.push(t);
  }
  return threads;
}

// Expire threads that have been silent for > 72 hours
export async function expireStaleThreads(
  nsec: string,
  npub: string,
  relays: string[],
): Promise<void> {
  const active = await listActiveThreads();
  for (const thread of active) {
    if (
      Date.now() - new Date(thread.last_activity).getTime() >
      THREAD_EXPIRY_MS
    ) {
      await sendEnd(nsec, npub, thread.peer_pubkey, thread.thread_id, relays);
      thread.status = "expired";
      thread.last_activity = new Date().toISOString(); // prevent duplicate sends on next cycle
      await saveThread(thread);
    }
  }
}

// Create a new negotiation thread. Does NOT send an opening message —
// Claude writes and sends the opening via `truematch match --send`.
export async function initiateNegotiation(
  peerNpub: string,
): Promise<NegotiationState> {
  const thread_id = randomUUID();
  const now = new Date().toISOString();

  const state: NegotiationState = {
    thread_id,
    peer_pubkey: peerNpub,
    round_count: 0,
    initiated_by_us: true,
    started_at: now,
    last_activity: now,
    status: "in_progress",
    messages: [],
  };

  await saveThread(state);
  return state;
}

// Save an incoming peer message to the thread
export async function receiveMessage(
  thread_id: string,
  peerNpub: string,
  content: string,
  type: string,
): Promise<NegotiationState> {
  await ensureThreadsDir();
  const now = new Date().toISOString();

  let state = await loadThread(thread_id);
  if (!state) {
    // First message from peer — create a new thread
    state = {
      thread_id,
      peer_pubkey: peerNpub,
      round_count: 0,
      initiated_by_us: false,
      started_at: now,
      last_activity: now,
      status: "in_progress",
      messages: [],
    };
  }

  state.last_activity = now;
  state.round_count += 1;

  const incoming: NegotiationMessage = {
    role: "peer",
    content,
    timestamp: now,
  };
  state.messages.push(incoming);

  if (type === "end" || type === "match_decline") {
    state.status = "declined";
  } else if (type === "match_propose") {
    try {
      const narrative = JSON.parse(content) as MatchNarrative;
      state.match_narrative = narrative;
    } catch {
      // content was plain text
    }
    // Double-lock: if we already sent a proposal, both sides have now proposed → match confirmed
    const weAlreadyProposed = state.messages.some(
      (m) => m.role === "us" && m.content.startsWith("[match_propose]"),
    );
    if (weAlreadyProposed) {
      state.status = "matched";
    }
  }

  await saveThread(state);
  return state;
}

// Send a free-form negotiation message
export async function sendMessage(
  nsec: string,
  npub: string,
  thread_id: string,
  content: string,
  relays: string[],
): Promise<void> {
  const state = await loadThread(thread_id);
  if (!state) throw new Error(`Thread ${thread_id} not found`);
  if (state.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${state.status})`,
    );
  }
  if (state.round_count >= MAX_ROUNDS) {
    throw new Error(
      `Thread ${thread_id} has reached the ${MAX_ROUNDS}-round cap`,
    );
  }

  const now = new Date().toISOString();

  const msg: TrueMatchMessage = {
    truematch: "2.0",
    thread_id,
    type: "negotiation",
    timestamp: now,
    content,
  };

  await publishMessage(nsec, state.peer_pubkey, msg, relays);

  state.messages.push({ role: "us", content, timestamp: now });
  state.round_count += 1;
  state.last_activity = now;
  await saveThread(state);
}

// Propose a match (double-lock: peer must also propose for match to confirm)
export async function proposeMatch(
  nsec: string,
  npub: string,
  thread_id: string,
  narrative: MatchNarrative,
  relays: string[],
): Promise<NegotiationState> {
  const state = await loadThread(thread_id);
  if (!state) throw new Error(`Thread ${thread_id} not found`);

  const now = new Date().toISOString();
  const content = JSON.stringify(narrative);

  const msg: TrueMatchMessage = {
    truematch: "2.0",
    thread_id,
    type: "match_propose",
    timestamp: now,
    content,
  };

  await publishMessage(nsec, state.peer_pubkey, msg, relays);

  state.messages.push({
    role: "us",
    content: `[match_propose] ${content}`,
    timestamp: now,
  });
  state.round_count += 1;
  state.last_activity = now;

  // If peer already proposed, the match is confirmed (double-lock cleared)
  if (state.match_narrative !== undefined) {
    state.status = "matched";
  }

  await saveThread(state);
  return state;
}

// Decline a match or end the negotiation
export async function declineMatch(
  nsec: string,
  npub: string,
  thread_id: string,
  relays: string[],
): Promise<void> {
  const state = await loadThread(thread_id);
  if (!state) throw new Error(`Thread ${thread_id} not found`);

  await sendEnd(nsec, npub, state.peer_pubkey, thread_id, relays);

  state.status = "declined";
  state.last_activity = new Date().toISOString();
  await saveThread(state);
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

// Cap confidence for dimensions observed in only one behavioral context
function effectiveConfidence(d: {
  confidence: number;
  behavioral_context_diversity: "low" | "medium" | "high";
}): number {
  return d.behavioral_context_diversity === "low"
    ? Math.min(d.confidence, LOW_DIVERSITY_CAP)
    : d.confidence;
}

// Confidence-weighted composite: high-confidence dimensions receive proportionally
// more weight (weight = effective_confidence). Used for internal sanity checks.
function computeCompositeScore(obs: ObservationSummary): number {
  const dims = [
    obs.attachment,
    obs.core_values,
    obs.communication,
    obs.emotional_regulation,
    obs.humor,
    obs.life_velocity,
    obs.dealbreakers,
  ];
  const effs = dims.map(effectiveConfidence);
  const weightedSum = effs.reduce((sum, e) => sum + e * e, 0);
  const totalWeight = effs.reduce((sum, e) => sum + e, 0);
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function checkDimensionFloors(obs: ObservationSummary): boolean {
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

// ── Private helpers ───────────────────────────────────────────────────────────

async function sendEnd(
  nsec: string,
  npub: string,
  peerNpub: string,
  thread_id: string,
  relays: string[],
): Promise<void> {
  await publishMessage(
    nsec,
    peerNpub,
    {
      truematch: "2.0",
      thread_id,
      type: "end",
      timestamp: new Date().toISOString(),
      content: "",
    },
    relays,
  );
}
