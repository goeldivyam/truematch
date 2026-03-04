import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getTrueMatchDir } from "./identity.js";
import {
  loadSignals,
  saveSignals,
  pickPendingSignal,
  buildSignalInstruction,
  recordSignalDelivered,
} from "./signals.js";
import {
  loadPendingNotification,
  deletePendingNotification,
  buildMatchNotificationContext,
  getActiveHandoffContext,
} from "./handoff.js";
import { emptyObservation, eligibilityReport } from "./observation.js";
import {
  loadPreferences,
  savePreferences,
  formatPreferences,
} from "./preferences.js";
import type { ObservationSummary } from "./types.js";

/**
 * OpenClaw plugin entry point.
 *
 * Exports the plugin object consumed by the OpenClaw runtime.
 * The `register(api)` function wires up lifecycle hooks and tools.
 *
 * Hooks registered:
 *   gateway_start        — detects first-run and missing preferences at boot
 *   session_start        — resets per-session delivery flags
 *   before_prompt_build  — injects match notification, handoff context, observation signal
 *   command:new          — on /new: runs setup, preferences, or observation update
 *
 * Tools registered:
 *   truematch_update_prefs — handles /truematch-prefs slash command (non-observational)
 */

function loadObservation(): ObservationSummary | null {
  const observationFile = join(getTrueMatchDir(), "observation.json");
  if (!existsSync(observationFile)) return null;
  try {
    return JSON.parse(
      readFileSync(observationFile, "utf8"),
    ) as ObservationSummary;
  } catch {
    return null;
  }
}

interface PluginEvent {
  type: string;
  action: string;
  messages: string[];
  sessionKey?: string;
}

interface PluginHookBeforePromptBuildResult {
  prependContext?: string;
  systemPrompt?: string;
}

interface PluginAPI {
  // Typed hook registration (supports return values collected by OpenClaw runtime)
  on(
    event: "before_prompt_build",
    handler: (
      event: PluginEvent,
    ) =>
      | PluginHookBeforePromptBuildResult
      | void
      | Promise<PluginHookBeforePromptBuildResult | void>,
  ): void;
  on(
    event: "session_start" | "session_end" | "gateway_start" | "gateway_stop",
    handler: (event: PluginEvent) => void | Promise<void>,
  ): void;
  // Generic string hook registration (return values are discarded)
  registerHook(
    event: string,
    handler: (event: PluginEvent) => void,
    meta?: { name?: string; description?: string },
  ): void;
  // Tool registration — execute is called when command-dispatch: tool fires
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      params: { command?: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void;
}

// Per-session delivery flags — keyed by sessionKey to avoid races when the gateway
// multiplexes multiple sessions (e.g. interactive + autonomous cron) concurrently.
// Reset on session_start; prevent re-injection within the same session.
interface SessionFlags {
  signalDelivered: boolean;
  notificationDelivered: boolean;
}
const sessionFlagsMap = new Map<string, SessionFlags>();
function getSessionFlags(sessionKey: string): SessionFlags {
  let flags = sessionFlagsMap.get(sessionKey);
  if (!flags) {
    flags = { signalDelivered: false, notificationDelivered: false };
    sessionFlagsMap.set(sessionKey, flags);
  }
  return flags;
}

// Module-scoped flags set at gateway_start, consumed at first command:new.
// Resets on every gateway restart (correct — sentinel file prevents repeat prompts).
const pluginState = {
  needsSetup: false,
  needsPreferences: false,
};

/**
 * Parse simple key=value pairs from raw slash-command args.
 * Supports quoted values: location="New York, NY"
 * Named parseSlashArgs to avoid shadowing node:util parseArgs.
 */
function parseSlashArgs(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    result[m[1] as string] = (m[2] ?? m[3]) as string;
  }
  return result;
}

/**
 * Tool handler for /truematch-prefs slash command.
 *
 * The model is architecturally excluded from this turn (command-dispatch: tool).
 * No behavioral observation can occur — the boundary is structural, not in-context.
 *
 * Usage:
 *   /truematch-prefs                          — show current preferences
 *   /truematch-prefs location="London, UK"    — update location (anywhere = no distance filter)
 *   /truematch-prefs distance=city            — within ~50 km (city | travel | anywhere)
 *   /truematch-prefs age_min=25 age_max=35    — age range (omit either for open-ended)
 *   /truematch-prefs gender=anyone            — any; or comma-separated: man,woman,nonbinary
 */
async function handleUpdatePrefs(rawArgs: string): Promise<string> {
  const prefs = await loadPreferences();
  const trimmed = rawArgs.trim();

  if (!trimmed) {
    return (
      `Preferences mode. I won't read anything you say here as personality signal — ` +
      `this is purely logistics.\n\n` +
      `Current preferences: ${formatPreferences(prefs)}\n\n` +
      `Update with: /truematch-prefs <field>=<value>\n` +
      `  location="City, Country"    where you're based\n` +
      `  distance=city               city (~50 km) | travel (~300 km) | anywhere\n` +
      `  age_min=25 age_max=35       age range (either is optional)\n` +
      `  gender=anyone               or: man,woman,nonbinary (comma-separated)`
    );
  }

  const args = parseSlashArgs(trimmed);
  let changed = false;

  if (args["location"] !== undefined) {
    prefs.location = args["location"];
    changed = true;
  }

  if (args["distance"] !== undefined) {
    const d = args["distance"].toLowerCase();
    if (d === "city") {
      prefs.distance_radius_km = 50;
    } else if (d === "travel") {
      prefs.distance_radius_km = 300;
    } else if (d === "anywhere") {
      delete prefs.distance_radius_km;
    } else {
      return `Unknown distance value "${args["distance"]}". Use: city, travel, or anywhere.`;
    }
    changed = true;
  }

  if (args["age_min"] !== undefined || args["age_max"] !== undefined) {
    const current = prefs.age_range ?? {};
    if (args["age_min"] !== undefined) {
      const n = parseInt(args["age_min"], 10);
      if (isNaN(n)) return `Invalid age_min value: "${args["age_min"]}"`;
      current.min = n;
    }
    if (args["age_max"] !== undefined) {
      const n = parseInt(args["age_max"], 10);
      if (isNaN(n)) return `Invalid age_max value: "${args["age_max"]}"`;
      current.max = n;
    }
    prefs.age_range = current;
    changed = true;
  }

  if (args["gender"] !== undefined) {
    const g = args["gender"].toLowerCase();
    prefs.gender_preference =
      g === "anyone" || g === "any" || g === ""
        ? []
        : g
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    changed = true;
  }

  if (!changed) {
    return `No recognized fields in args. Use: location, distance, age_min, age_max, gender.`;
  }

  await savePreferences(prefs);

  return (
    `Updated. I'm going back to regular conversation now — anything here is observations again.\n\n` +
    `Current preferences: ${formatPreferences(prefs)}`
  );
}

export default {
  id: "truematch-plugin",
  name: "TrueMatch",
  description:
    "AI agent dating network — matched on who you actually are, not who you think you are",
  version: "0.1.22",
  kind: "lifecycle",

  register(api: PluginAPI): void {
    // ── Tool: /truematch-prefs ─────────────────────────────────────────────────
    // Registered with command-dispatch: tool in skills/truematch-prefs/SKILL.md.
    // The model is architecturally excluded from this turn — no observation possible.
    api.registerTool({
      name: "truematch_update_prefs",
      description:
        "Update TrueMatch logistics preferences (location, distance, age range, gender). " +
        "The model is excluded from this turn — no behavioral observation occurs.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Raw slash-command args, e.g. 'location=\"London, UK\" distance=city age_min=25'",
          },
        },
        required: [],
      },
      execute: async (_id, params) => {
        const text = await handleUpdatePrefs(params.command ?? "");
        return { content: [{ type: "text" as const, text }] };
      },
    });

    // ── Hook: gateway_start ────────────────────────────────────────────────────
    // Fires once per gateway process, after channels and hooks load.
    // Use it to detect setup state so command:new can prompt appropriately.
    api.on("gateway_start", (_event) => {
      const identityFile = join(getTrueMatchDir(), "identity.json");
      const preferencesFile = join(getTrueMatchDir(), "preferences.json");
      if (!existsSync(identityFile)) {
        pluginState.needsSetup = true;
      } else if (!existsSync(preferencesFile)) {
        pluginState.needsPreferences = true;
      }

      // Register the TrueMatch background cron job if not already present.
      // Writes directly to jobs.json — the documented approach for plugin-side
      // cron registration (no api.registerCron() exists in the PluginAPI).
      // Deferred to avoid a jobs.json write race during gateway startup.
      // Delay is configurable via TRUEMATCH_CRON_REGISTER_DELAY_MS. Defaults to 2s.
      const cronDelay = parseInt(
        process.env["TRUEMATCH_CRON_REGISTER_DELAY_MS"] ?? "2000",
        10,
      );
      setTimeout(() => {
        try {
          const openclawStateDir =
            process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
          const cronJobsFile = join(openclawStateDir, "cron", "jobs.json");

          // Read existing jobs — CronStoreFile format: { version: 1, jobs: [...] }
          type CronJob = {
            id?: string;
            name?: string;
            [key: string]: unknown;
          };
          type CronStore = { version?: number; jobs: CronJob[] };
          const raw = existsSync(cronJobsFile)
            ? (JSON.parse(readFileSync(cronJobsFile, "utf8")) as
                | CronStore
                | CronJob[])
            : { version: 1, jobs: [] };
          const store: CronStore = Array.isArray(raw)
            ? { version: 1, jobs: raw }
            : raw;

          const alreadyRegistered = store.jobs.some(
            (j) => j.name === "truematch-heartbeat",
          );

          if (!alreadyRegistered) {
            const FIFTEEN_MINUTES_MS = 15 * 60 * 1000; // 900000
            const now = Date.now();
            store.jobs.push({
              id: randomUUID(),
              name: "truematch-heartbeat",
              enabled: true,
              createdAtMs: now,
              updatedAtMs: now,
              // "every" kind with everyMs — fixed interval schedule.
              // Isolated sessions auto-announce to the user's primary channel.
              schedule: { kind: "every", everyMs: FIFTEEN_MINUTES_MS },
              sessionTarget: "isolated",
              // Disable announce delivery — the before_prompt_build hook injects
              // match notifications naturally on the next user conversation.
              // Announce mode without a channel configured fails silently.
              delivery: { mode: "none" },
              // "next-heartbeat": fires on the next scheduled gateway heartbeat
              // tick rather than immediately, avoiding burst load on startup.
              wakeMode: "next-heartbeat",
              payload: {
                kind: "agentTurn",
                message:
                  "Run the TrueMatch background routine: " +
                  "(1) truematch observe --show — load your current observation of this user. " +
                  "(2) truematch heartbeat — keep registration fresh. " +
                  '(3) node "$(npm root -g)/truematch-plugin/dist/poll.js" — ' +
                  "for each JSONL line received, register it with truematch match --receive, then process per the negotiation protocol. " +
                  "(4) truematch match --status — check all active threads. " +
                  "(5) If there are no active negotiation threads AND truematch status shows matching_eligible=true, " +
                  "run truematch match --start to find a new candidate. " +
                  "Only surface a confirmed match — do not send a message if there is nothing to report.",
              },
            });
            writeFileSync(cronJobsFile, JSON.stringify(store, null, 2));
          }
        } catch {
          // Non-fatal — silently skip on any file I/O or JSON errors
        }
      }, cronDelay);
    });

    // ── Hook: session_start ───────────────────────────────────────────────────
    // Reset per-session delivery flags so signals and notifications fire at most
    // once per session even though before_prompt_build fires on every LLM invocation.
    api.on("session_start", (event) => {
      const key = event.sessionKey ?? "default";
      sessionFlagsMap.set(key, {
        signalDelivered: false,
        notificationDelivered: false,
      });
    });

    // ── Hook: before_prompt_build ─────────────────────────────────────────────
    // Fires on every LLM invocation. Returns prependContext injected into Claude's
    // context before the model sees the conversation.
    //
    // NOTE: api.registerHook return values are silently discarded by the OpenClaw
    // runtime (InternalHookHandler is typed as void). api.on("before_prompt_build")
    // is the ONLY correct API for prependContext injection — its return value is
    // collected and merged by runBeforePromptBuild in src/plugins/hooks.ts.
    //
    // Priority order (highest first):
    //   1. Match notification — deliver once per session when a new match is confirmed
    //   2. Handoff round context — frame Claude's role in the active handoff round
    //   3. Observation signal — surface a growing dimension confidence naturally
    api.on(
      "before_prompt_build",
      (event: PluginEvent): PluginHookBeforePromptBuildResult | void => {
        const key = event.sessionKey ?? "default";
        const sessionFlags = getSessionFlags(key);
        const parts: string[] = [];

        // 1. Match notification (once per session)
        if (!sessionFlags.notificationDelivered) {
          const notification = loadPendingNotification();
          if (notification) {
            // Mark delivered BEFORE injecting — prevents re-fire if session crashes
            deletePendingNotification();
            sessionFlags.notificationDelivered = true;
            parts.push(buildMatchNotificationContext(notification));
          }
        }

        // 2. Handoff round context
        const handoffCtx = getActiveHandoffContext();
        if (handoffCtx) parts.push(handoffCtx);

        // 3. Observation signal (once per session — ≥2 sessions, ≥0.15 delta, ≥5 day quiet)
        if (!sessionFlags.signalDelivered) {
          const obs = loadObservation();
          if (obs) {
            const signals = loadSignals();
            const pending = pickPendingSignal(obs, signals);
            if (pending) {
              const updated = recordSignalDelivered(
                signals,
                pending.dimension,
                pending.confidence,
              );
              saveSignals(updated);
              sessionFlags.signalDelivered = true;
              parts.push(
                buildSignalInstruction(pending.dimension, pending.confidence),
              );
            }
          }
        }

        if (parts.length === 0) return;
        return { prependContext: parts.join("\n\n---\n\n") };
      },
    );

    // ── Hook: command:new ──────────────────────────────────────────────────────
    // Fires on every /new invocation.
    // Branches: first-time setup → preferences collection → normal observation update.
    // No seed/bootstrapping questions — TrueMatch observes only. If confidence is low,
    // Claude communicates this to the user naturally via the observation output.
    api.registerHook(
      "command:new",
      (event) => {
        if (pluginState.needsSetup) {
          pluginState.needsSetup = false;
          event.messages.push(
            `[TrueMatch] First-time setup — greet the user with the following, then collect responses:\n\n` +
              `"Welcome to TrueMatch. I'm going to learn who you are through our conversations ` +
              `over time — you do not need to fill out a profile. Right now I just need three ` +
              `quick logistics so I know who to consider. Where are you based?"\n\n` +
              `Ask in this order — one question at a time, wait for each answer before continuing. ` +
              `Collect all five in this session (do not drip across sessions):\n` +
              `1. Location — ask: "Where are you based?"\n` +
              `2. Distance — ask: "How far are you open to meeting someone — within your city, ` +
              `within a few hours' travel, or anywhere?" Map to: 50 / 300 / null.\n` +
              `3. Age range — ask: "Any age range you'd prefer? You can give a rough bracket, ` +
              `a one-sided floor or ceiling, or just say no preference — all fine." Both min/max optional.\n` +
              `4. Gender preference — ask: "Who are you looking to meet? You can be specific, ` +
              `give multiple options, or say everyone — whatever's true for you." Record open/everyone as [].\n` +
              `5. Contact — ask: "If we find someone, I'll handle the introduction first — ` +
              `you both decide whether to exchange contact details before anything goes directly between you. ` +
              `For that moment, what contact info would you want them to have? ` +
              `(Email, WhatsApp, Telegram, iMessage, Discord, or anything else that works for you.)"\n\n` +
              `Do NOT push back on open/no-preference answers. Do NOT re-ask.\n\n` +
              `Collect both the contact type and the value before running setup.\n\n` +
              `Run setup:\n` +
              `  node "$HOME/.truematch/truematch.js" setup --contact-type <type> --contact-value <value>\n` +
              `Save preferences:\n` +
              `  node "$HOME/.truematch/truematch.js" preferences --set '<json>'`,
          );
          return;
        }

        if (pluginState.needsPreferences) {
          pluginState.needsPreferences = false;
          event.messages.push(
            `[TrueMatch] Preferences not yet set. Ask one question at a time, wait for each answer:\n` +
              `1. "Where are you based?"\n` +
              `2. "How far are you open to meeting someone — within your city, within a few hours' travel, or anywhere?"\n` +
              `3. "Any age range you'd prefer? You can give a rough bracket, a one-sided floor or ceiling, or just say no preference — all fine."\n` +
              `4. "Who are you looking to meet? You can be specific, give multiple options, or say everyone — whatever's true for you."\n\n` +
              `Accept open/no-preference answers without pushback, then save:\n` +
              `  node "$HOME/.truematch/truematch.js" preferences --set '<json>'\n\n` +
              `If user tries to update preferences in main conversation later, redirect them:\n` +
              `"I don't update preferences here because this is my observation channel. ` +
              `Say /truematch-prefs and we can do it there."`,
          );
          return;
        }

        // Load the current observation summary directly from disk.
        // No subprocess needed — the plugin runs in-process with the CLI.
        const obs = loadObservation() ?? emptyObservation();
        const report = eligibilityReport(obs);
        const output =
          `CURRENT OBSERVATION:\n${JSON.stringify(obs, null, 2)}\n\n` +
          `ELIGIBILITY REPORT:\n${report}`;

        // Whether the agent has any real signal to reason from (non-zero confidence on
        // any dimension). conversation_count is NOT used here — it only increments after
        // install, so a long-time Claude user whose first session produced high scores
        // would still show conversation_count: 0.
        const hasSignal = [
          obs.attachment,
          obs.core_values,
          obs.communication,
          obs.emotional_regulation,
          obs.humor,
          obs.life_velocity,
          obs.dealbreakers,
          obs.conflict_resolution,
          obs.interdependence_model,
        ].some((d) => d.confidence > 0);

        const ineligibleMessage = hasSignal
          ? `If matching_eligible is false, tell the user naturally — e.g. "I know you well ` +
            `enough to say something real about you, but not quite everything I'd want before ` +
            `putting you in front of someone. If you want to start now, just ask — I can reason ` +
            `through what I'm less sure of from what I already know."`
          : `If matching_eligible is false, tell the user naturally — e.g. "I'm still ` +
            `building a picture of you from our conversations. I'll let you know when ` +
            `there's enough to start matching."`;

        event.messages.push(
          `[TrueMatch] Session ended. Review the observation summary below and update it ` +
            `based on what you learned this session. Save with ` +
            `\`truematch observe --write '<json>'\`.\n\n` +
            ineligibleMessage +
            `\nDo NOT ask questions to accelerate this.\n\n` +
            output,
        );
      },
      {
        name: "TrueMatch session hook",
        description:
          "Runs setup on first use, collects preferences if missing, or updates observation summary",
      },
    );
  },
};
