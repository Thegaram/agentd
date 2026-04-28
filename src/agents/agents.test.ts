import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { getBackend, AGENT_NAMES, DEFAULT_AGENT } from "./index.js";
import { claude } from "./claude.js";
import {
  codex,
  readCodexThemeOverride,
  readCodexThemeFromToml,
  inferCodexThemeFromColorFgbg,
  inferCodexThemeFromAppleInterfaceStyle,
  inferCodexThemeFromOsc11,
} from "./codex.js";
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

  it("apply theme command is a no-op when AGENTD_THEME is empty", () => {
    const tmp = execSync("mktemp -d").toString().trim();
    try {
      const cjson = `${tmp}/.claude.json`;
      execSync(`echo '{"theme":"dark"}' > ${cjson}`);
      const cmd = claude.applyThemeCommand!()!.replaceAll(
        "/home/agent/.claude.json",
        cjson,
      );
      execSync(`bash -c '${cmd.replaceAll("'", "'\\''")}'`, { env: {} });
      expect(execSync(`cat ${cjson}`).toString()).toContain('"theme":"dark"');
    } finally {
      execSync(`rm -r ${tmp}`);
    }
  });

  it("apply theme command writes theme when AGENTD_THEME is set", () => {
    const tmp = execSync("mktemp -d").toString().trim();
    try {
      const cjson = `${tmp}/.claude.json`;
      execSync(`echo '{"theme":"dark"}' > ${cjson}`);
      const cmd = claude.applyThemeCommand!()!.replaceAll(
        "/home/agent/.claude.json",
        cjson,
      );
      execSync(`bash -c '${cmd.replaceAll("'", "'\\''")}'`, {
        env: { AGENTD_THEME: "light" },
      });
      expect(execSync(`cat ${cjson}`).toString()).toContain('"theme": "light"');
    } finally {
      execSync(`rm -r ${tmp}`);
    }
  });
});

describe("codex backend", () => {
  it("has correct docker image", () => {
    expect(codex.dockerImage).toBe("agentd-codex:latest");
  });

  it("generates start command with sandbox bypass", () => {
    const cmd = codex.startCommand();
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("tui.theme=");
    expect(cmd).toContain('AGENTD_THEME');
    expect(cmd).toContain("cmd=(");
  });

  it("generates start command with model", () => {
    const cmd = codex.startCommand("gpt-5.4");
    expect(cmd).toContain("'--model' 'gpt-5.4'");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("generates resume command with --last", () => {
    const cmd = codex.resumeCommand();
    expect(cmd).toContain('resume --last');
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("tui.theme=");
    // Falls back to fresh start if no session found
    expect(cmd).toContain("||");
  });

  it("credential shadow vars include both Codex vars", () => {
    expect(codex.credentialShadowVars).toContain("CODEX_API_KEY");
    expect(codex.credentialShadowVars).toContain("OPENAI_API_KEY");
  });

  it("has theme methods", () => {
    expect(codex.applyThemeCommand?.()).toBeTruthy();
    expect(typeof codex.hostTheme).toBe("function");
    expect(typeof codex.explicitHostTheme).toBe("function");
  });
});

describe("Codex theme override", () => {
  it("prefers AGENTD_CODEX_THEME when set", () => {
    expect(readCodexThemeOverride({
      AGENTD_CODEX_THEME: "github",
      CODEX_THEME: "two-dark",
    })).toBe("github");
  });

  it("falls back to CODEX_THEME when AGENTD_CODEX_THEME is unset", () => {
    expect(readCodexThemeOverride({
      CODEX_THEME: "github-dark",
    })).toBe("github-dark");
  });
});

describe("readCodexThemeFromToml", () => {
  it("reads theme from [tui] section", () => {
    expect(readCodexThemeFromToml(`
[tui]
theme = "github-dark"
`)).toBe("github-dark");
  });

  it("ignores theme keys outside [tui]", () => {
    expect(readCodexThemeFromToml(`
theme = "wrong"

[tui]
status_line = ["current-dir"]
`)).toBeUndefined();
  });

  it("supports single-quoted values", () => {
    expect(readCodexThemeFromToml(`
[tui]
theme = 'tokyonight-storm'
`)).toBe("tokyonight-storm");
  });
});

describe("Codex theme inference", () => {
  it("infers a light theme from COLORFGBG", () => {
    expect(inferCodexThemeFromColorFgbg("15;7")).toBe("github");
  });

  it("infers a dark theme from COLORFGBG", () => {
    expect(inferCodexThemeFromColorFgbg("15;0")).toBe("two-dark");
  });

  it("infers a light theme from an OSC 11 response", () => {
    expect(inferCodexThemeFromOsc11("\u001b]11;rgb:ffff/ffff/ffff\u0007")).toBe("github");
  });

  it("infers a dark theme from an OSC 11 response", () => {
    expect(inferCodexThemeFromOsc11("\u001b]11;rgb:0000/0000/0000\u0007")).toBe("two-dark");
  });

  it("infers a dark theme from macOS Dark appearance", () => {
    expect(inferCodexThemeFromAppleInterfaceStyle("Dark\n")).toBe("two-dark");
  });

  it("infers a light theme from macOS Light appearance", () => {
    expect(inferCodexThemeFromAppleInterfaceStyle("")).toBe("github");
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
