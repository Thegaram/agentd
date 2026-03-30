import { describe, it, expect } from "vitest";
import { getBackend, AGENT_NAMES, DEFAULT_AGENT } from "./index.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { aider } from "./aider.js";
import { credentialPreamble } from "./types.js";

describe("agent registry", () => {
  it("returns claude backend by name", () => {
    expect(getBackend("claude")).toBe(claude);
  });

  it("returns codex backend by name", () => {
    expect(getBackend("codex")).toBe(codex);
  });

  it("returns aider backend by name", () => {
    expect(getBackend("aider")).toBe(aider);
  });

  it("throws on unknown backend with available list", () => {
    expect(() => getBackend("unknown")).toThrow(/Unknown agent backend: "unknown"/);
    expect(() => getBackend("unknown")).toThrow(/available: claude, codex, aider/);
  });

  it("lists all available agent names", () => {
    expect(AGENT_NAMES).toContain("claude");
    expect(AGENT_NAMES).toContain("codex");
    expect(AGENT_NAMES).toContain("aider");
  });

  it("default agent is claude", () => {
    expect(DEFAULT_AGENT).toBe("claude");
  });
});

describe("credentialPreamble", () => {
  it("derives preamble from backend fields for claude", () => {
    const preamble = credentialPreamble(claude);
    expect(preamble).toContain("/home/agent/.claude/.credentials.json");
    expect(preamble).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(preamble).toContain("ANTHROPIC_API_KEY");
  });

  it("derives preamble from backend fields for codex", () => {
    const preamble = credentialPreamble(codex);
    expect(preamble).toContain("/home/agent/.codex/auth.json");
    expect(preamble).toContain("CODEX_API_KEY");
    expect(preamble).toContain("OPENAI_API_KEY");
  });
});

describe("claude backend", () => {
  it("has correct docker image", () => {
    expect(claude.dockerImage).toBe("agentd-claude:latest");
  });

  it("generates start command", () => {
    expect(claude.startCommand()).toBe("claude");
  });

  it("generates start command with model", () => {
    expect(claude.startCommand("opus")).toBe('claude --model "opus"');
  });

  it("generates resume command", () => {
    expect(claude.resumeCommand()).toBe("claude --continue || claude");
  });

  it("generates resume command with model", () => {
    expect(claude.resumeCommand("sonnet")).toBe(
      'claude --continue --model "sonnet" || claude --model "sonnet"',
    );
  });

  it("credential shadow vars include both Claude vars", () => {
    expect(claude.credentialShadowVars).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude.credentialShadowVars).toContain("ANTHROPIC_API_KEY");
  });

  it("has apply theme command", () => {
    expect(claude.applyThemeCommand?.()).toBeTruthy();
  });
});

describe("codex backend", () => {
  it("has correct docker image", () => {
    expect(codex.dockerImage).toBe("agentd-codex:latest");
  });

  it("generates start command with sandbox bypass", () => {
    const cmd = codex.startCommand();
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toMatch(/^codex /);
  });

  it("generates start command with model", () => {
    const cmd = codex.startCommand("gpt-5.4");
    expect(cmd).toContain("--model gpt-5.4");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("generates resume command with --last", () => {
    const cmd = codex.resumeCommand();
    expect(cmd).toMatch(/^codex resume --last/);
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Falls back to fresh start if no session found
    expect(cmd).toContain("||");
  });

  it("credential shadow vars include both Codex vars", () => {
    expect(codex.credentialShadowVars).toContain("CODEX_API_KEY");
    expect(codex.credentialShadowVars).toContain("OPENAI_API_KEY");
  });

  it("has no theme methods", () => {
    expect(codex.applyThemeCommand).toBeUndefined();
    expect(codex.hostTheme).toBeUndefined();
  });
});

describe("aider backend", () => {
  it("has correct docker image", () => {
    expect(aider.dockerImage).toBe("agentd-aider:latest");
  });

  it("generates start command pointing at Ollama", () => {
    const cmd = aider.startCommand();
    expect(cmd).toContain("aider");
    expect(cmd).toContain("--openai-api-base http://host.docker.internal:11434/v1");
    expect(cmd).toContain("--openai-api-key unused");
    expect(cmd).toContain("--model openai/qwen2.5-coder:7b");
    expect(cmd).toContain("--no-auto-commits");
    // Pre-flight Ollama check
    expect(cmd).toContain("curl -sf --max-time 3");
    // Falls back to bash on aider failure
    expect(cmd).toContain("|| exec bash");
  });

  it("generates start command with model override", () => {
    const cmd = aider.startCommand("deepseek-coder:6.7b");
    expect(cmd).toContain("--model openai/deepseek-coder:6.7b");
  });

  it("preserves provider prefix in model override", () => {
    const cmd = aider.startCommand("openai/gpt-4o");
    expect(cmd).toContain("--model openai/gpt-4o");
    // Should not double-prefix
    expect(cmd).not.toContain("openai/openai/");
  });

  it("resume command is same as start (no session resume)", () => {
    const cmd = aider.resumeCommand();
    expect(cmd).toContain("aider");
    expect(cmd).toContain("--openai-api-base");
    expect(cmd).toContain("--model openai/qwen2.5-coder:7b");
  });

  it("does not require auth", () => {
    expect(aider.requiresAuth).toBe(false);
  });

  it("has empty credential shadow vars", () => {
    expect(aider.credentialShadowVars).toEqual([]);
  });

  it("produces empty credential preamble", () => {
    expect(credentialPreamble(aider)).toBe("");
  });

  it("has no theme methods", () => {
    expect(aider.applyThemeCommand).toBeUndefined();
    expect(aider.hostTheme).toBeUndefined();
  });
});
