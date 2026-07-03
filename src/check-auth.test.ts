import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for container/claude/check-auth.sh.
 *
 * The script runs under tmux's server environment (not the pane's), so it
 * must detect env-var auth by inspecting the mounted secret file directly.
 */

const SCRIPT = join(__dirname, "..", "container", "claude", "check-auth.sh");

function run(opts: {
  creds?: string | null;
  envFile?: string | null;
}): { stdout: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), "check-auth-"));
  try {
    const credsPath = join(dir, "credentials.json");
    const envPath = join(dir, "claude.env");
    if (opts.creds != null) writeFileSync(credsPath, opts.creds);
    if (opts.envFile != null) writeFileSync(envPath, opts.envFile);

    const env = {
      ...process.env,
      AGENTD_CREDS_FILE: credsPath,
      AGENTD_CLAUDE_ENV_FILE: envPath,
    };
    try {
      const stdout = execSync(`bash ${SCRIPT}`, { env, encoding: "utf8" });
      return { stdout, code: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer; status?: number };
      return { stdout: err.stdout?.toString() ?? "", code: err.status ?? 1 };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-auth.sh", () => {
  it("shows NO CREDS when neither file exists", () => {
    const { stdout } = run({});
    expect(stdout).toContain("NO CREDS");
  });

  it("is silent when creds file exists without expiry", () => {
    const { stdout } = run({ creds: "{}" });
    expect(stdout.trim()).toBe("");
  });

  it("shows AUTH EXPIRED when creds expired", () => {
    const past = Date.now() - 60_000;
    const { stdout } = run({
      creds: JSON.stringify({ claudeAiOauth: { expiresAt: past } }),
    });
    expect(stdout).toContain("AUTH EXPIRED");
  });

  it("is silent when env file has CLAUDE_CODE_OAUTH_TOKEN", () => {
    const { stdout } = run({ envFile: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-xxx\n" });
    expect(stdout.trim()).toBe("");
  });

  it("is silent when env file has ANTHROPIC_API_KEY", () => {
    const { stdout } = run({ envFile: "ANTHROPIC_API_KEY=sk-ant-xxx\n" });
    expect(stdout.trim()).toBe("");
  });

  it("accepts export-prefixed assignments", () => {
    const { stdout } = run({ envFile: "export ANTHROPIC_API_KEY=sk-ant-xxx\n" });
    expect(stdout.trim()).toBe("");
  });

  it("shows NO CREDS when env file has no relevant vars", () => {
    const { stdout } = run({ envFile: "SOME_OTHER_VAR=foo\n" });
    expect(stdout).toContain("NO CREDS");
  });

  it("ignores commented-out lines", () => {
    const { stdout } = run({ envFile: "#ANTHROPIC_API_KEY=sk-ant-xxx\n" });
    expect(stdout).toContain("NO CREDS");
  });

  it("creds file takes precedence over env file for expiry reporting", () => {
    const past = Date.now() - 60_000;
    const { stdout } = run({
      creds: JSON.stringify({ claudeAiOauth: { expiresAt: past } }),
      envFile: "ANTHROPIC_API_KEY=sk-ant-xxx\n",
    });
    expect(stdout).toContain("AUTH EXPIRED");
  });
});

/**
 * Tests for the pi and codex check-auth.sh scripts. Same tmux-server-environment
 * caveat as Claude's: the --secret <agent>.env vars are sourced into the pane,
 * not visible here, so API-key auth must be detected by inspecting the secret
 * file rather than reading env vars.
 */

function runAgentCheckAuth(
  agent: "pi" | "codex",
  opts: { auth?: string | null; envFile?: string | null },
): string {
  const dir = mkdtempSync(join(tmpdir(), `check-auth-${agent}-`));
  try {
    const authPath = join(dir, "auth.json");
    const envPath = join(dir, `${agent}.env`);
    if (opts.auth != null) writeFileSync(authPath, opts.auth);
    if (opts.envFile != null) writeFileSync(envPath, opts.envFile);
    const env = {
      ...process.env,
      AGENTD_CREDS_FILE: authPath,
      [`AGENTD_${agent.toUpperCase()}_ENV_FILE`]: envPath,
    };
    const script = join(__dirname, "..", "container", agent, "check-auth.sh");
    try {
      return execSync(`bash ${script}`, { env, encoding: "utf8" });
    } catch (e: unknown) {
      return (e as { stdout?: Buffer }).stdout?.toString() ?? "";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pi check-auth.sh", () => {
  it("shows NO CREDS when neither auth.json nor a key exists", () => {
    expect(runAgentCheckAuth("pi", {})).toContain("NO CREDS");
  });

  it("is silent when auth.json exists (subscription/login)", () => {
    expect(runAgentCheckAuth("pi", { auth: "{}" }).trim()).toBe("");
  });

  it("is silent for an API key in the secret file (not read from env)", () => {
    // The regression: env vars aren't in the tmux-server scope, so this must be
    // detected by grepping /run/secrets/pi.env, not by reading $OPENAI_API_KEY.
    expect(runAgentCheckAuth("pi", { envFile: "export OPENAI_API_KEY=sk-xxx\n" }).trim()).toBe("");
  });

  it("accepts any provider *_API_KEY in the secret file", () => {
    expect(runAgentCheckAuth("pi", { envFile: "MISTRAL_API_KEY=xxx\n" }).trim()).toBe("");
  });

  it("shows NO CREDS when the secret file has no key", () => {
    expect(runAgentCheckAuth("pi", { envFile: "SOME_OTHER_VAR=foo\n" })).toContain("NO CREDS");
  });

  it("ignores commented-out keys", () => {
    expect(runAgentCheckAuth("pi", { envFile: "#OPENAI_API_KEY=sk-xxx\n" })).toContain("NO CREDS");
  });
});

describe("codex check-auth.sh", () => {
  it("shows NO CREDS when neither auth.json nor a key exists", () => {
    expect(runAgentCheckAuth("codex", {})).toContain("NO CREDS");
  });

  it("is silent when auth.json exists", () => {
    expect(runAgentCheckAuth("codex", { auth: "{}" }).trim()).toBe("");
  });

  it("is silent for CODEX_API_KEY / OPENAI_API_KEY in the secret file (not env)", () => {
    expect(runAgentCheckAuth("codex", { envFile: "export OPENAI_API_KEY=sk-xxx\n" }).trim()).toBe("");
    expect(runAgentCheckAuth("codex", { envFile: "CODEX_API_KEY=sk-xxx\n" }).trim()).toBe("");
  });

  it("shows NO CREDS when the secret file has no relevant key", () => {
    expect(runAgentCheckAuth("codex", { envFile: "SOME_OTHER_VAR=foo\n" })).toContain("NO CREDS");
  });

  it("ignores commented-out keys", () => {
    expect(runAgentCheckAuth("codex", { envFile: "#OPENAI_API_KEY=sk-xxx\n" })).toContain("NO CREDS");
  });
});
