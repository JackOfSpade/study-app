import type { BridgeStatus } from "./bridge-client";
import type { Provider } from "./model";

/** How a saved record names the connection that produced it. Records written
 * before the Claude CLI keep their original label; new work names its own
 * provider. */
export function providerLabel(provider: string | undefined): string {
  if (provider === "claude-cli") return "Claude CLI";
  if (provider === "chatgpt-handoff") return "ChatGPT handoff";
  return "the study bridge";
}

/** The provider new work is recorded under for the relay's current mode. */
export const providerForMode = (mode: BridgeStatus["mode"]): Provider =>
  mode === "claude-cli" ? "claude-cli" : "study-mode";
