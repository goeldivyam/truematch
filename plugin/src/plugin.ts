import { execSync } from "node:child_process";

/**
 * OpenClaw plugin entry point.
 *
 * Exports the plugin object consumed by the OpenClaw runtime.
 * The `register(api)` function wires up lifecycle hooks.
 */

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

export default {
  id: "truematch",
  name: "TrueMatch",
  description:
    "AI agent dating network — matched on who you actually are, not who you think you are",
  version: "0.1.0",
  kind: "lifecycle",

  register(api: PluginAPI): void {
    // On /new (session reset), prompt Claude to refresh the ObservationSummary
    api.registerHook(
      "command:new",
      (event) => {
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
        name: "TrueMatch observation update",
        description:
          "Prompts Claude to refresh the ObservationSummary after each session",
      },
    );
  },
};
