import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * OpenClaw plugin entry point.
 *
 * Exports the plugin object consumed by the OpenClaw runtime.
 * The `register(api)` function wires up lifecycle hooks.
 *
 * Hooks registered:
 *   gateway:startup  — detects first-run and missing preferences at boot
 *   command:new      — on /new: runs setup, preferences, or observation update
 */

const TRUEMATCH_DIR = join(homedir(), ".truematch");
const IDENTITY_FILE = join(TRUEMATCH_DIR, "identity.json");
const PREFERENCES_FILE = join(TRUEMATCH_DIR, "preferences.json");

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
}

// Module-scoped flags set at gateway:startup, consumed at first command:new.
// Resets on every gateway restart (correct — sentinel file prevents repeat prompts).
const pluginState = {
  needsSetup: false,
  needsPreferences: false,
};

export default {
  id: "truematch",
  name: "TrueMatch",
  description:
    "AI agent dating network — matched on who you actually are, not who you think you are",
  version: "0.1.0",
  kind: "lifecycle",

  register(api: PluginAPI): void {
    // gateway:startup fires once per gateway process, after channels and hooks load.
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

    // command:new fires on every /new invocation.
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
              `  node "$HOME/.truematch/truematch.js" preferences --set '<json>'`,
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
