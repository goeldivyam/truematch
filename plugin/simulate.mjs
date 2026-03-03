/* global process, console, setTimeout */
/**
 * TrueMatch end-to-end simulation
 *
 * Simulates two agents (Alice and Bob) going through the full matching flow:
 *   Scenario 1 — Successful double-lock match
 *   Scenario 2 — Bob declines (sends "end")
 *   Scenario 3 — Pending notification written on match
 *   Scenario 4 — Per-peer inbound thread DoS cap
 *   Scenario 5 — Thread expiry (72h stale timeout)
 *   Scenario 6 — Round cap (10-round hard limit)
 *   Scenario 7 — Handoff rounds 1 → 2 → 3 → complete + opt-out path
 *   Scenario 8 — NIP-04 encrypt/decrypt round-trip + wrong-key rejection
 *   Scenario 9 — Live Nostr round-trip (opt-in: --live-nostr)
 *
 * Scenarios 1-8 bypass live Nostr relays and test the state machine directly.
 * Scenario 9 publishes a real NIP-04 DM to public relays and verifies receipt.
 * Uses TRUEMATCH_DIR_OVERRIDE to give each agent an isolated temp directory
 * without reloading modules.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  loadThread,
  saveThread,
  expireStaleThreads,
} = await import("./dist/negotiation.js");
const {
  writePendingNotificationIfMatched,
  loadPendingNotification,
  loadHandoffState,
  advanceHandoff,
} = await import("./dist/handoff.js");

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
  section("Scenario 5: Live Nostr round-trip (real public relays)");

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

// ── Run all scenarios ─────────────────────────────────────────────────────────

const liveNostr = process.argv.includes("--live-nostr");
console.log("TrueMatch E2E Simulation\n");
const originalOverride = process.env["TRUEMATCH_DIR_OVERRIDE"];

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
    console.log("\n── Scenario 9: Live Nostr round-trip ──");
    console.log("  (skipped — pass --live-nostr to run against real relays)");
  }
} finally {
  if (originalOverride === undefined) {
    delete process.env["TRUEMATCH_DIR_OVERRIDE"];
  } else {
    process.env["TRUEMATCH_DIR_OVERRIDE"] = originalOverride;
  }
}

console.log("\n" + (process.exitCode ? "FAILED" : "All scenarios passed."));
