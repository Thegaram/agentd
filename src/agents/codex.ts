import { join } from "node:path";

import type { AgentBackend } from "./types.js";
import type { Paths } from "../paths.js";

/**
 * Flags shared by all codex invocations inside the container.
 * --dangerously-bypass-approvals-and-sandbox disables the OS-level sandbox
 * (Seatbelt/bubblewrap) which fails under Docker's --cap-drop ALL.
 * The Docker container itself provides isolation.
 */
const BASE_FLAGS = "--dangerously-bypass-approvals-and-sandbox";

export const codex: AgentBackend = {
  name: "codex",
  dockerImage: "agentd-codex:latest",
  defaultModel: "gpt-5.4",

  credentialShadowVars: ["CODEX_API_KEY", "OPENAI_API_KEY"],

  credentialHostPath(paths: Paths): string {
    return join(paths.home, "secrets", "codex-auth.json");
  },

  credentialContainerPath: "/home/agent/.codex/auth.json",

  startCommand(model?: string): string {
    const modelFlag = model ? ` --model ${model}` : "";
    return `codex ${BASE_FLAGS}${modelFlag}`;
  },

  resumeCommand(model?: string): string {
    const modelFlag = model ? ` --model ${model}` : "";
    // Each container runs a single Codex session, so --last always finds it.
    return `codex resume --last ${BASE_FLAGS}${modelFlag} || codex ${BASE_FLAGS}${modelFlag}`;
  },

  defaultSecretScope: "codex",

  secretMissingHint(path: string): string {
    return `Create it with: echo "CODEX_API_KEY=sk-..." > ${path}`;
  },

  noAuthWarning: "Warning: no --secret passed, Codex will prompt for login",
};
