import type { Paths } from "../paths.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * Everything that differs between coding agent runtimes (Claude Code, Codex, etc.).
 * Session orchestration, Docker lifecycle, and security hardening stay in session.ts.
 */
export interface AgentBackend {
  /** Identifier used in CLI flags and state.json (e.g. "claude", "codex"). */
  readonly name: string;

  /** Docker image tag (e.g. "agentd-claude:latest"). */
  readonly dockerImage: string;

  /** Default model used when no --model override is given. */
  readonly defaultModel: string;

  // ── Container environment ────────────────────────────────────────

  /** Extra environment variables to set inside the container. */
  readonly containerEnv?: Readonly<Record<string, string>>;

  // ── Persona / global instructions (optional) ─────────────────────

  /**
   * Container path for the agent's global "persona" instruction file —
   * Claude's global CLAUDE.md, Codex's global AGENTS.md. agentd bind-mounts a
   * host file here read-only so a user-supplied persona applies to every new
   * session. Omit to opt out (e.g. aider has no global instructions file).
   */
  readonly personaContainerPath?: string;

  // ── Session transcripts (optional) ───────────────────────────────

  /**
   * Opt in to per-session transcript persistence. agentd bind-mounts a
   * host bucket at `containerDir` and exposes the bucket to host tooling
   * (e.g. /insights) by symlinking it under `hostDiscoverableDir`.
   */
  readonly transcripts?: {
    containerDir: string;
    hostDiscoverableDir(): string;
  };

  // ── Credentials ──────────────────────────────────────────────────

  /** Env vars that shadow a credential file and must be unset when it's mounted. */
  readonly credentialShadowVars: readonly string[];

  /**
   * Host path to the credential file (e.g. ~/.agentd/secrets/claude-oauth.json).
   * Omit for agents that manage their own credential file inside the container
   * (e.g. pi writes/refreshes ~/.pi/agent/auth.json itself via /login, so a
   * read-only host mount would block its atomic rewrite). When omitted, agentd
   * mounts nothing at the auth path and the in-container login persists in the
   * container's writable layer across stop/resume.
   */
  credentialHostPath?(paths: Paths): string;

  /** Container-side mount target for the credential file. Omit when credentialHostPath is omitted. */
  readonly credentialContainerPath?: string;

  // ── Agent CLI commands ───────────────────────────────────────────

  /** Shell command to start a fresh session. */
  startCommand(model?: string): string;

  /** Shell command to resume a session (with fallback chain). */
  resumeCommand(model?: string): string;

  // ── Secrets & auth ───────────────────────────────────────────────

  /** Whether this backend requires credentials or secret env files. Defaults to true. */
  readonly requiresAuth?: boolean;

  /** Default --secret scope when no credentials file exists (e.g. "claude"). */
  readonly defaultSecretScope: string;

  /** User-facing hint when a secret file is missing. */
  secretMissingHint(path: string): string;

  /** Warning printed when no auth is available at all. */
  readonly noAuthWarning: string;

  // ── Host theme forwarding (optional) ─────────────────────────────

  /** Read a theme value from the host's agent config (or undefined). */
  hostTheme?(): MaybePromise<string | undefined>;

  /** Read an explicit host theme preference that should affect resume conflicts. */
  explicitHostTheme?(): MaybePromise<string | undefined>;

  /** Bash command to apply AGENTD_THEME inside the container, or null. */
  applyThemeCommand?(): string | null;
}

/**
 * Bash snippet that unsets shadow vars when the credential file is present.
 * Derived from the backend's credentialContainerPath and credentialShadowVars.
 */
export function credentialPreamble(backend: AgentBackend): string {
  if (backend.credentialShadowVars.length === 0 || !backend.credentialContainerPath) return "";
  const vars = backend.credentialShadowVars.join(" ");
  return `if [ -f "${backend.credentialContainerPath}" ]; then unset ${vars} 2>/dev/null; fi`;
}
