import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  forwardedTerminalEnv,
  parseDockerPortOutput,
  placeTranscriptsSymlink,
  shortenMountPath,
  resolveContainerTerm,
  transcriptsMountArg,
} from "./session.js";
import { createPaths } from "./paths.js";
import { claude } from "./agents/claude.js";
import { codex } from "./agents/codex.js";
import { aider } from "./agents/aider.js";

describe("SessionManager", () => {
  let agentdHome: string;
  let mgr: SessionManager;

  beforeEach(() => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-session-test-"));
    mgr = new SessionManager({ agentdHome });
  });

  afterEach(() => {
    rmSync(agentdHome, { recursive: true, force: true });
  });

  it("loads and saves state file", () => {
    mgr.saveSession({
      label: "my-project",
      agent: "claude",
      containerId: "abc123",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
    });
    const loaded = mgr.getSession("my-project");
    expect(loaded?.containerId).toBe("abc123");
    expect(loaded?.agent).toBe("claude");
  });

  it("removes session from state", () => {
    mgr.saveSession({
      label: "my-project",
      agent: "claude",
      containerId: "abc123",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
    });
    mgr.removeSession("my-project");
    expect(mgr.getSession("my-project")).toBeUndefined();
  });

  it("defaults agent to claude for old state entries", () => {
    // Simulate a state.json from before the agent field was added
    writeFileSync(
      join(agentdHome, "state.json"),
      JSON.stringify({
        sessions: [{
          label: "legacy",
          containerId: "old123",
          startedAt: new Date().toISOString(),
        }],
      }),
    );
    const mgr2 = new SessionManager({ agentdHome });
    const session = mgr2.getSession("legacy");
    expect(session?.agent).toBe("claude");
  });
});

describe("hasCredentials", () => {
  let agentdHome: string;

  afterEach(() => {
    rmSync(agentdHome, { recursive: true, force: true });
  });

  it("returns true when claude-oauth.json exists", () => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-oauth-test-"));
    mkdirSync(join(agentdHome, "secrets"), { recursive: true });
    writeFileSync(join(agentdHome, "secrets", "claude-oauth.json"), "{}");
    const mgr = new SessionManager({ agentdHome });
    expect(mgr.hasCredentials(claude)).toBe(true);
  });

  it("returns false when claude-oauth.json is missing", () => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-oauth-test-"));
    mkdirSync(join(agentdHome, "secrets"), { recursive: true });
    const mgr = new SessionManager({ agentdHome });
    expect(mgr.hasCredentials(claude)).toBe(false);
  });

  it("returns true when codex-auth.json exists", () => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-codex-test-"));
    mkdirSync(join(agentdHome, "secrets"), { recursive: true });
    writeFileSync(join(agentdHome, "secrets", "codex-auth.json"), "{}");
    const mgr = new SessionManager({ agentdHome });
    expect(mgr.hasCredentials(codex)).toBe(true);
  });

  it("returns false when codex-auth.json is missing", () => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-codex-test-"));
    mkdirSync(join(agentdHome, "secrets"), { recursive: true });
    const mgr = new SessionManager({ agentdHome });
    expect(mgr.hasCredentials(codex)).toBe(false);
  });

  it("returns false for aider (no credential file expected)", () => {
    agentdHome = mkdtempSync(join(tmpdir(), "agentd-aider-test-"));
    mkdirSync(join(agentdHome, "secrets"), { recursive: true });
    const mgr = new SessionManager({ agentdHome });
    expect(mgr.hasCredentials(aider)).toBe(false);
  });
});

describe("parseDockerPortOutput", () => {
  it("parses single port mapping", () => {
    expect(parseDockerPortOutput("3000/tcp -> 0.0.0.0:49152"))
      .toBe("3000\u219249152");
  });

  it("deduplicates IPv4 and IPv6 entries", () => {
    const input = "3000/tcp -> 0.0.0.0:49152\n3000/tcp -> [::]:49152";
    expect(parseDockerPortOutput(input)).toBe("3000\u219249152");
  });

  it("handles multiple ports", () => {
    const input = "3000/tcp -> 0.0.0.0:49152\n8080/tcp -> 0.0.0.0:49153";
    expect(parseDockerPortOutput(input)).toBe("3000\u219249152, 8080\u219249153");
  });

  it("returns empty string for empty input", () => {
    expect(parseDockerPortOutput("")).toBe("");
  });

  it("skips malformed lines", () => {
    const input = "garbage\n3000/tcp -> 0.0.0.0:49152\nalso garbage";
    expect(parseDockerPortOutput(input)).toBe("3000\u219249152");
  });
});

describe("shortenMountPath", () => {
  it("extracts basename from absolute path", () => {
    expect(shortenMountPath("/home/user/code/my-project")).toBe("my-project");
  });

  it("extracts basename from home-relative path", () => {
    expect(shortenMountPath("/Users/alice/my-project")).toBe("my-project");
  });

  it("preserves root path as-is", () => {
    expect(shortenMountPath("/")).toBe("/");
  });
});

describe("resolveContainerTerm", () => {
  it("uses tmux-256color when launched from tmux", () => {
    expect(resolveContainerTerm({ TERM: "xterm-256color", TMUX: "/tmp/tmux-1000/default,1,0" }))
      .toBe("tmux-256color");
  });

  it("preserves screen-style nesting when TERM starts with screen", () => {
    expect(resolveContainerTerm({ TERM: "screen-256color" }))
      .toBe("screen-256color");
  });

  it("falls back to xterm-256color outside tmux", () => {
    expect(resolveContainerTerm({ TERM: "xterm-kitty" }))
      .toBe("xterm-256color");
  });
});

describe("transcriptsMountArg", () => {
  const paths = createPaths("/home/me/.agentd");

  it("returns the bind mount string for a backend with transcripts support", () => {
    expect(transcriptsMountArg(claude, paths, "abc-123")).toBe(
      "/home/me/.agentd/transcripts/abc-123:/home/agent/.claude/projects/-workspace",
    );
  });

  it("returns undefined when the backend has no transcripts dir", () => {
    expect(transcriptsMountArg(codex, paths, "abc-123")).toBeUndefined();
    expect(transcriptsMountArg(aider, paths, "abc-123")).toBeUndefined();
  });

  it("returns undefined when no key is supplied", () => {
    expect(transcriptsMountArg(claude, paths, undefined)).toBeUndefined();
  });
});

describe("transcripts symlink helpers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentd-symlink-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a symlink in an existing parent dir", () => {
    const target = join(root, "data");
    mkdirSync(target);
    const link = join(root, "agentd-foo");
    placeTranscriptsSymlink(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it("creates the parent dir on demand when missing", () => {
    const target = join(root, "data");
    mkdirSync(target);
    const link = join(root, "view", "nested", "agentd-foo");
    placeTranscriptsSymlink(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

});

describe("forwardedTerminalEnv", () => {
  it("forwards supported host terminal identity variables", () => {
    expect(forwardedTerminalEnv({
      TERM_PROGRAM: "WezTerm",
      WEZTERM_VERSION: "20240203",
      COLORFGBG: "15;7",
    })).toEqual([
      ["COLORFGBG", "15;7"],
      ["TERM_PROGRAM", "WezTerm"],
      ["WEZTERM_VERSION", "20240203"],
    ]);
  });

  it("skips empty values", () => {
    expect(forwardedTerminalEnv({
      TERM_PROGRAM: "",
      COLORFGBG: undefined,
    })).toEqual([]);
  });
});
