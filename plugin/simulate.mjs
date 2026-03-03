/* global process, console, setTimeout, URL */
/**
 * TrueMatch end-to-end simulation
 *
 * Simulates agents going through the full matching flow:
 *   Scenario 1  — Successful double-lock match
 *   Scenario 2  — Bob declines (sends "end")
 *   Scenario 3  — Pending notification written on match
 *   Scenario 4  — Per-peer inbound thread DoS cap
 *   Scenario 5  — Thread expiry (72h stale timeout)
 *   Scenario 6  — Round cap (10-round hard limit)
 *   Scenario 7  — Handoff rounds 1 → 2 → 3 → complete + opt-out path
 *   Scenario 8  — NIP-04 encrypt/decrypt round-trip + wrong-key rejection
 *   Scenario 9  — Live Nostr round-trip (opt-in: --live-nostr)
 *   Scenario 10 — Multi-party offline: 6 agents, 3 pairs (match/decline/match)
 *   Scenario 11 — Multi-party live Nostr: 6 agents, 3 pairs (opt-in: --live-nostr)
 *   Scenario 12 — poll.ts JSONL output via child process (opt-in: --live-nostr)
 *   Scenario 13 — match --start with mock registry: register/list/deregister + candidate selection
 *   Scenario 14 — Full end-to-end: mock registry discovery → live Nostr negotiation → match (opt-in: --live-nostr)
 *
 * Scenarios 1-8, 10, 13 bypass live Nostr relays and test the state machine directly.
 * Scenarios 9, 11, 12, 14 publish real NIP-04 DMs to public relays (--live-nostr flag).
 * Uses TRUEMATCH_DIR_OVERRIDE + TRUEMATCH_REGISTRY_URL_OVERRIDE for full isolation.
 *
 * What is NOT covered by simulation:
 *   - bridge.sh daemon loop: shell process management / Claude pipe integration.
 *     poll.ts itself is tested in Scenario 12; the loop is not.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import {
  publishMessage,
  subscribeToMessages,
  DEFAULT_RELAYS,
} from "./dist/nostr.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTestDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `tm-sim-${label}-`));
  mkdirSync(join(dir, "threads"), { recursive: true });
  return dir;
}

function makeIdentity() {
  const sk = generateSecretKey();
  // getPublicKey returns a 64-char hex string (32-byte x-only key) — no bytesToHex wrapping.
  return { nsec: bytesToHex(sk), npub: getPublicKey(sk) };
}

function writeIdentity(tmDir, identity) {
  writeFileSync(
    join(tmDir, "identity.json"),
    JSON.stringify({ ...identity, created_at: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

function setAgent(dir) {
  process.env["TRUEMATCH_DIR_OVERRIDE"] = dir;
}

function pass(label) {
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  console.error(`  ✗ ${label}: ${detail}`);
  process.exitCode = 1;
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

// Import modules once — TRUEMATCH_DIR_OVERRIDE controls which dir they use per call.
const {
  initiateNegotiation,
  receiveMessage,
  proposeMatch,
  sendMessage,
  declineMatch,
  loadThread,
  saveThread,
  expireStaleThreads,
  listActiveThreads,
} = await import("./dist/negotiation.js");
const {
  writePendingNotificationIfMatched,
  loadPendingNotification,
  loadHandoffState,
  advanceHandoff,
} = await import("./dist/handoff.js");
const { register, deregister, listAgents, loadRegistration } =
  await import("./dist/registry.js");

// ── Scenario 1: Successful double-lock match ──────────────────────────────────

async function scenario1() {
  section("Scenario 1: Double-lock match");

  const dirA = makeTestDir("a1");
  const dirB = makeTestDir("b1");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);
  writeIdentity(dirB, bob);

  // Alice initiates
  setAgent(dirA);
  const threadA = await initiateNegotiation(bob.npub);
  pass(`Alice opened thread ${threadA.thread_id.slice(0, 8)}...`);
  if (threadA.initiated_by_us !== true)
    fail("initiated_by_us", threadA.initiated_by_us);
  if (threadA.status !== "in_progress") fail("initial status", threadA.status);

  // Bob receives Alice's opening
  setAgent(dirB);
  const threadBAfterReceive = await receiveMessage(
    threadA.thread_id,
    alice.npub,
    "Hi! I'm curious about your values around creativity.",
    "negotiation",
  );
  if (!threadBAfterReceive) {
    fail("Bob received first message", "got null");
    return;
  }
  pass(`Bob received opening message (thread created, initiated_by_us=false)`);
  if (threadBAfterReceive.initiated_by_us !== false)
    fail(
      "Bob initiated_by_us should be false",
      threadBAfterReceive.initiated_by_us,
    );

  // Alice receives Bob's reply
  setAgent(dirA);
  await receiveMessage(
    threadA.thread_id,
    bob.npub,
    "Hi! Creativity is core for me — I build things constantly.",
    "negotiation",
  );
  pass("Alice received Bob's reply");

  // Bob proposes first
  setAgent(dirB);
  const narrative = {
    headline:
      "Strong shared builder energy with complementary communication styles",
    strengths: ["aligned core values", "compatible humor", "mutual directness"],
    watch_points: ["life velocity pace may differ"],
    confidence_summary:
      "0.81 composite — above threshold across all 9 dimensions",
  };
  const stateAfterBobPropose = await proposeMatch(
    bob.nsec,
    threadA.thread_id,
    narrative,
    [],
  );
  if (stateAfterBobPropose.we_proposed !== true)
    fail("Bob we_proposed", stateAfterBobPropose.we_proposed);
  if (stateAfterBobPropose.status !== "in_progress")
    fail(
      "status after Bob propose (no double-lock yet)",
      stateAfterBobPropose.status,
    );
  pass("Bob proposed match (waiting for Alice)");

  // Alice receives Bob's proposal
  setAgent(dirA);
  const aliceAfterPeerPropose = await receiveMessage(
    threadA.thread_id,
    bob.npub,
    JSON.stringify(narrative),
    "match_propose",
  );
  if (!aliceAfterPeerPropose) {
    fail("Alice received Bob's proposal", "got null");
    return;
  }
  if (aliceAfterPeerPropose.peer_proposed !== true)
    fail("Alice peer_proposed", aliceAfterPeerPropose.peer_proposed);
  pass("Alice received Bob's proposal (peer_proposed=true)");

  // Alice proposes → double-lock clears
  const aliceNarrative = {
    headline:
      "Genuine creative alignment — rare combination of depth and directness",
    strengths: [
      "deep values alignment",
      "compatible conflict style",
      "shared builder mindset",
    ],
    watch_points: ["interdependence model worth exploring in round 2"],
    confidence_summary: "0.83 composite — strong signal across all dimensions",
  };
  const finalState = await proposeMatch(
    alice.nsec,
    threadA.thread_id,
    aliceNarrative,
    [],
  );
  if (finalState.status !== "matched")
    fail("final status should be matched", finalState.status);
  if (!finalState.match_narrative)
    fail("match_narrative should be set", "undefined");
  pass(`MATCH CONFIRMED — status=${finalState.status}`);
  pass(`Headline: "${finalState.match_narrative?.headline}"`);

  // Verify Bob's side also sees matched
  setAgent(dirB);
  const bobFinal = await receiveMessage(
    threadA.thread_id,
    alice.npub,
    JSON.stringify(aliceNarrative),
    "match_propose",
  );
  if (bobFinal?.status !== "matched")
    fail("Bob side should also be matched", bobFinal?.status);
  pass("Bob's side also shows status=matched");

  // Cleanup
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

// ── Scenario 2: Bob declines ──────────────────────────────────────────────────

async function scenario2() {
  section("Scenario 2: Decline (end message)");

  const dirA = makeTestDir("a2");
  const dirB = makeTestDir("b2");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);
  writeIdentity(dirB, bob);

  setAgent(dirA);
  const threadA = await initiateNegotiation(bob.npub);

  setAgent(dirB);
  await receiveMessage(threadA.thread_id, alice.npub, "Hello!", "negotiation");

  // Bob sends "end"
  const declined = await receiveMessage(
    threadA.thread_id,
    alice.npub,
    "",
    "end",
  );
  if (declined?.status !== "declined")
    fail("status after end", declined?.status);
  pass("Thread status=declined after 'end' message");

  // Alice receives the end message
  setAgent(dirA);
  const aliceDeclined = await receiveMessage(
    threadA.thread_id,
    bob.npub,
    "",
    "end",
  );
  if (aliceDeclined?.status !== "declined")
    fail("Alice status after decline", aliceDeclined?.status);
  pass("Alice's thread also shows declined");

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

// ── Scenario 3: Pending notification written on match ────────────────────────

async function scenario3() {
  section("Scenario 3: Pending notification file written on match");

  const dirA = makeTestDir("a3");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);

  setAgent(dirA);
  const thread = await initiateNegotiation(bob.npub);
  const narrative = {
    headline: "Complementary worldviews with strong values overlap",
    strengths: ["humor alignment", "communication style"],
    watch_points: ["life velocity mismatch worth exploring"],
    confidence_summary: "0.79 composite",
  };

  // Simulate peer proposing first
  await receiveMessage(
    thread.thread_id,
    bob.npub,
    JSON.stringify(narrative),
    "match_propose",
  );

  // Alice proposes → matched
  const matched = await proposeMatch(
    alice.nsec,
    thread.thread_id,
    narrative,
    [],
  );
  if (matched.status !== "matched") {
    fail("should be matched", matched.status);
    return;
  }

  // Write notification
  setAgent(dirA);
  writePendingNotificationIfMatched(
    thread.thread_id,
    bob.npub,
    matched.match_narrative,
  );

  // Verify notification file
  const notification = loadPendingNotification();
  if (!notification) {
    fail("pending_notification.json not found", "null");
    return;
  }
  if (!notification.match_id) fail("match_id missing", notification.match_id);
  if (notification.peer_pubkey !== bob.npub)
    fail("peer_pubkey mismatch", notification.peer_pubkey);
  if (!notification.narrative?.headline)
    fail("headline missing", notification.narrative?.headline);
  pass(
    `Notification written — match_id=${notification.match_id.slice(0, 8)}...`,
  );
  pass(`Headline: "${notification.narrative.headline}"`);

  rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario 4: Inbound thread DoS cap ───────────────────────────────────────

async function scenario4() {
  section("Scenario 4: Per-peer inbound thread cap (DoS protection)");

  const dirA = makeTestDir("a4");
  const alice = makeIdentity();
  const attacker = makeIdentity();
  writeIdentity(dirA, alice);

  setAgent(dirA);

  // Attacker opens 3 threads — all should succeed.
  // UUID v4 variant byte must be [89ab]; use 'a' and 'b' variants throughout.
  const uuids = [
    "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  for (const id of uuids) {
    const r = await receiveMessage(id, attacker.npub, "hi", "negotiation");
    if (!r) {
      fail(`Thread ${id.slice(0, 8)} should be accepted`, "null");
      return;
    }
  }
  pass("3 inbound threads from same peer accepted");

  // 4th thread should be rejected
  const fourth = await receiveMessage(
    "dddddddd-dddd-4ddd-9ddd-dddddddddddd",
    attacker.npub,
    "hi",
    "negotiation",
  );
  if (fourth !== null) {
    fail(
      "4th thread should be rejected (DoS cap)",
      `got status=${fourth?.status}`,
    );
  } else {
    pass("4th thread rejected — DoS cap working");
  }

  rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario 5: Thread expiry (72h timeout) ──────────────────────────────────

async function scenario5() {
  section("Scenario 5: Thread expiry (72h stale timeout)");

  const dirA = makeTestDir("a5");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);

  setAgent(dirA);
  const thread = await initiateNegotiation(bob.npub);

  // Backdate last_activity by 73 hours to trigger expiry
  const stale = await loadThread(thread.thread_id);
  stale.last_activity = new Date(
    Date.now() - 73 * 60 * 60 * 1000,
  ).toISOString();
  await saveThread(stale);

  // expireStaleThreads with empty relays (no-op publish)
  await expireStaleThreads(alice.nsec, []);

  const expired = await loadThread(thread.thread_id);
  if (expired?.status !== "expired")
    fail("thread should be expired", expired?.status);
  pass("Stale thread (73h) correctly expired");

  // A fresh thread should NOT be expired
  const fresh = await initiateNegotiation(bob.npub);
  await expireStaleThreads(alice.nsec, []);
  const stillActive = await loadThread(fresh.thread_id);
  if (stillActive?.status !== "in_progress")
    fail("fresh thread should still be in_progress", stillActive?.status);
  pass("Fresh thread not affected by expiry sweep");

  rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario 6: Round cap (10-round hard limit) ───────────────────────────────

async function scenario6() {
  section("Scenario 6: Round cap (10-round hard limit)");

  const dirA = makeTestDir("a6");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);

  setAgent(dirA);
  const thread = await initiateNegotiation(bob.npub);

  // Force round_count to 10 directly
  const state = await loadThread(thread.thread_id);
  state.round_count = 10;
  await saveThread(state);

  // sendMessage should throw — round cap enforced on free-form messages
  let threw = false;
  try {
    await sendMessage(alice.nsec, thread.thread_id, "one more message", []);
  } catch {
    threw = true;
  }
  if (!threw) fail("sendMessage should throw at round cap", "did not throw");
  pass("sendMessage correctly blocked at round_count=10");

  // proposeMatch should still succeed — you can always propose even at cap
  const proposed = await proposeMatch(
    alice.nsec,
    thread.thread_id,
    {
      headline: "test",
      strengths: [],
      watch_points: [],
      confidence_summary: "test",
    },
    [],
  );
  if (!proposed.we_proposed)
    fail("proposeMatch should succeed at round cap", "we_proposed=false");
  pass(
    "proposeMatch still allowed at round_count=10 (cap only blocks free-form messages)",
  );

  rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario 7: Handoff rounds 1 → 2 → 3 → complete + opt-out ────────────────

async function scenario7() {
  section("Scenario 7: Handoff round progression + opt-out");

  const dirA = makeTestDir("a7");
  const alice = makeIdentity();
  const bob = makeIdentity();
  writeIdentity(dirA, alice);

  setAgent(dirA);

  // Set up a matched thread and write the notification/handoff state
  const thread = await initiateNegotiation(bob.npub);
  const narrative = {
    headline: "Deep values alignment",
    strengths: ["humor", "communication"],
    watch_points: ["life velocity"],
    confidence_summary: "0.82 composite",
  };
  await receiveMessage(
    thread.thread_id,
    bob.npub,
    JSON.stringify(narrative),
    "match_propose",
  );
  const matched = await proposeMatch(
    alice.nsec,
    thread.thread_id,
    narrative,
    [],
  );
  if (matched.status !== "matched") {
    fail("precondition: should be matched", matched.status);
    return;
  }

  writePendingNotificationIfMatched(
    thread.thread_id,
    bob.npub,
    matched.match_narrative,
  );

  const matchId = thread.thread_id;

  // Round 1: consent
  const r1 = advanceHandoff(matchId, 1, {
    consent: "I'm curious about this person",
  });
  const s1 = loadHandoffState(matchId);
  if (s1?.status !== "round_1") fail("status after round 1", s1?.status);
  pass(`Round 1 recorded — status=round_1 (${r1.slice(0, 40)}...)`);

  // Round 2: icebreaker prompt
  advanceHandoff(matchId, 2, {
    prompt: "What's a project you're most proud of?",
  });
  const s2 = loadHandoffState(matchId);
  if (s2?.status !== "round_2") fail("status after round 2 prompt", s2?.status);
  pass("Round 2 icebreaker prompt recorded — status=round_2");

  // Round 2: response
  advanceHandoff(matchId, 2, { response: "Building TrueMatch actually" });
  const s2r = loadHandoffState(matchId);
  if (s2r?.status !== "round_3")
    fail("status after round 2 response", s2r?.status);
  pass("Round 2 response recorded — status=round_3");

  // Round 3: exchange
  const r3 = advanceHandoff(matchId, 3, { exchange: true });
  const s3 = loadHandoffState(matchId);
  if (s3?.status !== "complete") fail("status after round 3", s3?.status);
  pass(`Round 3 complete — platform withdrawn (${r3.slice(0, 40)}...)`);

  // Opt-out path: new handoff, round 1, then round 2 opt-out
  const thread2 = await initiateNegotiation(bob.npub);
  await receiveMessage(
    thread2.thread_id,
    bob.npub,
    JSON.stringify(narrative),
    "match_propose",
  );
  const matched2 = await proposeMatch(
    alice.nsec,
    thread2.thread_id,
    narrative,
    [],
  );
  writePendingNotificationIfMatched(
    thread2.thread_id,
    bob.npub,
    matched2.match_narrative,
  );
  advanceHandoff(thread2.thread_id, 1, { consent: "ok" });
  advanceHandoff(thread2.thread_id, 2, { optOut: true });
  const sOpt = loadHandoffState(thread2.thread_id);
  if (sOpt?.status !== "expired")
    fail("opt-out should set status=expired", sOpt?.status);
  pass("Opt-out path correctly sets status=expired");

  rmSync(dirA, { recursive: true, force: true });
}

// ── Scenario 8: NIP-04 encrypt/decrypt round-trip ────────────────────────────

async function scenario8() {
  section("Scenario 8: NIP-04 encrypt/decrypt round-trip");

  const alice = makeIdentity();
  const bob = makeIdentity();

  // Import the internal crypto functions via the compiled nostr module
  // We test by publishing to [] (no-op) then verifying the encryptMessage/decryptMessage
  // round-trip using nostr-tools directly with the correct key format.
  const { nip04 } = await import("nostr-tools");

  const plaintext = JSON.stringify({
    truematch: "2.0",
    thread_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    type: "negotiation",
    timestamp: new Date().toISOString(),
    content: "Hello from Alice",
  });

  const ciphertext = nip04.encrypt(alice.nsec, bob.npub, plaintext);
  const decrypted = nip04.decrypt(bob.nsec, alice.npub, ciphertext);

  if (decrypted !== plaintext) fail("decrypted content mismatch", decrypted);
  pass("NIP-04 encrypt → decrypt round-trip: content matches");

  // Verify wrong key cannot decrypt
  const charlie = makeIdentity();
  let threw = false;
  try {
    nip04.decrypt(charlie.nsec, alice.npub, ciphertext);
  } catch {
    threw = true;
  }
  if (!threw) fail("wrong key should fail to decrypt", "did not throw");
  pass("Wrong key correctly fails to decrypt");
}

// ── Scenario 9: Live Nostr round-trip (opt-in via --live-nostr) ───────────────
//
// Publishes a real NIP-04 encrypted DM from Alice to Bob over public relays,
// subscribes as Bob, and verifies the message arrives and decrypts correctly.
// Skipped by default — pass --live-nostr to run.

async function scenario9() {
  section("Scenario 9: Live Nostr round-trip (real public relays)");

  const alice = makeIdentity();
  const bob = makeIdentity();

  const payload = {
    truematch: "2.0",
    thread_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    type: "negotiation",
    timestamp: new Date().toISOString(),
    content: "Live Nostr round-trip test — " + Date.now(),
  };

  // Bob subscribes before Alice publishes so we don't miss the event
  const since = Math.floor(Date.now() / 1000) - 5;
  let _received = null;
  let unsubscribe;

  const receivePromise = new Promise((resolve) => {
    subscribeToMessages(
      bob.nsec,
      bob.npub,
      async (fromPubkey, message) => {
        if (fromPubkey === alice.npub && message.content === payload.content) {
          _received = message;
          resolve();
        }
      },
      DEFAULT_RELAYS,
      since,
    ).then((unsub) => {
      unsubscribe = unsub;
    });
  });

  // Give subscription a moment to establish before publishing
  await new Promise((r) => setTimeout(r, 1500));

  // Alice publishes to real relays
  try {
    await publishMessage(alice.nsec, bob.npub, payload, DEFAULT_RELAYS);
    pass("Alice published message to live relays");
  } catch (err) {
    fail("Alice failed to publish", err.message);
    unsubscribe?.();
    return;
  }

  // Wait up to 15 seconds for Bob to receive
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout after 15s")), 15000),
  );

  try {
    await Promise.race([receivePromise, timeout]);
    pass(`Bob received message from relay — content matches`);
    pass(`Relay round-trip confirmed on: ${DEFAULT_RELAYS.join(", ")}`);
  } catch (err) {
    fail("Bob did not receive message", err.message);
  } finally {
    unsubscribe?.();
  }
}

// ── Scenario 10: Multi-party offline (6 agents, 3 pairs) ─────────────────────
//
// Runs 3 completely isolated pairs through their full negotiation flows:
//   Pair 1 (Alice / Bob)  → double-lock match
//   Pair 2 (Carol / Dave) → decline
//   Pair 3 (Eve / Frank)  → double-lock match
// Each pair has its own isolated temp dir. Sequential — no live Nostr needed.

async function scenario10() {
  section("Scenario 10: Multi-party offline (6 agents, 3 pairs)");

  const narrative = {
    headline: "Strong alignment across core dimensions",
    strengths: ["shared values", "compatible communication style"],
    watch_points: ["life velocity difference worth exploring"],
    confidence_summary: "0.80 composite",
  };

  // ── Pair 1: Alice / Bob → double-lock match ────────────────────────────────
  {
    const dirA = makeTestDir("alice10");
    const dirB = makeTestDir("bob10");
    const alice = makeIdentity();
    const bob = makeIdentity();
    writeIdentity(dirA, alice);
    writeIdentity(dirB, bob);

    setAgent(dirA);
    const thread = await initiateNegotiation(bob.npub);

    // Bob receives Alice's opening + her proposal
    setAgent(dirB);
    await receiveMessage(thread.thread_id, alice.npub, "Hi!", "negotiation");
    await receiveMessage(
      thread.thread_id,
      alice.npub,
      JSON.stringify(narrative),
      "match_propose",
    );

    // Alice receives Bob's proposal → she proposes → double-lock
    setAgent(dirA);
    await receiveMessage(
      thread.thread_id,
      bob.npub,
      JSON.stringify(narrative),
      "match_propose",
    );
    const result = await proposeMatch(
      alice.nsec,
      thread.thread_id,
      narrative,
      [],
    );
    if (result.status !== "matched")
      fail("Pair 1: Alice should be matched", result.status);
    else pass("Pair 1 (Alice/Bob): double-lock match confirmed");

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }

  // ── Pair 2: Carol / Dave → decline ────────────────────────────────────────
  {
    const dirC = makeTestDir("carol10");
    const dirD = makeTestDir("dave10");
    const carol = makeIdentity();
    const dave = makeIdentity();
    writeIdentity(dirC, carol);
    writeIdentity(dirD, dave);

    setAgent(dirC);
    const thread = await initiateNegotiation(dave.npub);

    setAgent(dirD);
    await receiveMessage(thread.thread_id, carol.npub, "Hi", "negotiation");
    const daveSees = await receiveMessage(
      thread.thread_id,
      carol.npub,
      "",
      "end",
    );
    if (daveSees?.status !== "declined")
      fail("Pair 2: Dave should see declined", daveSees?.status);

    setAgent(dirC);
    const carolSees = await receiveMessage(
      thread.thread_id,
      dave.npub,
      "",
      "end",
    );
    if (carolSees?.status !== "declined")
      fail("Pair 2: Carol should see declined", carolSees?.status);
    else pass("Pair 2 (Carol/Dave): decline confirmed on both sides");

    rmSync(dirC, { recursive: true, force: true });
    rmSync(dirD, { recursive: true, force: true });
  }

  // ── Pair 3: Eve / Frank → double-lock match ────────────────────────────────
  {
    const dirE = makeTestDir("eve10");
    const dirF = makeTestDir("frank10");
    const eve = makeIdentity();
    const frank = makeIdentity();
    writeIdentity(dirE, eve);
    writeIdentity(dirF, frank);

    setAgent(dirE);
    const thread = await initiateNegotiation(frank.npub);

    // Frank receives Eve's message and proposes first
    setAgent(dirF);
    await receiveMessage(thread.thread_id, eve.npub, "Hey!", "negotiation");
    const frankProposed = await proposeMatch(
      frank.nsec,
      thread.thread_id,
      narrative,
      [],
    );
    if (!frankProposed.we_proposed)
      fail(
        "Pair 3: Frank we_proposed should be true",
        frankProposed.we_proposed,
      );

    // Eve receives Frank's proposal → she proposes → matched
    setAgent(dirE);
    await receiveMessage(
      thread.thread_id,
      frank.npub,
      JSON.stringify(narrative),
      "match_propose",
    );
    const eveResult = await proposeMatch(
      eve.nsec,
      thread.thread_id,
      narrative,
      [],
    );
    if (eveResult.status !== "matched")
      fail("Pair 3: Eve should be matched", eveResult.status);
    else pass("Pair 3 (Eve/Frank): double-lock match confirmed");

    // Frank's side: receives Eve's proposal → also matched
    setAgent(dirF);
    const frankSees = await receiveMessage(
      thread.thread_id,
      eve.npub,
      JSON.stringify(narrative),
      "match_propose",
    );
    if (frankSees?.status !== "matched")
      fail("Pair 3: Frank side should show matched", frankSees?.status);
    else pass("Pair 3: Frank's side also shows matched");

    rmSync(dirE, { recursive: true, force: true });
    rmSync(dirF, { recursive: true, force: true });
  }
}

// ── Party class (used by Scenario 11) ────────────────────────────────────────
//
// Subscription callbacks ONLY push to inbox — no setAgent or file I/O inside.
// Subscription callbacks from multiple relays fire concurrently; the global
// TRUEMATCH_DIR_OVERRIDE env var is not safe to set from concurrent callbacks.
// Instead, all negotiation processing is done sequentially in processInbox().

class Party {
  constructor(name) {
    this.name = name;
    this.dir = makeTestDir(name + "11");
    this.identity = makeIdentity();
    this.inbox = [];
    this.unsubscribe = null;
    writeIdentity(this.dir, this.identity);
  }

  async subscribe(since) {
    this.unsubscribe = await subscribeToMessages(
      this.identity.nsec,
      this.identity.npub,
      async (fromPubkey, message) => {
        // INBOX ONLY — never call setAgent or file I/O here.
        this.inbox.push({ fromPubkey, message });
      },
      DEFAULT_RELAYS,
      since,
    );
  }

  async waitForMessages(count, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (this.inbox.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    return this.inbox.length >= count;
  }

  // Process all queued inbox messages under this party's agent dir. Sequential.
  async processInbox() {
    const messages = [...this.inbox];
    this.inbox = [];
    setAgent(this.dir);
    for (const { fromPubkey, message } of messages) {
      await receiveMessage(
        message.thread_id,
        fromPubkey,
        message.content ?? "",
        message.type ?? "negotiation",
      );
    }
  }

  cleanup() {
    this.unsubscribe?.();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ── Scenario 11: Multi-party live Nostr (6 agents, 3 pairs) ──────────────────
//
// All 6 agents subscribe to live relays simultaneously.
// Message processing is sequential (inbox-only pattern) to avoid global env var races.
//   Pair 1 (Alice / Bob)  → Alice proposes → Bob counters → both matched
//   Pair 2 (Carol / Dave) → Carol sends a message → Dave declines live
//   Pair 3 (Eve / Frank)  → Eve proposes → Frank counters → both matched
// Requires --live-nostr. Expected runtime: ~40–70 seconds on public relays.

async function scenario11() {
  section("Scenario 11: Multi-party live Nostr (6 agents, 3 pairs)");

  const since = Math.floor(Date.now() / 1000) - 10;
  const alice = new Party("alice");
  const bob = new Party("bob");
  const carol = new Party("carol");
  const dave = new Party("dave");
  const eve = new Party("eve");
  const frank = new Party("frank");
  const allParties = [alice, bob, carol, dave, eve, frank];

  const narrative = {
    headline: "Live relay multi-party match — genuine alignment signal",
    strengths: ["values overlap", "complementary communication style"],
    watch_points: ["geographic distance worth discussing"],
    confidence_summary: "0.78 composite",
  };

  // Subscribe all 6 simultaneously before any messages are sent
  await Promise.all(allParties.map((p) => p.subscribe(since)));
  pass("All 6 agents subscribed to live relays simultaneously");

  // Allow WebSocket connections to establish before publishing
  await new Promise((r) => setTimeout(r, 2000));

  try {
    // ── Pair 1: Alice / Bob → double-lock match ──────────────────────────────
    setAgent(alice.dir);
    const threadAB = await initiateNegotiation(bob.identity.npub);

    // Alice proposes directly (no prior message round-trip needed)
    setAgent(alice.dir);
    await proposeMatch(
      alice.identity.nsec,
      threadAB.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    pass("Pair 1: Alice published proposal to live relays");

    // Bob receives Alice's proposal
    if (!(await bob.waitForMessages(1))) {
      fail("Pair 1: Bob did not receive Alice's proposal", "timeout");
      return;
    }
    await bob.processInbox();
    pass("Pair 1: Bob received Alice's proposal");

    // Bob counters → double-lock from Bob's side
    setAgent(bob.dir);
    const bobResult = await proposeMatch(
      bob.identity.nsec,
      threadAB.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    if (bobResult.status !== "matched")
      fail(
        "Pair 1: Bob should be matched after counter-propose",
        bobResult.status,
      );
    else pass("Pair 1: Bob's side shows matched");

    // Alice receives Bob's counter-proposal → both sides matched
    if (!(await alice.waitForMessages(1))) {
      fail("Pair 1: Alice did not receive Bob's proposal", "timeout");
      return;
    }
    await alice.processInbox();
    setAgent(alice.dir);
    const aliceThread = await loadThread(threadAB.thread_id);
    if (aliceThread?.status !== "matched")
      fail("Pair 1: Alice side should show matched", aliceThread?.status);
    else
      pass("Pair 1 (Alice/Bob): double-lock match confirmed over live relay");

    // ── Pair 2: Carol / Dave → decline ────────────────────────────────────
    setAgent(carol.dir);
    const threadCD = await initiateNegotiation(dave.identity.npub);
    await sendMessage(
      carol.identity.nsec,
      threadCD.thread_id,
      "Hi Dave, want to connect?",
      DEFAULT_RELAYS,
    );
    pass("Pair 2: Carol sent opening message");

    if (!(await dave.waitForMessages(1))) {
      fail("Pair 2: Dave did not receive Carol's message", "timeout");
      return;
    }
    await dave.processInbox();
    pass("Pair 2: Dave received Carol's message");

    setAgent(dave.dir);
    await declineMatch(dave.identity.nsec, threadCD.thread_id, DEFAULT_RELAYS);
    pass("Pair 2: Dave sent decline over live relay");

    if (!(await carol.waitForMessages(1))) {
      fail("Pair 2: Carol did not receive Dave's decline", "timeout");
      return;
    }
    await carol.processInbox();
    setAgent(carol.dir);
    const carolThread = await loadThread(threadCD.thread_id);
    if (carolThread?.status !== "declined")
      fail("Pair 2: Carol should see declined", carolThread?.status);
    else pass("Pair 2 (Carol/Dave): decline confirmed over live relay");

    // ── Pair 3: Eve / Frank → double-lock match ──────────────────────────
    setAgent(eve.dir);
    const threadEF = await initiateNegotiation(frank.identity.npub);
    await proposeMatch(
      eve.identity.nsec,
      threadEF.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    pass("Pair 3: Eve published proposal to live relays");

    if (!(await frank.waitForMessages(1))) {
      fail("Pair 3: Frank did not receive Eve's proposal", "timeout");
      return;
    }
    await frank.processInbox();

    setAgent(frank.dir);
    const frankResult = await proposeMatch(
      frank.identity.nsec,
      threadEF.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    if (frankResult.status !== "matched")
      fail("Pair 3: Frank should be matched", frankResult.status);
    else pass("Pair 3: Frank's side shows matched");

    if (!(await eve.waitForMessages(1))) {
      fail("Pair 3: Eve did not receive Frank's proposal", "timeout");
      return;
    }
    await eve.processInbox();
    setAgent(eve.dir);
    const eveThread = await loadThread(threadEF.thread_id);
    if (eveThread?.status !== "matched")
      fail("Pair 3: Eve side should show matched", eveThread?.status);
    else
      pass("Pair 3 (Eve/Frank): double-lock match confirmed over live relay");

    pass(
      "All 3 pairs completed — multi-party live Nostr simulation successful",
    );
  } finally {
    for (const p of allParties) p.cleanup();
  }
}

// ── Scenario 12: poll.ts JSONL output via child process ──────────────────────
//
// Verifies that dist/poll.js correctly fetches and decodes NIP-04 DMs from
// live relays and emits them as JSONL on stdout.
//
// Approach: publish a DM to a fresh test identity's pubkey, then spawn
// `node dist/poll.js` with HOME pointing to the test dir (os.homedir() reads
// $HOME, so poll.js's hardcoded TRUEMATCH_DIR resolves to the temp dir).

async function scenario12() {
  section("Scenario 12: poll.ts JSONL output via child process");

  const pollHome = mkdtempSync(join(tmpdir(), "tm-pollhome-"));
  const tmDir = join(pollHome, ".truematch");
  mkdirSync(tmDir, { recursive: true, mode: 0o700 });

  const poller = makeIdentity();
  const sender = makeIdentity();

  // Write the poller's identity so poll.js can load it
  writeFileSync(
    join(tmDir, "identity.json"),
    JSON.stringify({ ...poller, created_at: new Date().toISOString() }),
    { encoding: "utf8", mode: 0o600 },
  );

  // Publish a valid TrueMatch DM from sender → poller
  const pollPayload = {
    truematch: "2.0",
    thread_id: "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee",
    type: "negotiation",
    timestamp: new Date().toISOString(),
    content: "Poll scenario test message " + Date.now(),
  };

  try {
    await publishMessage(sender.nsec, poller.npub, pollPayload, DEFAULT_RELAYS);
    pass("Sender published test DM to poller's pubkey over live relays");
  } catch (err) {
    fail("Failed to publish test DM", err.message);
    rmSync(pollHome, { recursive: true, force: true });
    return;
  }

  // Wait for relay propagation before polling
  await new Promise((r) => setTimeout(r, 4000));

  const pollJs = join(__dirname, "dist", "poll.js");
  const stdout = await new Promise((resolve, reject) => {
    // HOME override redirects poll.js's os.homedir() to the isolated temp dir
    const child = spawn("node", [pollJs], {
      env: { ...process.env, HOME: pollHome },
      timeout: 15000,
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      errOut += d;
    });
    child.on("close", (code) => {
      if (code !== 0)
        reject(new Error(`poll.js exited ${code}: ${errOut.trim()}`));
      else resolve(out);
    });
    child.on("error", reject);
  }).catch((err) => {
    fail("poll.js process failed", err.message);
    return null;
  });

  if (stdout !== null) {
    const lines = stdout.trim().split("\n").filter(Boolean);
    const found = lines.some((line) => {
      try {
        const msg = JSON.parse(line);
        return (
          msg.type === "negotiation" &&
          msg.peer_pubkey === sender.npub &&
          msg.thread_id === pollPayload.thread_id
        );
      } catch {
        return false;
      }
    });
    if (!found)
      fail(
        "poll.ts JSONL should contain the test message",
        `got ${lines.length} line(s): ${lines.slice(0, 2).join(" | ") || "(empty)"}`,
      );
    else
      pass(
        `poll.ts JSONL output verified — ${lines.length} message(s) decoded`,
      );
  }

  rmSync(pollHome, { recursive: true, force: true });
}

// ── Mock registry server (used by Scenario 13) ───────────────────────────────
//
// Minimal in-process HTTP stub for POST /v1/register, DELETE /v1/register,
// and GET /v1/agents. No signature verification — simulation only.
// Listens on 127.0.0.1 with an OS-assigned port to avoid conflicts.

function startMockRegistry() {
  const agents = new Map(); // pubkey → { pubkey, cardUrl, lastSeen }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);

    if (req.method === "GET" && url.pathname === "/v1/agents") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [...agents.values()].map((a) => ({
            pubkey: a.pubkey,
            cardUrl: a.cardUrl,
            lastSeen: a.lastSeen,
          })),
        }),
      );
      return;
    }

    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (req.method === "POST" && url.pathname === "/v1/register") {
          agents.set(data.pubkey, {
            pubkey: data.pubkey,
            cardUrl: data.card_url,
            lastSeen: new Date().toISOString(),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              enrolled: true,
              pubkey: data.pubkey,
              location_lat: null,
              location_lng: null,
              location_label: null,
              location_resolution: null,
            }),
          );
          return;
        }
        if (req.method === "DELETE" && url.pathname === "/v1/register") {
          agents.delete(data.pubkey);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        agents,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── Scenario 13: match --start with mock registry ────────────────────────────
//
// Exercises the full match --start candidate selection loop against an in-process
// HTTP stub. Tests: register, listAgents, candidate filtering (exclude self +
// active threads), thread initiation, and deregister.
//
// TRUEMATCH_REGISTRY_URL_OVERRIDE redirects all registry.ts HTTP calls to the
// stub without touching the real clawmatch.org.

async function scenario13() {
  section("Scenario 13: match --start with mock registry");

  const mock = await startMockRegistry();
  process.env["TRUEMATCH_REGISTRY_URL_OVERRIDE"] = mock.url;

  const dirA = makeTestDir("alice13");
  const dirB = makeTestDir("bob13");
  const dirC = makeTestDir("carol13");
  const alice = makeIdentity();
  const bob = makeIdentity();
  const carol = makeIdentity();
  writeIdentity(dirA, alice);
  writeIdentity(dirB, bob);
  writeIdentity(dirC, carol);

  try {
    // ── Registration ───────────────────────────────────────────────────────
    setAgent(dirA);
    const regA = await register(alice, "https://alice.example.com/card", {
      type: "email",
      value: "alice@example.com",
    });
    if (!regA.enrolled) fail("Alice should be enrolled", regA.enrolled);
    else pass("Alice registered with mock registry");

    setAgent(dirB);
    await register(bob, "https://bob.example.com/card", {
      type: "email",
      value: "bob@example.com",
    });
    pass("Bob registered with mock registry");

    setAgent(dirC);
    await register(carol, "https://carol.example.com/card", {
      type: "email",
      value: "carol@example.com",
    });
    pass("Carol registered with mock registry");

    // ── listAgents returns all 3 ───────────────────────────────────────────
    const all = await listAgents();
    if (all.length !== 3) fail("listAgents should return 3 agents", all.length);
    else pass(`listAgents returns ${all.length} agents`);

    // ── Candidate selection from Alice's perspective ───────────────────────
    // Mirrors the logic in cmdMatch() --start: exclude self + active threads
    setAgent(dirA);
    const activeThreads = await listActiveThreads();
    const activePeers = new Set(activeThreads.map((t) => t.peer_pubkey));
    const candidates = all.filter(
      (a) => a.pubkey !== alice.npub && !activePeers.has(a.pubkey),
    );
    if (candidates.length !== 2)
      fail(
        "Alice should see 2 candidates (not herself)",
        `got ${candidates.length}`,
      );
    else pass("Candidate selection: Alice sees Bob + Carol (self excluded)");

    // ── Initiate a thread with one candidate ──────────────────────────────
    const peer = candidates[0];
    const thread = await initiateNegotiation(peer.pubkey);
    if (!thread.thread_id)
      fail("Thread should have been created", "no thread_id");
    else
      pass(
        `Thread initiated with ${peer.pubkey.slice(0, 12)}... — id: ${thread.thread_id.slice(0, 8)}...`,
      );

    // ── Active thread exclusion ────────────────────────────────────────────
    const activeThreads2 = await listActiveThreads();
    const activePeers2 = new Set(activeThreads2.map((t) => t.peer_pubkey));
    const candidates2 = all.filter(
      (a) => a.pubkey !== alice.npub && !activePeers2.has(a.pubkey),
    );
    if (candidates2.length !== 1)
      fail(
        "After thread creation, peer should be excluded from candidate pool",
        `got ${candidates2.length}`,
      );
    else pass("Active thread peer correctly excluded from candidate pool");

    // ── Deregistration ────────────────────────────────────────────────────
    setAgent(dirB);
    await deregister(bob);
    const allAfter = await listAgents();
    if (allAfter.length !== 2)
      fail(
        "After Bob deregisters, registry should have 2 agents",
        `got ${allAfter.length}`,
      );
    else pass("Deregistration: Bob removed from registry");

    // Local registration.json should mark enrolled=false
    const regBAfter = await loadRegistration();
    if (regBAfter?.enrolled !== false)
      fail(
        "Bob's registration.json should show enrolled=false",
        regBAfter?.enrolled,
      );
    else pass("Local registration.json correctly marks enrolled=false");
  } finally {
    delete process.env["TRUEMATCH_REGISTRY_URL_OVERRIDE"];
    await mock.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }
}

// ── Scenario 14: Full end-to-end (mock registry + live Nostr) ────────────────
//
// The complete production flow in simulation:
//   1. Both agents register with a mock registry
//   2. Alice discovers Bob via listAgents() (candidate selection)
//   3. Alice initiates a thread and sends the opening over live Nostr relays
//   4. Bob receives it via subscription, processes inbox, proposes match
//   5. Alice receives Bob's proposal, counter-proposes → double-lock confirmed
//   6. Both sides show status=matched
//
// This is the only scenario that exercises registry discovery AND Nostr transport
// together. Requires --live-nostr.

async function scenario14() {
  section("Scenario 14: Full end-to-end (mock registry + live Nostr)");

  const mock = await startMockRegistry();
  process.env["TRUEMATCH_REGISTRY_URL_OVERRIDE"] = mock.url;

  const since = Math.floor(Date.now() / 1000) - 10;
  const alice = new Party("alice14");
  const bob = new Party("bob14");

  const narrative = {
    headline:
      "Full end-to-end match — registry discovery + live relay negotiation",
    strengths: ["values alignment", "compatible communication style"],
    watch_points: ["not yet known — first contact"],
    confidence_summary: "0.77 composite",
  };

  try {
    // ── Both agents register ───────────────────────────────────────────────
    setAgent(alice.dir);
    await register(alice.identity, "https://alice.example.com/card", {
      type: "email",
      value: "alice@example.com",
    });
    pass("Alice registered with mock registry");

    setAgent(bob.dir);
    await register(bob.identity, "https://bob.example.com/card", {
      type: "email",
      value: "bob@example.com",
    });
    pass("Bob registered with mock registry");

    // ── Alice discovers Bob via registry ──────────────────────────────────
    setAgent(alice.dir);
    const all = await listAgents();
    const candidates = all.filter((a) => a.pubkey !== alice.identity.npub);
    if (candidates.length !== 1 || candidates[0].pubkey !== bob.identity.npub) {
      fail(
        "Alice should discover exactly Bob as a candidate",
        candidates.length,
      );
      return;
    }
    pass("Alice discovered Bob via registry (1 candidate)");

    // ── Subscribe both to live relays ─────────────────────────────────────
    await Promise.all([alice.subscribe(since), bob.subscribe(since)]);
    pass("Both agents subscribed to live relays");
    await new Promise((r) => setTimeout(r, 2000));

    // ── Alice initiates and sends opening over live relay ─────────────────
    setAgent(alice.dir);
    const thread = await initiateNegotiation(bob.identity.npub);
    await sendMessage(
      alice.identity.nsec,
      thread.thread_id,
      "Hi — my agent found you through the registry. Keen to explore compatibility.",
      DEFAULT_RELAYS,
    );
    pass("Alice sent opening message over live relay");

    // ── Bob receives opening ──────────────────────────────────────────────
    if (!(await bob.waitForMessages(1))) {
      fail("Bob did not receive Alice's opening message", "timeout");
      return;
    }
    await bob.processInbox();
    pass("Bob received Alice's opening message");

    // ── Bob proposes match ────────────────────────────────────────────────
    setAgent(bob.dir);
    await proposeMatch(
      bob.identity.nsec,
      thread.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    pass("Bob proposed match over live relay");

    // ── Alice receives Bob's proposal and counter-proposes ────────────────
    if (!(await alice.waitForMessages(1))) {
      fail("Alice did not receive Bob's proposal", "timeout");
      return;
    }
    await alice.processInbox();
    setAgent(alice.dir);
    const aliceResult = await proposeMatch(
      alice.identity.nsec,
      thread.thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    if (aliceResult.status !== "matched") {
      fail("Alice should be matched after counter-propose", aliceResult.status);
      return;
    }
    pass("Alice's side: double-lock match confirmed");

    // ── Bob receives Alice's counter-proposal ─────────────────────────────
    if (!(await bob.waitForMessages(1))) {
      fail("Bob did not receive Alice's counter-proposal", "timeout");
      return;
    }
    await bob.processInbox();
    setAgent(bob.dir);
    const bobThread = await loadThread(thread.thread_id);
    if (bobThread?.status !== "matched")
      fail("Bob's side should also show matched", bobThread?.status);
    else pass("Bob's side: double-lock match confirmed");

    pass(
      "Full end-to-end verified — registry discovery → Nostr negotiation → match",
    );
  } finally {
    delete process.env["TRUEMATCH_REGISTRY_URL_OVERRIDE"];
    await mock.close();
    alice.cleanup();
    bob.cleanup();
  }
}

// ── Run all scenarios ─────────────────────────────────────────────────────────

const liveNostr = process.argv.includes("--live-nostr");
console.log("TrueMatch E2E Simulation\n");
const originalOverride = process.env["TRUEMATCH_DIR_OVERRIDE"];

function skipLive(label) {
  console.log(`\n── ${label} ──`);
  console.log("  (skipped — pass --live-nostr to run against real relays)");
}

try {
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  if (liveNostr) {
    await scenario9();
  } else {
    skipLive("Scenario 9: Live Nostr round-trip");
  }
  await scenario10();
  if (liveNostr) {
    await scenario11();
    await scenario12();
  } else {
    skipLive("Scenario 11: Multi-party live Nostr");
    skipLive("Scenario 12: poll.ts JSONL output");
  }
  await scenario13();
  if (liveNostr) {
    await scenario14();
  } else {
    skipLive("Scenario 14: Full end-to-end (mock registry + live Nostr)");
  }
} finally {
  if (originalOverride === undefined) {
    delete process.env["TRUEMATCH_DIR_OVERRIDE"];
  } else {
    process.env["TRUEMATCH_DIR_OVERRIDE"] = originalOverride;
  }
}

console.log("\n" + (process.exitCode ? "FAILED" : "All scenarios passed."));
