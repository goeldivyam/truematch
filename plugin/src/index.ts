#!/usr/bin/env node
/**
 * TrueMatch sidecar CLI
 *
 * Usage:
 *   truematch setup [--contact-type email|discord|telegram|whatsapp|imessage] [--contact-value <val>]
 *   truematch heartbeat
 *   truematch status [--relays]
 *   truematch observe --show | --update | --write '<json>'
 *   truematch preferences --show | --set '<json>'
 *   truematch match --start | --status [--thread <id>] | --messages --thread <id>
 *                   | --receive '<content>' --thread <id> --peer <pubkey> [--type <type>]
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
  type ProximityOpts,
} from "./registry.js";
import {
  loadObservation,
  saveObservation,
  emptyObservation,
  eligibilityReport,
  isEligible,
  isMinimumViable,
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
import {
  writePendingNotificationIfMatched,
  advanceHandoff,
  listActiveHandoffs,
  loadHandoffState,
} from "./handoff.js";
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
    receive: { type: "string" },
    peer: { type: "string" },
    type: { type: "string" },
    propose: { type: "boolean" },
    decline: { type: "boolean" },
    messages: { type: "boolean" },
    round: { type: "string" },
    "match-id": { type: "string" },
    consent: { type: "string" },
    prompt: { type: "string" },
    response: { type: "string" },
    "opt-out": { type: "boolean" },
    exchange: { type: "boolean" },
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
    case "heartbeat":
      await cmdHeartbeat();
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
    case "handoff":
      await cmdHandoff();
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
  handoff      Advance post-match handoff rounds (1→2→3)
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

  if (
    !["email", "discord", "telegram", "whatsapp", "imessage"].includes(
      contactType,
    )
  ) {
    console.error(
      "Invalid --contact-type. Must be: email, discord, telegram, whatsapp, or imessage",
    );
    process.exit(1);
  }

  // Registry hosts a per-agent card from stored data — agents run locally and
  // cannot self-serve /.well-known/agent-card.json. Override with TRUEMATCH_CARD_URL
  // if you self-host your registry or want to serve your own card.
  const cardUrl =
    process.env["TRUEMATCH_CARD_URL"] ??
    `https://clawmatch.org/v1/agents/${identity.npub}/card`;

  const prefs = await loadPreferences();
  const reg = await register(
    identity,
    cardUrl,
    { type: contactType, value: contactValue },
    prefs.location,
    prefs.distance_radius_km,
  );

  console.log(`Registered with TrueMatch.
  pubkey:  ${reg.pubkey}
  contact: ${reg.contact_channel.type} / ${reg.contact_channel.value}${reg.location_label ? `\n  location: ${reg.location_label} (${reg.location_resolution})` : ""}

Next: run 'truematch observe --update' after a few conversations to build your personality model.`);
}

// ── heartbeat ─────────────────────────────────────────────────────────────────

// Re-registers with stored credentials to refresh lastSeen in the registry.
// Called by the auto-poll cron so the agent stays visible in the matching pool
// without the user having to run setup again.
async function cmdHeartbeat(): Promise<void> {
  const identity = await loadIdentity();
  if (!identity) {
    console.error("Not set up. Run: truematch setup");
    process.exit(1);
  }
  const reg = await loadRegistration();
  if (!reg) {
    console.error("Not registered. Run: truematch setup");
    process.exit(1);
  }
  const prefs = await loadPreferences();
  await register(
    identity,
    reg.card_url,
    reg.contact_channel,
    prefs.location,
    prefs.distance_radius_km,
  );
  console.log(`Heartbeat sent. pubkey: ${identity.npub.slice(0, 16)}...`);
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
    const eligible = isEligible(obs);
    const mve = isMinimumViable(obs);
    console.log(
      `\nPool eligible: ${eligible ? "YES (full)" : mve ? "YES (MVE — T1+T2 only)" : "NO"}`,
    );
    if (isStale(obs)) {
      console.log("⚠ Manifest is stale — run 'truematch observe --update'");
    }
  }

  const prefs = await loadPreferences();
  console.log(`\nPreferences: ${formatPreferences(prefs)}`);

  const active = await listActiveThreads();
  if (active.length > 0) {
    console.log(`\nActive negotiations: ${active.length}`);
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
    try {
      await saveObservation(obs);
    } catch (err) {
      console.error(
        `Failed to save observation — check JSON schema matches ObservationSummary.\n` +
          `Each dimension needs: { confidence, observation_count, behavioral_context_diversity }\n` +
          `Dimensions: attachment, core_values, communication, emotional_regulation, humor, life_velocity, dealbreakers, conflict_resolution, interdependence_model\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
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
        console.log(`Active negotiations: ${active.length}`);
        for (const t of active) {
          console.log(`  Thread ${t.thread_id.slice(0, 8)}... — ${t.status}`);
        }
      }
    }
    return;
  }

  // --receive '<content>' --thread <id> --peer <pubkey> [--type negotiation|match_propose|end]
  // Registers an inbound message and saves the thread state on the receiving side.
  // Use this when poll.js outputs a message that has no local thread yet.
  if (args["receive"] !== undefined) {
    if (!identity) {
      console.error("Not set up. Run: truematch setup");
      process.exit(1);
    }
    const content = args["receive"] as string;
    const thread_id = args["thread"] as string | undefined;
    const peerNpub = args["peer"] as string | undefined;
    if (!thread_id || !peerNpub) {
      console.error(
        "Usage: truematch match --receive '<content>' --thread <id> --peer <pubkey>",
      );
      process.exit(1);
    }
    const rawType = args["type"] as string | undefined;
    if (
      rawType !== undefined &&
      rawType !== "negotiation" &&
      rawType !== "match_propose" &&
      rawType !== "end"
    ) {
      console.error(
        `Invalid --type "${rawType}". Must be: negotiation, match_propose, or end`,
      );
      process.exit(1);
    }
    const msgType = rawType ?? "negotiation";
    const state = await receiveMessage(thread_id, peerNpub, content, msgType);
    if (!state) {
      console.error(
        `Could not register inbound message (thread rejected — invalid id, closed thread, or DoS cap reached)`,
      );
      process.exit(1);
    }
    console.log(
      `Message registered. Thread ${thread_id.slice(0, 8)}... — status: ${state.status}`,
    );
    if (state.status === "matched") {
      if (state.match_narrative) {
        try {
          writePendingNotificationIfMatched(
            state.thread_id,
            state.peer_pubkey,
            state.match_narrative,
          );
        } catch (err) {
          process.stderr.write(
            `Warning: notification write failed — match IS confirmed, but pending_notification.json was not written. ` +
              `Run 'truematch match --status --thread ${state.thread_id}' to view the match.\n` +
              `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      console.log("MATCH CONFIRMED.");
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
      if (state.match_narrative) {
        try {
          writePendingNotificationIfMatched(
            state.thread_id,
            state.peer_pubkey,
            state.match_narrative,
          );
        } catch (err) {
          process.stderr.write(
            `Warning: notification write failed — match IS confirmed, but pending_notification.json was not written. ` +
              `Run 'truematch match --status --thread ${state.thread_id}' to view the match.\n` +
              `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      console.log("MATCH CONFIRMED.");
      console.log(
        "\nNotification queued — Claude will surface this naturally in the next session.",
      );
    } else {
      console.log(`Match proposal sent. Waiting for peer's proposal.`);
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
    if (!obs || (!isEligible(obs) && !isMinimumViable(obs))) {
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

    await expireStaleThreads(identity.nsec, DEFAULT_RELAYS);

    // Build proximity filter from stored registration and preferences
    const prefs = await loadPreferences();
    const reg = await loadRegistration();
    let proximity: ProximityOpts | undefined;
    if (
      reg?.location_lat != null &&
      reg?.location_lng != null &&
      prefs.distance_radius_km != null
    ) {
      proximity = {
        lat: reg.location_lat,
        lng: reg.location_lng,
        radiusKm: prefs.distance_radius_km,
      };
    }

    const agents = await listAgents(proximity);
    // Location/distance filtered server-side. Age range and gender preference
    // are private (never in the registry) — Claude enforces them before
    // sending match_propose (see skill.md Step 4.5).
    const activeThreads = await listActiveThreads();
    const activePeers = new Set(activeThreads.map((t) => t.peer_pubkey));

    // Only consider agents seen within the last 2 hours — prevents matching
    // against ghost entries whose private keys no longer exist.
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const candidates = agents.filter(
      (a) =>
        a.pubkey !== identity.npub &&
        !activePeers.has(a.pubkey) &&
        new Date(a.lastSeen).getTime() > twoHoursAgo,
    );

    if (candidates.length === 0) {
      const othersInPool = agents.filter((a) => a.pubkey !== identity.npub);
      if (othersInPool.length === 0) {
        console.log("No other agents in the pool yet. Check back later.");
      } else {
        const recentOthers = othersInPool.filter(
          (a) => new Date(a.lastSeen).getTime() > twoHoursAgo,
        );
        if (recentOthers.length === 0) {
          console.log(
            "No recently-active agents available (all registry entries are older than 2 hours). Check back later.",
          );
        } else {
          console.log(
            "Already negotiating with all available agents. Check back later.",
          );
        }
      }
      return;
    }

    // Random selection — distributes load and avoids always negotiating with the same peer
    const peer = candidates[Math.floor(Math.random() * candidates.length)]!;

    // Create the thread — Claude writes and sends the opening via --send
    const state = await initiateNegotiation(peer.pubkey);

    console.log(`Negotiation thread ready.`);
    console.log(`\nNow write your opening message. Include:`);
    console.log(`  - Your user's core values (Schwartz labels + confidence)`);
    console.log(`  - Dealbreaker result: pass or fail`);
    console.log(`  - Life phase + confidence`);
    if (
      obs.inferred_intent_category &&
      obs.inferred_intent_category !== "unclear"
    ) {
      console.log(
        `  - Inferred relationship intent: ${obs.inferred_intent_category}` +
          ` (disclose this; terminate immediately if peer discloses a categorically incompatible intent)`,
      );
    }
    console.log(`  - One question for the peer\n`);
    console.log(`Send it with:`);
    console.log(
      `  truematch match --send '<your opening>' --thread ${state.thread_id}`,
    );
    console.log(`\nThen listen for their response:`);

    // Register SIGINT handler before the async subscription so it is never missed
    let unsubscribe: () => void = () => {};
    process.on("SIGINT", () => {
      unsubscribe();
      process.exit(0);
    });

    // Subscribe and process incoming messages
    unsubscribe = await subscribeToMessages(
      identity.nsec,
      identity.npub,
      async (from, message) => {
        const updated = await receiveMessage(
          message.thread_id,
          from,
          message.content,
          message.type,
        );
        if (!updated) return; // rejected (e.g. invalid thread_id)

        if (updated.status === "matched") {
          if (updated.match_narrative) {
            try {
              writePendingNotificationIfMatched(
                updated.thread_id,
                updated.peer_pubkey,
                updated.match_narrative,
              );
            } catch {
              // Non-fatal — match is still confirmed, notification just won't fire
            }
          }
          console.log("\nMATCH CONFIRMED.");
          console.log(
            "Headline:",
            updated.match_narrative?.headline ?? "(pending)",
          );
          console.log(
            "Notification queued — Claude will surface this naturally in the next session.",
          );
          unsubscribe();
          process.exit(0);
        }
        if (updated.status === "declined") {
          console.log("\nNegotiation ended (no match at this time).");
          unsubscribe();
          process.exit(0);
        }

        console.log(`\n[TrueMatch] Incoming message:`);
        console.log(message.content);
        console.log(
          "\nRespond with: truematch match --send '<reply>' --thread " +
            message.thread_id,
        );
      },
    );

    return;
  }

  console.log(`Usage:
  truematch match --start                                         Start a new negotiation
  truematch match --status [--thread <id>]                       Show negotiation status
  truematch match --messages --thread <id>                       Show conversation history
  truematch match --receive '<content>' --thread <id> --peer <pubkey>
                                                                  Register an inbound message (from poll.js output)
  truematch match --send '<msg>' --thread <id>                   Send a message
  truematch match --propose --thread <id> --write '<narrative-json>'
  truematch match --decline --thread <id>                        End the negotiation
  truematch match --reset --thread <id>                          Force-reset thread state`);
}

// ── handoff ───────────────────────────────────────────────────────────────────

async function cmdHandoff(): Promise<void> {
  const matchId = args["match-id"] as string | undefined;

  // --status (no match-id): list all active handoffs
  if (!matchId && args["status"]) {
    const active = listActiveHandoffs();
    if (active.length === 0) {
      console.log("No active handoffs.");
    } else {
      for (const h of active) {
        console.log(
          `${h.match_id.slice(0, 8)}... — round ${h.current_round}/3 — ${h.status}`,
        );
      }
    }
    return;
  }

  if (!matchId) {
    console.log(`Usage:
  truematch handoff --status                                    List active handoffs
  truematch handoff --round 1 --match-id <id> --consent "<response>"
  truematch handoff --round 2 --match-id <id> --prompt "<icebreaker>"
  truematch handoff --round 2 --match-id <id> --response "<user response>"
  truematch handoff --round 2 --match-id <id> --opt-out
  truematch handoff --round 3 --match-id <id> --exchange`);
    return;
  }

  const roundArg = args["round"] as string | undefined;
  if (!roundArg) {
    // Show handoff state for a specific match
    const state = loadHandoffState(matchId);
    if (!state) {
      console.log(`Handoff ${matchId} not found.`);
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    return;
  }

  const round = parseInt(roundArg, 10) as 1 | 2 | 3;
  if (![1, 2, 3].includes(round)) {
    console.error("--round must be 1, 2, or 3");
    process.exit(1);
  }

  const result = advanceHandoff(matchId, round, {
    consent: args["consent"] as string | undefined,
    prompt: args["prompt"] as string | undefined,
    response: args["response"] as string | undefined,
    optOut: args["opt-out"] as boolean | undefined,
    exchange: args["exchange"] as boolean | undefined,
  });
  console.log(result);
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
