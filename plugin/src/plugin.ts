import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
import type { ObservationSummary } from "./types.js";

const TRUEMATCH_DIR = join(homedir(), ".truematch");
const IDENTITY_FILE = join(TRUEMATCH_DIR, "identity.json");
const PREFERENCES_FILE = join(TRUEMATCH_DIR, "preferences.json");
const OBSERVATION_FILE = join(TRUEMATCH_DIR, "observation.json");

/**
 * OpenClaw plugin entry point.
 *
 * Exports the plugin object consumed by the OpenClaw runtime.
 * The `register(api)` function wires up lifecycle hooks and tools.
 *
 * Hooks registered:
 *   gateway:startup      — detects first-run and missing preferences at boot
 *   session_start        — resets per-session delivery flags
 *   before_prompt_build  — injects match notification, handoff context, observation signal
 *   command:new          — on /new: runs setup, preferences, or observation update
 *
 * Tools registered:
 *   truematch_update_prefs — handles /truematch-prefs slash command (non-observational)
 */

function loadObservation(): ObservationSummary | null {
  if (!existsSync(OBSERVATION_FILE)) return null;
  try {
    return JSON.parse(
      readFileSync(OBSERVATION_FILE, "utf8"),
    ) as ObservationSummary;
  } catch {
    return null;
  }
}

interface PluginEvent {
  type: string;
  action: string;
  messages: string[];
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
    event: "session_start" | "session_end",
    handler: (event: PluginEvent) => void | Promise<void>,
  ): void;
  // Generic string hook registration (return values are discarded)
  registerHook(
    event: string,
    handler: (event: PluginEvent) => void,
    meta?: { name?: string; description?: string },
  ): void;
  registerTool(tool: {
    name: string;
    description: string;
    handler: (rawArgs: string) => string;
  }): void;
}

// Per-session delivery flags — reset on session_start, prevent re-injection within a session.
// Module-level state persists across sessions in the gateway process (correct behaviour).
const sessionFlags = {
  signalDelivered: false,
  notificationDelivered: false,
};

// Module-scoped flags set at gateway:startup, consumed at first command:new.
// Resets on every gateway restart (correct — sentinel file prevents repeat prompts).
const pluginState = {
  needsSetup: false,
  needsPreferences: false,
};

interface StoredPreferences {
  gender_preference?: string[];
  location?: string;
  distance_radius_km?: number;
  age_range?: { min?: number; max?: number };
}

function loadPrefs(): StoredPreferences {
  if (!existsSync(PREFERENCES_FILE)) return {};
  try {
    return JSON.parse(
      readFileSync(PREFERENCES_FILE, "utf8"),
    ) as StoredPreferences;
  } catch {
    return {};
  }
}

function savePrefs(prefs: StoredPreferences): void {
  writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2), "utf8");
}

function formatPrefs(prefs: StoredPreferences): string {
  const parts: string[] = [];
  if (prefs.location) {
    const radius =
      prefs.distance_radius_km !== undefined
        ? ` (within ${prefs.distance_radius_km} km)`
        : " (anywhere)";
    parts.push(`location: ${prefs.location}${radius}`);
  }
  if (prefs.age_range) {
    const { min, max } = prefs.age_range;
    if (min !== undefined && max !== undefined)
      parts.push(`age: ${min}–${max}`);
    else if (min !== undefined) parts.push(`age: ${min}+`);
    else if (max !== undefined) parts.push(`age: up to ${max}`);
  }
  if (prefs.gender_preference?.length) {
    parts.push(`gender: ${prefs.gender_preference.join(" or ")}`);
  }
  return parts.length ? parts.join(", ") : "none set";
}

/**
 * Parse simple key=value pairs from raw slash-command args.
 * Supports quoted values: location="New York, NY"
 */
function parseArgs(raw: string): Record<string, string> {
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
function handleUpdatePrefs(rawArgs: string): string {
  const prefs = loadPrefs();
  const trimmed = rawArgs.trim();

  if (!trimmed) {
    return (
      `Preferences mode. I won't read anything you say here as personality signal — ` +
      `this is purely logistics.\n\n` +
      `Current preferences: ${formatPrefs(prefs)}\n\n` +
      `Update with: /truematch-prefs <field>=<value>\n` +
      `  location="City, Country"    where you're based\n` +
      `  distance=city               city (~50 km) | travel (~300 km) | anywhere\n` +
      `  age_min=25 age_max=35       age range (either is optional)\n` +
      `  gender=anyone               or: man,woman,nonbinary (comma-separated)`
    );
  }

  const args = parseArgs(trimmed);
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

  savePrefs(prefs);

  return (
    `Updated. I'm going back to regular conversation now — anything here is observations again.\n\n` +
    `Current preferences: ${formatPrefs(prefs)}`
  );
}

export default {
  id: "truematch",
  name: "TrueMatch",
  description:
    "AI agent dating network — matched on who you actually are, not who you think you are",
  version: "0.1.0",
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
      handler: handleUpdatePrefs,
    });

    // ── Hook: gateway:startup ──────────────────────────────────────────────────
    // Fires once per gateway process, after channels and hooks load.
    // Use it to detect setup state so command:new can prompt appropriately.
    api.registerHook(
      "gateway:startup",
      () => {
        if (!existsSync(IDENTITY_FILE)) {
          pluginState.needsSetup = true;
        } else if (!existsSync(PREFERENCES_FILE)) {
          pluginState.needsPreferences = true;
        }
      },
      {
        name: "TrueMatch startup check",
        description:
          "Detects whether TrueMatch setup and preferences are configured",
      },
    );

    // ── Hook: session_start ───────────────────────────────────────────────────
    // Reset per-session delivery flags so signals and notifications fire at most
    // once per session even though before_prompt_build fires on every LLM invocation.
    api.on("session_start", () => {
      sessionFlags.signalDelivered = false;
      sessionFlags.notificationDelivered = false;
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
      (): PluginHookBeforePromptBuildResult | void => {
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
              `Ask in this order (all in one exchange — do not drip across sessions):\n` +
              `1. Location — free text (e.g. "London, UK")\n` +
              `2. Distance — ask: "How far are you open to matching? Within your city (~50 km), ` +
              `within a few hours' travel (~300 km), or anywhere?" Map to: 50 / 300 / null.\n` +
              `3. Age range — both min and max optional. Accept "no preference" immediately.\n` +
              `4. Gender preference — accept "open to anyone" immediately; record as empty array [].\n\n` +
              `Do NOT push back on open/no-preference answers. Do NOT re-ask.\n\n` +
              `Then ask: "What's the best way to reach you when there's a match? ` +
              `(email, Discord, Telegram, WhatsApp, or iMessage)"\n\n` +
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
            `[TrueMatch] Preferences not yet set. Ask the user (all in one exchange):\n` +
              `1. Where are you based? (free text)\n` +
              `2. How far are you open to matching? (within your city / few hours' travel / anywhere)\n` +
              `3. Any age range preference? (both optional, "no preference" is a complete answer)\n` +
              `4. Gender preference? ("open to anyone" is a complete answer — record as [])\n\n` +
              `Accept open/no-preference answers without pushback, then save:\n` +
              `  node "$HOME/.truematch/truematch.js" preferences --set '<json>'\n\n` +
              `If user tries to update preferences in main conversation later, redirect them:\n` +
              `"I don't update preferences here because this is my observation channel. ` +
              `Say /truematch-prefs and we can do it there."`,
          );
          return;
        }

        // Update observation summary from Claude's existing memory
        let output: string;
        try {
          output = execSync("truematch observe --update", {
            encoding: "utf8",
            timeout: 5000,
          });
        } catch {
          // truematch not set up yet — silently skip
          return;
        }

        event.messages.push(
          `[TrueMatch] Session ended. Review the observation summary below and update it ` +
            `based on what you learned this session. Save with ` +
            `\`truematch observe --write '<json>'\`.\n\n` +
            `If matching_eligible is false, tell the user naturally — e.g. "I'm still ` +
            `building a picture of you from our conversations. I'll let you know when ` +
            `there's enough to start matching." Do NOT ask questions to accelerate this.\n\n` +
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
