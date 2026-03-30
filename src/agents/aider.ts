import { join } from "node:path";

import type { AgentBackend } from "./types.js";
import type { Paths } from "../paths.js";

const DEFAULT_MODEL = "qwen2.5-coder:7b";
const OLLAMA_BASE = "http://host.docker.internal:11434";
const OLLAMA_API = `${OLLAMA_BASE}/v1`;

const OLLAMA_CHECK = `curl -sf --max-time 3 ${OLLAMA_BASE}/api/tags >/dev/null 2>&1`
  + ` || { echo "ERROR: Cannot reach Ollama at ${OLLAMA_BASE}"; echo "Start it on the host: ollama serve"; exec bash; }`;

function aiderCommand(model?: string): string {
  const m = model ?? DEFAULT_MODEL;
  // Prefix with openai/ if no provider prefix present (aider convention for OpenAI-compat endpoints)
  const fullModel = m.includes("/") ? m : `openai/${m}`;
  const cmd = [
    "aider",
    `--openai-api-base ${OLLAMA_API}`,
    "--openai-api-key unused",
    `--model ${fullModel}`,
    "--no-auto-commits",
    "--yes",
  ].join(" ");
  // Check Ollama reachability first; fall back to bash on failure so container stays alive
  return `${OLLAMA_CHECK}\n${cmd} || exec bash`;
}

export const aider: AgentBackend = {
  name: "aider",
  dockerImage: "agentd-aider:latest",
  defaultModel: DEFAULT_MODEL,

  credentialShadowVars: [],

  credentialHostPath(paths: Paths): string {
    return join(paths.home, "secrets", "aider-auth.json");
  },

  credentialContainerPath: "/home/agent/.aider/auth.json",

  startCommand(model?: string): string {
    return aiderCommand(model);
  },

  resumeCommand(model?: string): string {
    // aider has no session resume; it re-reads repo state on start.
    return aiderCommand(model);
  },

  requiresAuth: false,

  defaultSecretScope: "aider",

  secretMissingHint(_path: string): string {
    return "No secrets needed for aider with local Ollama";
  },

  noAuthWarning: "",
};
