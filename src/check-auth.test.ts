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
