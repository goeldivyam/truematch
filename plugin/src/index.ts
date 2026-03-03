#!/usr/bin/env node
/**
 * TrueMatch sidecar CLI
 *
 * Usage:
 *   truematch setup [--contact-type email|discord|telegram] [--contact-value <val>]
 *   truematch status [--relays]
 *   truematch observe --show | --update | --write '<json>'
 *   truematch preferences --show | --set '<json>'
 *   truematch match --start | --status [--thread <id>] | --messages --thread <id>
 *                   | --send '<msg>' --thread <id>
 *                   | --propose --thread <id> --write '<narrative-json>'
 *                   | --decline --thread <id>
 *                   | --reset --thread <id>
 *   truematch deregister
 */

import { parseArgs } from "node:util";
import { getOrCreateIdentity, loadIdentity, ensureDir } from "./identity.js";
import {
  register,
  deregister,
  loadRegistration,
  listAgents,
} from "./registry.js";
import {
  loadObservation,
  saveObservation,
  emptyObservation,
  eligibilityReport,
  isEligible,
  isStale,
} from "./observation.js";
import {
  loadThread,
  listActiveThreads,
  initiateNegotiation,
  receiveMessage,
  sendMessage,
  proposeMatch,
  declineMatch,
  expireStaleThreads,
  saveThread,
} from "./negotiation.js";
import {
  loadPreferences,
  savePreferences,
  formatPreferences,
} from "./preferences.js";
import {
  checkRelayConnectivity,
  subscribeToMessages,
  DEFAULT_RELAYS,
} from "./nostr.js";
import type {
  ContactType,
  ObservationSummary,
  MatchNarrative,
  UserPreferences,
} from "./types.js";

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "contact-type": { type: "string" },
    "contact-value": { type: "string" },
    show: { type: "boolean" },
    update: { type: "boolean" },
    write: { type: "string" },
    set: { type: "string" },
    relays: { type: "boolean" },
    start: { type: "boolean" },
    status: { type: "boolean" },
    reset: { type: "boolean" },
    thread: { type: "string" },
    send: { type: "string" },
    propose: { type: "boolean" },
    decline: { type: "boolean" },
    messages: { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

async function main(): Promise<void> {
  await ensureDir();

  switch (command) {
    case "setup":
      await cmdSetup();
      break;
    case "status":
      await cmdStatus();
      break;
    case "observe":
      await cmdObserve();
      break;
    case "preferences":
      await cmdPreferences();
      break;
    case "match":
      await cmdMatch();
      break;
    case "deregister":
      await cmdDeregister();
      break;
    default:
      console.log(`TrueMatch CLI — https://clawmatch.org

Commands:
  setup        Generate identity and register with TrueMatch
  status       Show registration and observation status
  observe      View or update the ObservationSummary
  preferences  Set or view Layer 0 matching filters (gender, location, age)
  match        Manage matching negotiations
  deregister   Remove from the matching pool

Run with --help on any command for options.`);
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────

async function cmdSetup(): Promise<void> {
  const identity = await getOrCreateIdentity();

  const contactType = (args["contact-type"] ?? "email") as ContactType;
  const contactValue = args["contact-value"] as string | undefined;

  if (!contactValue) {
    console.log(`Identity ready. npub: ${identity.npub}

To complete setup, provide your contact channel:
  truematch setup --contact-type email --contact-value you@example.com
  truematch setup --contact-type discord --contact-value username#1234
  truematch setup --contact-type telegram --contact-value @handle`);
    return;
  }

  if (!["email", "discord", "telegram"].includes(contactType)) {
    console.error(
      "Invalid --contact-type. Must be: email, discord, or telegram",
    );
    process.exit(1);
  }

  const cardUrl =
    process.env["TRUEMATCH_CARD_URL"] ??
    `https://clawmatch.org/.well-known/agent-card.json`;

  const reg = await register(identity, cardUrl, {
    type: contactType,
    value: contactValue,
  });

  console.log(`Registered with TrueMatch.
  pubkey:  ${reg.pubkey}
  contact: ${reg.contact_channel.type} / ${reg.contact_channel.value}

Next: run 'truematch observe --update' after a few conversations to build your personality model.`);
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) {
    console.log("Not set up. Run: truematch setup");
    return;
  }

  console.log(`Identity: ${identity.npub.slice(0, 16)}...`);

  const reg = await loadRegistration();
  console.log(`Registration: ${reg?.enrolled ? "active" : "not registered"}`);

  const obs = await loadObservation();
  if (!obs) {
    console.log("Observation: none — run 'truematch observe --update'");
  } else {
    console.log(`\nObservation eligibility:\n${eligibilityReport(obs)}`);
    console.log(`\nPool eligible: ${isEligible(obs) ? "YES" : "NO"}`);
    if (isStale(obs)) {
      console.log("⚠ Manifest is stale — run 'truematch observe --update'");
    }
  }

  const prefs = await loadPreferences();
  console.log(`\nPreferences: ${formatPreferences(prefs)}`);

  const active = await listActiveThreads();
  if (active.length > 0) {
    console.log(`\nActive negotiations: ${active.length}`);
    for (const t of active) {
      console.log(
        `  ${t.thread_id.slice(0, 8)}... — round ${t.round_count}/10 — peer: ${t.peer_pubkey.slice(0, 12)}...`,
      );
    }
  }

  if (args["relays"]) {
    console.log("\nRelay connectivity:");
    const connectivity = await checkRelayConnectivity();
    for (const [relay, ok] of Object.entries(connectivity)) {
      console.log(`  ${ok ? "✓" : "✗"} ${relay}`);
    }
  }
}

// ── observe ───────────────────────────────────────────────────────────────────

async function cmdObserve(): Promise<void> {
  if (args["show"]) {
    const obs = await loadObservation();
    if (!obs) {
      console.log("No observation summary yet.");
    } else {
      console.log(JSON.stringify(obs, null, 2));
    }
    return;
  }

  if (args["write"]) {
    const json = args["write"] as string;
    let obs: ObservationSummary;
    try {
      obs = JSON.parse(json) as ObservationSummary;
    } catch {
      console.error("Invalid JSON");
      process.exit(1);
    }
    await saveObservation(obs);
    console.log(`ObservationSummary saved. Eligible: ${isEligible(obs)}`);
    return;
  }

  if (args["update"]) {
    const existing = (await loadObservation()) ?? emptyObservation();
    console.log("CURRENT_OBSERVATION:");
    console.log(JSON.stringify(existing, null, 2));
    console.log("\nREVIEW_INSTRUCTIONS:");
    console.log(
      "Review your memory of this user and update the confidence scores and observation counts above.\n" +
        "For each dimension, set:\n" +
        "  confidence: 0.0–1.0 (how well do you know this dimension?)\n" +
        "  observation_count: how many signals have you seen?\n" +
        "  behavioral_context_diversity: low/medium/high (one context vs many?)\n" +
        "Set dealbreaker_gate_state to: confirmed | below_floor | none_observed\n\n" +
        "When done, save with:\n" +
        "  truematch observe --write '<updated-json>'",
    );
    return;
  }

  console.log("Usage: truematch observe --show | --update | --write '<json>'");
}

// ── preferences ───────────────────────────────────────────────────────────────

async function cmdPreferences(): Promise<void> {
  if (args["show"]) {
    const prefs = await loadPreferences();
    console.log(JSON.stringify(prefs, null, 2));
    console.log(`\n${formatPreferences(prefs)}`);
    return;
  }

  if (args["set"]) {
    const json = args["set"] as string;
    let prefs: UserPreferences;
    try {
      prefs = JSON.parse(json) as UserPreferences;
    } catch {
      console.error("Invalid JSON");
      process.exit(1);
    }
    await savePreferences(prefs);
    console.log(`Preferences saved.\n${formatPreferences(prefs)}`);
    console.log(
      "\nNote: serious/casual intent is not set here — Claude infers it from your behavior.",
    );
    return;
  }

  console.log(`Usage:
  truematch preferences --show
  truematch preferences --set '{"gender_preference":["woman"],"location":"London, UK","age_range":{"min":25,"max":40}}'

Fields:
  gender_preference   Array of strings, e.g. ["woman", "non-binary"]. Empty = no filter.
  location            Plain text, e.g. "London, UK". Agent interprets proximity.
  age_range           Object with optional min/max, e.g. {"min": 25, "max": 40}

Note: serious/casual relationship intent is NOT set here — Claude infers it from your behavior.`);
}

// ── match ─────────────────────────────────────────────────────────────────────

async function cmdMatch(): Promise<void> {
  const identity = await loadIdentity();

  // --reset --thread <id>
  if (args["reset"]) {
    const thread_id = args["thread"] as string | undefined;
    if (!thread_id) {
      console.error(
        "Specify thread to reset: truematch match --reset --thread <id>",
      );
      process.exit(1);
    }
    const state = await loadThread(thread_id);
    if (!state) {
      console.log(`Thread ${thread_id} not found.`);
      return;
    }
    state.status = "declined";
    await saveThread(state);
    console.log(`Thread ${thread_id} marked as declined.`);
    return;
  }

  // --messages --thread <id>
  if (args["messages"]) {
    const thread_id = args["thread"] as string | undefined;
    if (!thread_id) {
      console.error("Specify thread: truematch match --messages --thread <id>");
      process.exit(1);
    }
    const state = await loadThread(thread_id);
    if (!state) {
      console.log(`Thread ${thread_id} not found.`);
      return;
    }
    for (const msg of state.messages) {
      const prefix = msg.role === "us" ? "YOU" : "PEER";
      console.log(`\n[${prefix} — ${msg.timestamp}]\n${msg.content}`);
    }
    return;
  }

  // --status [--thread <id>]
  if (args["status"]) {
    const thread_id = args["thread"] as string | undefined;
    if (thread_id) {
      const state = await loadThread(thread_id);
      if (!state) {
        console.log(`Thread ${thread_id} not found.`);
      } else {
        console.log(
          JSON.stringify(
            {
              ...state,
              messages: `(${state.messages.length} messages — use --messages to view)`,
            },
            null,
            2,
          ),
        );
        if (state.status === "matched") {
          console.log("\nMATCH CONFIRMED.");
          console.log(
            "Headline:",
            state.match_narrative?.headline ?? "(pending)",
          );
        }
      }
    } else {
      const active = await listActiveThreads();
      if (active.length === 0) {
        console.log("No active negotiations.");
      } else {
        for (const t of active) {
          console.log(
            `Thread ${t.thread_id} — round ${t.round_count}/10 — ${t.status}`,
          );
        }
      }
    }
    return;
  }

  // --send '<msg>' --thread <id>
  if (args["send"]) {
    if (!identity) {
      console.error("Not set up. Run: truematch setup");
      process.exit(1);
    }
    const content = args["send"] as string;
    const thread_id = args["thread"] as string | undefined;
    if (!thread_id) {
      console.error(
        "Specify thread: truematch match --send '<msg>' --thread <id>",
      );
      process.exit(1);
    }
    await sendMessage(identity.nsec, thread_id, content, DEFAULT_RELAYS);
    console.log(`Message sent (thread ${thread_id.slice(0, 8)}...)`);
    return;
  }

  // --propose --thread <id> --write '<narrative-json>'
  if (args["propose"]) {
    if (!identity) {
      console.error("Not set up. Run: truematch setup");
      process.exit(1);
    }
    const thread_id = args["thread"] as string | undefined;
    if (!thread_id) {
      console.error(
        "Specify thread: truematch match --propose --thread <id> --write '<json>'",
      );
      process.exit(1);
    }
    const narrativeJson = args["write"] as string | undefined;
    if (!narrativeJson) {
      console.error(
        "Provide match narrative with --write '<json>'\n" +
          'Example: truematch match --propose --thread <id> --write \'{"headline":"...","strengths":[],"watch_points":[],"confidence_summary":"..."}\'',
      );
      process.exit(1);
    }
    let narrative: MatchNarrative;
    try {
      narrative = JSON.parse(narrativeJson) as MatchNarrative;
    } catch {
      console.error("Invalid narrative JSON.");
      process.exit(1);
    }
    const state = await proposeMatch(
      identity.nsec,
      thread_id,
      narrative,
      DEFAULT_RELAYS,
    );
    if (state.status === "matched") {
      console.log("MATCH CONFIRMED (double-lock cleared).");
      console.log("Headline:", state.match_narrative?.headline ?? "(pending)");
    } else {
      console.log(
        `Match proposal sent. Waiting for peer's proposal (thread ${thread_id.slice(0, 8)}...)`,
      );
    }
    return;
  }

  // --decline --thread <id>
  if (args["decline"]) {
    if (!identity) {
      console.error("Not set up. Run: truematch setup");
      process.exit(1);
    }
    const thread_id = args["thread"] as string | undefined;
    if (!thread_id) {
      console.error("Specify thread: truematch match --decline --thread <id>");
      process.exit(1);
    }
    await declineMatch(identity.nsec, thread_id, DEFAULT_RELAYS);
    console.log(`Negotiation ended (thread ${thread_id.slice(0, 8)}...)`);
    return;
  }

  // --start
  if (args["start"]) {
    if (!identity) {
      console.error("Not set up. Run: truematch setup");
      process.exit(1);
    }

    const obs = await loadObservation();
    if (!obs || !isEligible(obs)) {
      console.error(
        "Observation not yet eligible for matching. Run: truematch status",
      );
      process.exit(1);
    }

    if (isStale(obs)) {
      console.error(
        "Observation manifest is stale. Run: truematch observe --update\n" +
          "This ensures your latest context is used in matching.",
      );
      process.exit(1);
    }

    await expireStaleThreads(identity.nsec, identity.npub, DEFAULT_RELAYS);

    const agents = await listAgents();
    const candidates = agents.filter((a) => a.pubkey !== identity.npub);

    if (candidates.length === 0) {
      console.log("No other agents in the pool yet. Check back later.");
      return;
    }

    const peer = candidates[0];
    console.log(`Starting negotiation with ${peer.pubkey.slice(0, 12)}...`);

    // Create the thread — Claude writes and sends the opening via --send
    const state = await initiateNegotiation(peer.pubkey);

    console.log(`Thread created: ${state.thread_id}`);
    console.log(`\nNow write your opening message. Include:`);
    console.log(`  - Your user's core values (Schwartz labels + confidence)`);
    console.log(`  - Dealbreaker result: pass or fail`);
    console.log(`  - Life phase + confidence`);
    console.log(`  - One question for the peer\n`);
    console.log(`Send it with:`);
    console.log(
      `  truematch match --send '<your opening>' --thread ${state.thread_id}`,
    );
    console.log(`\nThen listen for their response:`);

    // Subscribe and process incoming messages
    const unsubscribe = await subscribeToMessages(
      identity.nsec,
      identity.npub,
      async (from, message) => {
        const updated = await receiveMessage(
          message.thread_id,
          from,
          message.content,
          message.type,
        );

        if (updated.status === "matched") {
          console.log("\nMATCH CONFIRMED.");
          console.log(
            "Headline:",
            updated.match_narrative?.headline ?? "(pending)",
          );
          unsubscribe();
          process.exit(0);
        }
        if (updated.status === "declined") {
          console.log("\nNegotiation ended (no match at this time).");
          unsubscribe();
          process.exit(0);
        }

        console.log(`\n[TrueMatch] Message from peer ${from.slice(0, 12)}:`);
        console.log(`Thread: ${message.thread_id}`);
        console.log(`Round: ${updated.round_count} / 10\n`);
        console.log(message.content);
        console.log(
          "\nRespond with: truematch match --send '<reply>' --thread " +
            message.thread_id,
        );
      },
    );

    process.on("SIGINT", () => {
      unsubscribe();
      process.exit(0);
    });

    return;
  }

  console.log(`Usage:
  truematch match --start                           Start a new negotiation
  truematch match --status [--thread <id>]          Show negotiation status
  truematch match --messages --thread <id>          Show conversation history
  truematch match --send '<msg>' --thread <id>      Send a message
  truematch match --propose --thread <id> --write '<narrative-json>'
  truematch match --decline --thread <id>           End the negotiation
  truematch match --reset --thread <id>             Force-reset thread state`);
}

// ── deregister ────────────────────────────────────────────────────────────────

async function cmdDeregister(): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) {
    console.error("No identity found. Nothing to deregister.");
    process.exit(1);
  }
  await deregister(identity);
  console.log(`Deregistered. pubkey: ${identity.npub}`);
  console.log(
    "Your local state (~/.truematch/) is preserved. Re-register anytime with: truematch setup",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
