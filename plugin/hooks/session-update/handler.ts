import { execSync } from "node:child_process";

interface HookEvent {
  type: string;
  action: string;
  messages: string[];
}

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== "command" || event.action !== "new") return;

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
};

export default handler;
