import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * OpenClaw plugin entry point.
 *
 * Exports the plugin object consumed by the OpenClaw runtime.
 * The `register(api)` function wires up lifecycle hooks and tools.
 *
 * Hooks registered:
 *   gateway:startup  — detects first-run and missing preferences at boot
 *   command:new      — on /new: runs setup, preferences, or observation update
 *
 * Tools registered:
 *   truematch_update_prefs — handles /truematch-prefs slash command (non-observational)
 */

const TRUEMATCH_DIR = join(homedir(), ".truematch");
const IDENTITY_FILE = join(TRUEMATCH_DIR, "identity.json");
const PREFERENCES_FILE = join(TRUEMATCH_DIR, "preferences.json");
const OBSERVATION_FILE = join(TRUEMATCH_DIR, "observation.json");

interface PluginEvent {
  type: string;
  action: string;
  messages: string[];
}

interface PluginAPI {
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

// Module-scoped flags set at gateway:startup, consumed at first command:new.
// Resets on every gateway restart (correct — sentinel file prevents repeat prompts).
const pluginState = {
  needsSetup: false,
  needsPreferences: false,
  needsBootstrap: false,
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
        } else if (!existsSync(OBSERVATION_FILE)) {
          // Identity and preferences exist but no observations yet.
          // Trigger the cold-start seed conversation on the next /new.
          pluginState.needsBootstrap = true;
        }
      },
      {
        name: "TrueMatch startup check",
        description:
          "Detects whether TrueMatch setup and preferences are configured",
      },
    );

    // ── Hook: command:new ──────────────────────────────────────────────────────
    // Fires on every /new invocation.
    // Three branches: first-time setup, missing preferences, or normal observation update.
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

        if (pluginState.needsBootstrap) {
          pluginState.needsBootstrap = false;
          // First: attempt to build observations from existing Claude memory.
          // Most real users already have conversation history — observe --update
          // will produce meaningful confidence scores without any bootstrapping.
          // Only use seed prompts if history is genuinely thin.
          let bootstrapOutput = "";
          try {
            bootstrapOutput = execSync(
              `node "$HOME/.truematch/truematch.js" observe --update`,
              { encoding: "utf8", timeout: 5000 },
            );
          } catch {
            // CLI not installed yet or other error — fall through to seed prompts
          }

          event.messages.push(
            `[TrueMatch] First observation pass — check if existing conversation history ` +
              `is sufficient to build a personality model.\n\n` +
              `Run: node "$HOME/.truematch/truematch.js" status\n\n` +
              `If the observation report shows all 7 dimensions with confidence above their ` +
              `floors (attachment ≥0.55, core_values ≥0.55, communication ≥0.50, ` +
              `emotional_regulation ≥0.60, humor ≥0.50, life_velocity ≥0.50, ` +
              `dealbreakers ≥0.60), save the result with ` +
              `\`node "$HOME/.truematch/truematch.js" observe --write '<json>'\` and ` +
              `you're done — no further questions needed.\n\n` +
              `If confidence is too low on multiple dimensions (not enough conversation ` +
              `history to draw from), then and only then, run the seed conversation:\n\n` +
              `Say: "Before we get into regular conversation, I want to understand who you ` +
              `actually are — not what you'd put on a profile. I'm going to ask you a few ` +
              `open questions. There are no right answers and I'm not scoring anything. ` +
              `Just be honest."\n\n` +
              `Seed prompts (ask 4–6, let answers breathe between them):\n` +
              `- "Tell me about a time a friendship or relationship surprised you."\n` +
              `- "What's something you changed your mind about in the last few years?"\n` +
              `- "Walk me through a typical Saturday — not ideal, just real."\n` +
              `- "What have you and a close friend disagreed about recently?"\n` +
              `- "What's a decision you made that you're still not sure about?"\n` +
              `- "What does a good day actually look like for you right now?"\n\n` +
              `Seed rules: no trait labels, no preference lists, no hypotheticals, ` +
              `no TrueMatch references. After seed, update observations — seed observations ` +
              `count at 0.6x weight vs spontaneous ones.` +
              (bootstrapOutput
                ? `\n\nCurrent observation output:\n${bootstrapOutput}`
                : ""),
          );
          return;
        }

        // Normal path: update observation summary
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
          `[TrueMatch] Session ended. Please review and update the observation summary below, ` +
            `then save it with \`truematch observe --write '<json>'\`:\n\n${output}`,
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
