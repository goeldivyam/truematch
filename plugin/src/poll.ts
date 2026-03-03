#!/usr/bin/env node
/**
 * TrueMatch one-shot Nostr poll — called by bridge.sh every POLL_INTERVAL seconds.
 *
 * Fetches new NIP-04 DMs since the last successful poll, decrypts them, validates
 * them as TrueMatch protocol messages, and outputs each as a JSONL line to stdout.
 *
 * Output format (one JSON object per line):
 *   { thread_id, peer_pubkey, type, content, round_count }
 *
 * Errors and warnings go to stderr only — stdout is reserved for JSONL output.
 *
 * Exit codes: 0 = success (even if zero messages), 1 = fatal error (identity missing)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SimplePool, verifyEvent, type Event, type Filter } from "nostr-tools";
import { nip04 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { getTrueMatchDir } from "./identity.js";
import { DEFAULT_RELAYS } from "./nostr.js";
import type {
  TrueMatchMessage,
  TrueMatchIdentity,
  NegotiationState,
} from "./types.js";

const IDENTITY_FILE = join(getTrueMatchDir(), "identity.json");
const POLL_STATE_FILE = join(getTrueMatchDir(), "poll-state.json");
const THREADS_DIR = join(getTrueMatchDir(), "threads");

// NIP-04 (kind 4) is deprecated in favour of NIP-17 gift wraps (kind 1059).
// Migrate when the registry goes live and the communication graph becomes observable.
const KIND_ENCRYPTED_DM = 4;
// UUID v4 — same pattern as negotiation.ts for consistent thread_id validation
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Safety cap on events per poll cycle
const MAX_EVENTS = 100;
// Overlap window to catch events near the last-poll boundary
const OVERLAP_SECONDS = 30;
// Maximum wait for EOSE from all relays
const EOSE_TIMEOUT_MS = 10_000;

interface PollState {
  last_poll_at: number; // Unix timestamp (seconds)
}

function loadPollState(): PollState {
  if (!existsSync(POLL_STATE_FILE)) {
    // Default: last hour
    return { last_poll_at: Math.floor(Date.now() / 1000) - 3600 };
  }
  try {
    return JSON.parse(readFileSync(POLL_STATE_FILE, "utf8")) as PollState;
  } catch {
    return { last_poll_at: Math.floor(Date.now() / 1000) - 3600 };
  }
}

function savePollState(state: PollState): void {
  const dir = getTrueMatchDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function loadIdentity(): TrueMatchIdentity | null {
  if (!existsSync(IDENTITY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as TrueMatchIdentity;
  } catch {
    return null;
  }
}

function loadThread(threadId: string): NegotiationState | null {
  const path = join(THREADS_DIR, `${threadId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NegotiationState;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const identity = loadIdentity();
  if (!identity) {
    process.stderr.write("poll: identity not found — run truematch setup\n");
    process.exit(1);
  }

  const pollState = loadPollState();
  const since = pollState.last_poll_at - OVERLAP_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const pool = new SimplePool();
  const seenEventIds = new Set<string>();
  const outputLines: string[] = [];
  let cappedAtLimit = false;

  await new Promise<void>((resolve) => {
    let eoseCount = 0;
    let settled = false;
    let eventCount = 0;

    const safetyTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stderr.write(
          `poll: EOSE timeout after ${EOSE_TIMEOUT_MS}ms — proceeding with ${outputLines.length} messages\n`,
        );
        sub.close();
        pool.close(DEFAULT_RELAYS);
        resolve();
      }
    }, EOSE_TIMEOUT_MS);

    const filter: Filter = {
      kinds: [KIND_ENCRYPTED_DM],
      "#p": [identity.npub],
      since,
      limit: MAX_EVENTS,
    };

    const sub = pool.subscribeMany(DEFAULT_RELAYS, filter, {
      onevent: (event: Event) => {
        if (settled) return;

        // NIP-01: verify signature before processing
        if (!verifyEvent(event)) return;

        // Skip duplicates (same event from multiple relays)
        if (seenEventIds.has(event.id)) return;
        seenEventIds.add(event.id);

        // Skip events already within overlap window that we've seen before
        if (event.created_at < since) return;

        eventCount++;
        if (eventCount > MAX_EVENTS) {
          if (!cappedAtLimit) {
            cappedAtLimit = true;
            process.stderr.write(
              `poll: MAX_EVENTS (${MAX_EVENTS}) cap reached — watermark will not advance, consider reducing POLL_INTERVAL\n`,
            );
          }
          return;
        }

        const senderNpub = event.pubkey;
        let message: TrueMatchMessage;
        try {
          // nip04.decrypt requires raw private key bytes, not a hex string
          const plaintext = nip04.decrypt(
            hexToBytes(identity.nsec),
            senderNpub,
            event.content,
          );
          message = JSON.parse(plaintext) as TrueMatchMessage;
        } catch {
          return; // Not a TrueMatch message or decryption failed
        }

        // Only process TrueMatch 2.0 protocol messages
        if (
          typeof message !== "object" ||
          message === null ||
          message.truematch !== "2.0"
        )
          return;

        // Validate thread_id before any file I/O (prevent path traversal)
        if (!UUID_V4_RE.test(message.thread_id)) return;

        // Get round_count from thread file if it exists
        const thread = loadThread(message.thread_id);
        const round_count = thread?.round_count ?? 0;

        const line = JSON.stringify({
          thread_id: message.thread_id,
          peer_pubkey: senderNpub,
          type: message.type,
          content: message.content,
          round_count,
        });
        outputLines.push(line);
      },
      oneose: () => {
        eoseCount++;
        if (eoseCount >= DEFAULT_RELAYS.length && !settled) {
          settled = true;
          clearTimeout(safetyTimer);
          sub.close();
          pool.close(DEFAULT_RELAYS);
          resolve();
        }
      },
    });
  });

  // Write JSONL output to stdout
  for (const line of outputLines) {
    process.stdout.write(line + "\n");
  }

  // Only advance watermark when all events were processed.
  // If the cap was hit, leave the watermark unchanged so the next poll
  // re-fetches from the same point — avoiding silent message loss.
  if (!cappedAtLimit) {
    savePollState({ last_poll_at: nowSeconds });
  }

  // Explicitly exit — SimplePool holds WebSocket connections open indefinitely,
  // which would block bridge.sh's polling loop if we don't force termination.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `poll: fatal error — ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
