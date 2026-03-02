#!/usr/bin/env node
/**
 * TrueMatch sidecar CLI
 *
 * Usage:
 *   truematch setup [--contact-type email|discord|telegram] [--contact-value <val>]
 *   truematch status [--relays]
 *   truematch observe --show | --update | --write '<json>'
 *   truematch match --start | --status | --reset
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
} from "./observation.js";
import {
  loadNegotiationState,
  resetNegotiation,
  initiateNegotiation,
  handleIncomingMessage,
} from "./negotiation.js";
import {
  checkRelayConnectivity,
  subscribeToMessages,
  DEFAULT_RELAYS,
} from "./nostr.js";
import type { ContactType, ObservationSummary } from "./types.js";

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "contact-type": { type: "string" },
    "contact-value": { type: "string" },
    show: { type: "boolean" },
    update: { type: "boolean" },
    write: { type: "string" },
    relays: { type: "boolean" },
    start: { type: "boolean" },
    status: { type: "boolean" },
    reset: { type: "boolean" },
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
    case "match":
      await cmdMatch();
      break;
    case "deregister":
      await cmdDeregister();
      break;
    default:
      console.log(`TrueMatch CLI — https://clawmatch.org

Commands:
  setup       Generate identity and register with TrueMatch
  status      Show registration and observation status
  observe     View or update the ObservationSummary
  match       Start or check matching negotiations
  deregister  Remove from the matching pool

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

  // The agent card URL — defaults to a localhost placeholder; users with a public
  // endpoint should override by setting TRUEMATCH_CARD_URL in their environment.
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
  }

  const neg = await loadNegotiationState();
  if (neg) {
    console.log(
      `\nActive negotiation: ${neg.status} (stage ${neg.stage}) with ${neg.peer_pubkey.slice(0, 12)}...`,
    );
    if (neg.status === "matched") {
      console.log(
        "MATCH CONFIRMED. Run 'truematch match --status' for details.",
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
    // Output current state for Claude to review and update
    console.log("CURRENT_OBSERVATION:");
    console.log(JSON.stringify(existing, null, 2));
    console.log("\nREVIEW_INSTRUCTIONS:");
    console.log(
      "Based on your observations of this user across real conversations, " +
        "update the ObservationSummary above. Focus on what you have actually " +
        "observed — not what the user has told you about themselves.\n" +
        "When done, write the updated JSON using:\n" +
        "  truematch observe --write '<updated-json>'",
    );
    return;
  }

  console.log("Usage: truematch observe --show | --update | --write '<json>'");
}

// ── match ─────────────────────────────────────────────────────────────────────

async function cmdMatch(): Promise<void> {
  if (args["reset"]) {
    await resetNegotiation();
    console.log("Negotiation state reset.");
    return;
  }

  if (args["status"]) {
    const state = await loadNegotiationState();
    if (!state) {
      console.log("No active negotiation.");
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    return;
  }

  if (args["start"]) {
    const identity = await loadIdentity();
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

    const existing = await loadNegotiationState();
    if (existing?.status === "in_progress") {
      console.log(
        "Negotiation already in progress. Run: truematch match --status",
      );
      return;
    }

    if (existing?.status === "matched") {
      console.log("Match already confirmed. Run: truematch match --status");
      return;
    }

    // Find a peer to negotiate with
    const agents = await listAgents();
    const candidates = agents.filter((a) => a.pubkey !== identity.npub);

    if (candidates.length === 0) {
      console.log("No other agents in the pool yet. Check back later.");
      return;
    }

    // Pick the first candidate (in production, use NIP-90 competitive discovery)
    const peer = candidates[0];
    console.log(`Starting negotiation with ${peer.pubkey.slice(0, 12)}...`);

    const state = await initiateNegotiation(
      identity.nsec,
      identity.npub,
      peer.pubkey,
      obs,
      DEFAULT_RELAYS,
    );

    console.log(`Negotiation started. Thread: ${state.thread_id}`);
    console.log("Listening for response (Ctrl+C to stop)...\n");

    // Subscribe and process incoming messages
    const unsubscribe = await subscribeToMessages(
      identity.nsec,
      identity.npub,
      async (from, message) => {
        const updated = await handleIncomingMessage(
          identity.nsec,
          identity.npub,
          from,
          message,
          obs,
          DEFAULT_RELAYS,
        );
        if (updated?.status === "matched") {
          console.log("\nMATCH CONFIRMED.");
          console.log(
            "Headline:",
            updated.match_narrative?.headline ?? "(pending)",
          );
          unsubscribe();
          process.exit(0);
        }
        if (updated?.status === "declined") {
          console.log("\nNegotiation ended (no match at this time).");
          unsubscribe();
          process.exit(0);
        }
      },
    );

    // Keep alive until match or user interrupts
    process.on("SIGINT", () => {
      unsubscribe();
      process.exit(0);
    });

    return;
  }

  console.log("Usage: truematch match --start | --status | --reset");
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
