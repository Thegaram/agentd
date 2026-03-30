import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { AgentBackend } from "./types.js";
import type { Paths } from "../paths.js";

export const claude: AgentBackend = {
  name: "claude",
  dockerImage: "agentd-claude:latest",
  defaultModel: "opus[1m]",

  credentialShadowVars: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],

  credentialHostPath(paths: Paths): string {
    return join(paths.home, "secrets", "claude-oauth.json");
  },

  credentialContainerPath: "/home/agent/.claude/.credentials.json",

  startCommand(model?: string): string {
    const modelFlag = model ? ` --model "${model}"` : "";
    return `claude${modelFlag}`;
  },

  resumeCommand(model?: string): string {
    const modelFlag = model ? ` --model "${model}"` : "";
    return `claude --continue${modelFlag} || claude${modelFlag}`;
  },

  defaultSecretScope: "claude",

  secretMissingHint(path: string): string {
    return `Create it with: echo "ANTHROPIC_API_KEY=sk-ant-..." > ${path}`;
  },

  noAuthWarning: "Warning: no --secret passed, Claude will prompt for login",

  hostTheme(): string | undefined {
    try {
      const raw = readFileSync(join(homedir(), ".claude.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["theme"] === "string") return parsed["theme"];
    } catch { /* missing or unreadable */ }
    return undefined;
  },

  applyThemeCommand(): string {
    return `[ -z "$AGENTD_THEME" ] || jq --arg t "$AGENTD_THEME" '.theme=$t' /home/agent/.claude.json > /tmp/cj && mv /tmp/cj /home/agent/.claude.json`;
  },
};
