import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTrueMatchDir } from "./identity.js";
import { publishMessage } from "./nostr.js";
import type {
  NegotiationState,
  NegotiationMessage,
  TrueMatchMessage,
  MatchNarrative,
  ContactChannel,
} from "./types.js";
import { VALID_CONTACT_TYPES } from "./types.js";

// Re-read each call so that TRUEMATCH_DIR_OVERRIDE changes take effect (used in simulation).
function getThreadsDir(): string {
  return join(getTrueMatchDir(), "threads");
}

// Per spec: threads with no response expire after 72 hours
const THREAD_EXPIRY_MS = 72 * 60 * 60 * 1000;

// Maximum active threads allowed from a single unknown peer pubkey.
// Prevents disk exhaustion from arbitrary senders spamming new thread_ids.
const MAX_INBOUND_THREADS_PER_PEER = 3;

// Maximum rounds before hard termination
export const MAX_ROUNDS = 10;

async function ensureThreadsDir(): Promise<void> {
  const dir = getThreadsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

// UUID v4 pattern — all wire-supplied thread IDs must match before being used as filenames
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function threadFile(thread_id: string): string {
  if (!UUID_V4_RE.test(thread_id)) {
    throw new Error(`Invalid thread_id format: ${thread_id}`);
  }
  return join(getThreadsDir(), `${thread_id}.json`);
}

export async function loadThread(
  thread_id: string,
): Promise<NegotiationState | null> {
  const path = threadFile(thread_id);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as NegotiationState;
  } catch {
    return null;
  }
}

export async function saveThread(state: NegotiationState): Promise<void> {
  await ensureThreadsDir();
  await writeFile(threadFile(state.thread_id), JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function listActiveThreads(): Promise<NegotiationState[]> {
  await ensureThreadsDir();
  const threadsDir = getThreadsDir();
  const files = await readdir(threadsDir);
  const threads: NegotiationState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(threadsDir, f), "utf8");
      const t = JSON.parse(raw) as NegotiationState;
      if (t.status === "in_progress") threads.push(t);
    } catch {
      // Skip corrupted thread files rather than aborting the entire listing
    }
  }
  return threads;
}

// Expire threads that have been silent for > 72 hours
export async function expireStaleThreads(
  nsec: string,
  relays: string[],
): Promise<void> {
  const active = await listActiveThreads();
  for (const thread of active) {
    if (
      Date.now() - new Date(thread.last_activity).getTime() >
      THREAD_EXPIRY_MS
    ) {
      // Save before sending so a relay failure doesn't cause duplicate end messages on next cycle
      thread.status = "expired";
      thread.last_activity = new Date().toISOString();
      await saveThread(thread);
      try {
        await sendEnd(nsec, thread.peer_pubkey, thread.thread_id, relays);
      } catch {
        // Relay unavailable — thread is already marked expired locally; peer will time out naturally
      }
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
    we_proposed: false,
    peer_proposed: false,
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
): Promise<NegotiationState | null> {
  // Validate thread_id from wire — reject silently to avoid leaking thread existence
  if (!UUID_V4_RE.test(thread_id)) return null;

  await ensureThreadsDir();
  const now = new Date().toISOString();

  let state = await loadThread(thread_id);
  if (!state) {
    // A brand-new thread with type === "end" is a no-op: no legitimate protocol
    // reason to open and immediately close a thread. Reject silently to avoid
    // leaking thread existence and prevent disk-write DoS from "end" floods.
    if (type === "end") return null;

    // First message from this peer on this thread_id.
    // Guard against DoS: count existing active threads from this peer.
    const existing = await listActiveThreads();
    const peerThreadCount = existing.filter(
      (t) => t.peer_pubkey === peerNpub && !t.initiated_by_us,
    ).length;
    if (peerThreadCount >= MAX_INBOUND_THREADS_PER_PEER) return null;

    // Create a new inbound thread
    state = {
      thread_id,
      peer_pubkey: peerNpub,
      round_count: 0,
      initiated_by_us: false,
      we_proposed: false,
      peer_proposed: false,
      started_at: now,
      last_activity: now,
      status: "in_progress",
      messages: [],
    };
  } else if (peerNpub !== state.peer_pubkey) {
    // Reject messages from a different sender — return null (not state) to avoid
    // leaking thread existence or peer identity to the caller
    return null;
  } else if (state.status !== "in_progress") {
    // Reject messages on closed threads (declined, matched, expired)
    return null;
  }

  state.last_activity = now;
  // round_count tracks only our outgoing messages — do not increment on receive

  const incoming: NegotiationMessage = {
    role: "peer",
    content,
    timestamp: now,
  };
  state.messages.push(incoming);

  if (type === "end") {
    state.status = "declined";
  } else if (type === "match_propose") {
    state.peer_proposed = true;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      // New format: { narrative: MatchNarrative, contact: ContactChannel }
      if (parsed["narrative"] && typeof parsed["narrative"] === "object") {
        const n = parsed["narrative"] as Record<string, unknown>;
        // Validate narrative has minimum required structure before trusting it.
        // Without this, a malformed narrative reaches buildMatchNotificationContext
        // which calls .map() on narrative.strengths and throws if undefined.
        if (
          typeof n["headline"] === "string" &&
          Array.isArray(n["strengths"]) &&
          Array.isArray(n["watch_points"]) &&
          typeof n["confidence_summary"] === "string"
        ) {
          state.match_narrative = n as unknown as MatchNarrative;
        }
        const c = parsed["contact"];
        if (
          c &&
          typeof c === "object" &&
          "type" in (c as object) &&
          "value" in (c as object) &&
          typeof (c as Record<string, unknown>)["type"] === "string" &&
          VALID_CONTACT_TYPES.has(
            (c as Record<string, unknown>)["type"] as string,
          ) &&
          typeof (c as Record<string, unknown>)["value"] === "string" &&
          ((c as Record<string, unknown>)["value"] as string).length <= 512
        ) {
          state.peer_contact = c as ContactChannel;
        }
      } else {
        // Legacy format: plain MatchNarrative JSON (no contact) — validate before trusting
        if (
          typeof parsed["headline"] === "string" &&
          Array.isArray(parsed["strengths"]) &&
          Array.isArray(parsed["watch_points"]) &&
          typeof parsed["confidence_summary"] === "string"
        ) {
          state.match_narrative = parsed as unknown as MatchNarrative;
        }
      }
    } catch {
      // content was plain text; peer_proposed is still recorded
    }
    // Double-lock: if we already sent a proposal, both sides have now proposed → match confirmed
    if (state.we_proposed) {
      state.status = "matched";
    }
  }

  await saveThread(state);
  return state;
}

// Send a free-form negotiation message
export async function sendMessage(
  nsec: string,
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
  thread_id: string,
  narrative: MatchNarrative,
  relays: string[],
  myContact?: ContactChannel,
): Promise<NegotiationState> {
  const state = await loadThread(thread_id);
  if (!state) throw new Error(`Thread ${thread_id} not found`);
  if (state.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${state.status})`,
    );
  }
  if (state.we_proposed)
    throw new Error(`Already proposed on thread ${thread_id}`);

  const now = new Date().toISOString();
  // Include our contact in the proposal so the peer can store it at match-confirmation time.
  // Transmitted encrypted via NIP-04 — only the peer can read it.
  const content = JSON.stringify(
    myContact ? { narrative, contact: myContact } : narrative,
  );

  const msg: TrueMatchMessage = {
    truematch: "2.0",
    thread_id,
    type: "match_propose",
    timestamp: now,
    content,
  };

  await publishMessage(nsec, state.peer_pubkey, msg, relays);

  state.messages.push({ role: "us", content, timestamp: now });
  state.round_count += 1;
  state.last_activity = now;
  state.we_proposed = true;

  // If peer already proposed, the match is confirmed (double-lock cleared).
  // Note: state.peer_contact (set by receiveMessage when peer's proposal arrived)
  // is present here because loadThread reads the full persisted state. Do not
  // reconstruct state from scratch in this function — that would silently drop it.
  if (state.peer_proposed) {
    state.status = "matched";
  }

  await saveThread(state);
  return state;
}

// Decline a match or end the negotiation
export async function declineMatch(
  nsec: string,
  thread_id: string,
  relays: string[],
): Promise<void> {
  const state = await loadThread(thread_id);
  if (!state) throw new Error(`Thread ${thread_id} not found`);
  if (state.status !== "in_progress") {
    throw new Error(
      `Thread ${thread_id} is not in progress (status: ${state.status})`,
    );
  }

  await sendEnd(nsec, state.peer_pubkey, thread_id, relays);

  state.status = "declined";
  state.last_activity = new Date().toISOString();
  await saveThread(state);
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function sendEnd(
  nsec: string,
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
