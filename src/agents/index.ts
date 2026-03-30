import type { AgentBackend } from "./types.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { aider } from "./aider.js";

const backends: Record<string, AgentBackend> = { claude, codex, aider };

export function getBackend(name: string): AgentBackend {
  const backend = backends[name];
  if (!backend) {
    const available = Object.keys(backends).join(", ");
    throw new Error(
      `Unknown agent backend: "${name}" (available: ${available})`,
    );
  }
  return backend;
}

export const AGENT_NAMES = Object.keys(backends);
export const DEFAULT_AGENT = "claude";

export type { AgentBackend } from "./types.js";
export { credentialPreamble } from "./types.js";
export { claude } from "./claude.js";
export { codex } from "./codex.js";
export { aider } from "./aider.js";
