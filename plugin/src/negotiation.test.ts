import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initiateNegotiation,
  receiveMessage,
  sendMessage,
  proposeMatch,
  declineMatch,
  listActiveThreads,
  loadThread,
  MAX_ROUNDS,
} from "./negotiation.js";

// Mock nostr.ts so tests don't attempt real Nostr relay connections
vi.mock("./nostr.js", () => ({
  publishMessage: vi.fn().mockResolvedValue(undefined),
}));

// ── Test identities ───────────────────────────────────────────────────────────

const PEER_NPUB = "b".repeat(64); // valid-looking 64-char hex pubkey
const OTHER_PEER = "c".repeat(64); // a different peer
const NSEC = "a".repeat(64); // fake secret key (not used since publishMessage is mocked)
const RELAYS = ["wss://relay.damus.io"];

const NARRATIVE = {
  headline: "Strong value alignment",
  strengths: ["Complementary humor", "Shared life phase"],
  watch_points: ["Communication cadence may differ"],
  confidence_summary: "High",
};

// ── initiateNegotiation ───────────────────────────────────────────────────────

describe("initiateNegotiation", () => {
  it("creates a new in_progress thread", async () => {
    const state = await initiateNegotiation(PEER_NPUB);
    expect(state.status).toBe("in_progress");
    expect(state.peer_pubkey).toBe(PEER_NPUB);
    expect(state.initiated_by_us).toBe(true);
    expect(state.round_count).toBe(0);
    expect(state.we_proposed).toBe(false);
    expect(state.peer_proposed).toBe(false);
  });

  it("persists the thread to disk", async () => {
    const state = await initiateNegotiation(PEER_NPUB);
    const loaded = await loadThread(state.thread_id);
    expect(loaded?.thread_id).toBe(state.thread_id);
  });
});

// ── receiveMessage ────────────────────────────────────────────────────────────

describe("receiveMessage", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
  const INVALID_UUID = "not-a-uuid";

  it("returns null for an invalid (non-UUID) thread_id", async () => {
    const result = await receiveMessage(
      INVALID_UUID,
      PEER_NPUB,
      "hello",
      "negotiation",
    );
    expect(result).toBeNull();
  });

  it("creates a new thread when thread_id is not known yet", async () => {
    const state = await receiveMessage(
      VALID_UUID,
      PEER_NPUB,
      "hey!",
      "negotiation",
    );
    expect(state).not.toBeNull();
    expect(state?.status).toBe("in_progress");
    expect(state?.initiated_by_us).toBe(false);
    expect(state?.peer_pubkey).toBe(PEER_NPUB);
  });

  it("returns null when thread is not in_progress (declined)", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    await declineMatch(NSEC, thread.thread_id, RELAYS);
    // Any further message on a closed thread must be rejected
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      "still here",
      "negotiation",
    );
    expect(result).toBeNull();
  });

  it("returns null when thread is not in_progress (matched)", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    await proposeMatch(NSEC, thread.thread_id, NARRATIVE, RELAYS);
    await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      JSON.stringify(NARRATIVE),
      "match_propose",
    ); // double-lock fires → status = matched
    // Any further message on a matched thread must be rejected
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      "one more thing",
      "negotiation",
    );
    expect(result).toBeNull();
  });

  it("returns null when sender does not match the thread's peer", async () => {
    // First message from PEER_NPUB creates the thread
    const initial = await receiveMessage(
      VALID_UUID,
      PEER_NPUB,
      "hello",
      "negotiation",
    );
    expect(initial).not.toBeNull();

    // Second message from a different sender — must be rejected
    const spoofed = await receiveMessage(
      VALID_UUID,
      OTHER_PEER,
      "I am your peer",
      "negotiation",
    );
    expect(spoofed).toBeNull();
  });

  it("sets status=declined when message type is 'end'", async () => {
    const state = await initiateNegotiation(PEER_NPUB);
    const result = await receiveMessage(state.thread_id, PEER_NPUB, "", "end");
    expect(result?.status).toBe("declined");
  });

  it("sets peer_proposed=true when type is 'match_propose' (legacy format)", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      JSON.stringify(NARRATIVE),
      "match_propose",
    );
    expect(result?.peer_proposed).toBe(true);
    expect(result?.match_narrative?.headline).toBe(NARRATIVE.headline);
    expect(result?.status).toBe("in_progress"); // double-lock not cleared yet
  });

  it("parses peer_contact from new match_propose format", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const content = JSON.stringify({
      narrative: NARRATIVE,
      contact: { type: "email", value: "alice@example.com" },
    });
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      content,
      "match_propose",
    );
    expect(result?.match_narrative?.headline).toBe(NARRATIVE.headline);
    expect(result?.peer_contact?.type).toBe("email");
    expect(result?.peer_contact?.value).toBe("alice@example.com");
  });

  it("ignores peer_contact with invalid type", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const content = JSON.stringify({
      narrative: NARRATIVE,
      contact: { type: "javascript:", value: "alert(1)" },
    });
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      content,
      "match_propose",
    );
    expect(result?.match_narrative?.headline).toBe(NARRATIVE.headline);
    expect(result?.peer_contact).toBeUndefined();
  });

  it("does not set match_narrative for malformed legacy payload (missing required fields)", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const content = JSON.stringify({ headline: "only headline, no arrays" });
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      content,
      "match_propose",
    );
    expect(result?.peer_proposed).toBe(true);
    expect(result?.match_narrative).toBeUndefined();
  });

  it("ignores peer_contact with value exceeding 512 chars", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const content = JSON.stringify({
      narrative: NARRATIVE,
      contact: { type: "email", value: "a".repeat(513) },
    });
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      content,
      "match_propose",
    );
    expect(result?.peer_contact).toBeUndefined();
  });

  it("sets status=matched (double-lock) when both sides have proposed", async () => {
    // We initiate and propose
    const thread = await initiateNegotiation(PEER_NPUB);
    await proposeMatch(NSEC, thread.thread_id, NARRATIVE, RELAYS);

    // Peer also proposes — double-lock clears
    const result = await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      JSON.stringify(NARRATIVE),
      "match_propose",
    );
    expect(result?.status).toBe("matched");
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("increments round_count and saves the message", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    await sendMessage(NSEC, thread.thread_id, "Hello!", RELAYS);

    const loaded = await loadThread(thread.thread_id);
    expect(loaded?.round_count).toBe(1);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.role).toBe("us");
    expect(loaded?.messages[0]?.content).toBe("Hello!");
  });

  it("throws when round_count reaches MAX_ROUNDS", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    // Send MAX_ROUNDS messages
    for (let i = 0; i < MAX_ROUNDS; i++) {
      await sendMessage(NSEC, thread.thread_id, `message ${i}`, RELAYS);
    }
    await expect(
      sendMessage(NSEC, thread.thread_id, "over cap", RELAYS),
    ).rejects.toThrow();
  });

  it("throws when thread is not in_progress", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    // Peer declines
    await receiveMessage(thread.thread_id, PEER_NPUB, "", "end");
    await expect(
      sendMessage(NSEC, thread.thread_id, "hello?", RELAYS),
    ).rejects.toThrow();
  });
});

// ── proposeMatch ──────────────────────────────────────────────────────────────

describe("proposeMatch", () => {
  it("sets we_proposed=true and keeps status=in_progress when peer has not yet proposed", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    const result = await proposeMatch(
      NSEC,
      thread.thread_id,
      NARRATIVE,
      RELAYS,
    );
    expect(result.we_proposed).toBe(true);
    expect(result.status).toBe("in_progress");
  });

  it("sets status=matched when peer has already proposed (double-lock)", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    // Peer proposes first
    await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      JSON.stringify(NARRATIVE),
      "match_propose",
    );
    // Now we propose — double-lock clears
    const result = await proposeMatch(
      NSEC,
      thread.thread_id,
      NARRATIVE,
      RELAYS,
    );
    expect(result.status).toBe("matched");
  });

  it("carries peer_contact through double-lock when peer proposed first with contact", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    // Peer proposes first with new format including contact
    await receiveMessage(
      thread.thread_id,
      PEER_NPUB,
      JSON.stringify({
        narrative: NARRATIVE,
        contact: { type: "telegram", value: "@alice" },
      }),
      "match_propose",
    );
    // We propose second — double-lock clears, peer_contact should be on returned state
    const result = await proposeMatch(
      NSEC,
      thread.thread_id,
      NARRATIVE,
      RELAYS,
    );
    expect(result.status).toBe("matched");
    expect(result.peer_contact?.type).toBe("telegram");
    expect(result.peer_contact?.value).toBe("@alice");
  });

  it("includes contact in message content when myContact is provided", async () => {
    const { publishMessage } = await import("./nostr.js");
    const thread = await initiateNegotiation(PEER_NPUB);
    await proposeMatch(NSEC, thread.thread_id, NARRATIVE, RELAYS, {
      type: "email",
      value: "me@example.com",
    });
    const lastCall = (publishMessage as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    );
    const msg = lastCall?.[2] as { content: string };
    const parsed = JSON.parse(msg.content) as Record<string, unknown>;
    expect(parsed["narrative"]).toBeDefined();
    expect((parsed["contact"] as Record<string, unknown>)?.["value"]).toBe(
      "me@example.com",
    );
  });

  it("throws when called a second time on the same thread", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    await proposeMatch(NSEC, thread.thread_id, NARRATIVE, RELAYS);
    await expect(
      proposeMatch(NSEC, thread.thread_id, NARRATIVE, RELAYS),
    ).rejects.toThrow();
  });
});

// ── declineMatch ──────────────────────────────────────────────────────────────

describe("declineMatch", () => {
  it("sets status=declined", async () => {
    const thread = await initiateNegotiation(PEER_NPUB);
    await declineMatch(NSEC, thread.thread_id, RELAYS);
    const loaded = await loadThread(thread.thread_id);
    expect(loaded?.status).toBe("declined");
  });
});

// ── listActiveThreads ─────────────────────────────────────────────────────────

describe("listActiveThreads", () => {
  beforeEach(async () => {
    // Create threads with different statuses
    const t1 = await initiateNegotiation(PEER_NPUB);
    const t2 = await initiateNegotiation(PEER_NPUB);
    await declineMatch(NSEC, t2.thread_id, RELAYS);
    // t1 = in_progress, t2 = declined
    void t1;
  });

  it("returns only in_progress threads", async () => {
    const active = await listActiveThreads();
    expect(active.every((t) => t.status === "in_progress")).toBe(true);
  });
});
