/**
 * TrueMatch end-to-end simulation
 *
 * Simulates two agents (Alice and Bob) going through the full matching flow:
 *   Scenario 1 — Successful double-lock match
 *   Scenario 2 — Bob declines (sends "end")
 *   Scenario 3 — Pending notification written on match
 *   Scenario 4 — Per-peer inbound thread DoS cap
 *
 * Bypasses live Nostr relays — tests the negotiation state machine directly.
 * Uses TRUEMATCH_DIR_OVERRIDE to give each agent an isolated temp directory
 * without reloading modules.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

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

function eligibleObs() {
  const dim = {
    confidence: 0.8,
    observation_count: 8,
    behavioral_context_diversity: "medium",
  };
  return {
    updated_at: new Date().toISOString(),
    eligibility_computed_at: new Date().toISOString(),
    matching_eligible: true,
    conversation_count: 5,
    observation_span_days: 4,
    attachment: { ...dim },
    core_values: { ...dim },
    communication: { ...dim },
    emotional_regulation: { ...dim, confidence: 0.75 },
    humor: { ...dim },
    life_velocity: { ...dim, confidence: 0.65 },
    dealbreakers: { ...dim, confidence: 0.9 },
    conflict_resolution: { ...dim },
    interdependence_model: { ...dim, confidence: 0.65 },
    dealbreaker_gate_state: "confirmed",
    inferred_intent_category: "serious",
  };
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
const { initiateNegotiation, receiveMessage, proposeMatch, loadThread } =
  await import("./dist/negotiation.js");
const { writePendingNotificationIfMatched, loadPendingNotification } =
  await import("./dist/handoff.js");

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

// ── Run all scenarios ─────────────────────────────────────────────────────────

console.log("TrueMatch E2E Simulation\n");
const originalOverride = process.env["TRUEMATCH_DIR_OVERRIDE"];

try {
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
} finally {
  if (originalOverride === undefined) {
    delete process.env["TRUEMATCH_DIR_OVERRIDE"];
  } else {
    process.env["TRUEMATCH_DIR_OVERRIDE"] = originalOverride;
  }
}

console.log("\n" + (process.exitCode ? "FAILED" : "All scenarios passed."));
