import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { SessionState } from "./schema.js";
import { createPaths, type Paths } from "./paths.js";
import { SessionStore } from "./store.js";
import { getBackend, credentialPreamble, type AgentBackend } from "./agents/index.js";
import {
  dockerImageExists,
  dockerCreate,
  dockerStart,
  dockerRemove,
  dockerInspectState,
  dockerExec,
  dockerCp,
  dockerAttachSync,
  dockerPort,
} from "./docker.js";

const HARDENING_FLAGS = [
  "--security-opt", "no-new-privileges",
  "--cap-drop", "ALL",
  "--add-host", "host.docker.internal:host-gateway",
  "--add-host", "metadata.google.internal:127.0.0.1",
  "--add-host", "metadata.google:127.0.0.1",
  "--add-host", "169.254.169.254:127.0.0.1",
];

let hasWarnedNestedTmuxClipboard = false;
const FORWARDED_TERMINAL_ENV_VARS = [
  "COLORFGBG",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "WEZTERM_VERSION",
  "ITERM_PROFILE",
  "ITERM_PROFILE_NAME",
  "KITTY_WINDOW_ID",
  "KONSOLE_VERSION",
  "GNOME_TERMINAL_SCREEN",
  "VTE_VERSION",
  "WT_SESSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_VERSION",
] as const;

/**
 * Shared container arg prefix: name and hardening.
 */
function buildBaseContainerArgs(name: string): string[] {
  return [
    "--name", `agentd-${name}`,
    ...HARDENING_FLAGS,
  ];
}

/** Container-side mount point for secret env files. */
const SECRETS_MOUNT_DIR = "/run/secrets";

/**
 * Mount secret env files as read-only volumes inside the container.
 * Throws if a file is missing — unless credentials exist (the
 * credential file provides auth, so the missing env file is harmless).
 */
function mountSecretFilesStrict(
  args: string[],
  scopes: string[],
  secretFilePath: (scope: string) => string,
  hasCredentials: boolean,
  missingHint: (path: string) => string,
  noAuthWarning: string,
): void {
  for (const scope of scopes) {
    const p = secretFilePath(scope);
    if (!existsSync(p)) {
      if (hasCredentials) {
        console.warn(`Warning: secret file not found: ${p} (using credential file instead)`);
        continue;
      }
      throw new Error(
        `Secret file not found: ${p}\n` + missingHint(p),
      );
    }
    args.push("-v", `${p}:${SECRETS_MOUNT_DIR}/${scope}.env:ro`);
  }
  if (scopes.length === 0 && !hasCredentials && noAuthWarning) {
    console.warn(noAuthWarning);
  }
}

/**
 * Generate bash lines that source each secret env file with auto-export.
 */
function secretSourceLines(scopes: string[]): string[] {
  return scopes.map(
    (scope) => `set -a; . ${SECRETS_MOUNT_DIR}/${scope}.env; set +a`,
  );
}

/**
 * Preserve tmux nesting information without depending on host-specific TERM entries
 * that may not exist in the container terminfo database.
 */
export function resolveContainerTerm(env: NodeJS.ProcessEnv = process.env): string {
  const term = env["TERM"] ?? "";
  if (env["TMUX"] || term.startsWith("tmux")) return "tmux-256color";
  if (term.startsWith("screen")) return "screen-256color";
  return "xterm-256color";
}

export function forwardedTerminalEnv(env: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  return FORWARDED_TERMINAL_ENV_VARS.flatMap((key) => {
    const value = env[key];
    return value ? [[key, value] as [string, string]] : [];
  });
}

function readHostTmuxOption(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function warnIfHostTmuxMayBlockClipboard(): void {
  if (hasWarnedNestedTmuxClipboard || !process.env["TMUX"]) return;
  hasWarnedNestedTmuxClipboard = true;

  const setClipboard = readHostTmuxOption(["show", "-s", "-v", "set-clipboard"]);
  const allowPassthrough = readHostTmuxOption(["show", "-g", "-v", "allow-passthrough"]);
  const clipboardEnabled = setClipboard === "on";
  const passthroughEnabled = allowPassthrough === "on" || allowPassthrough === "all";
  if (clipboardEnabled || passthroughEnabled) return;

  console.warn(
    "Warning: host tmux is not forwarding clipboard escape sequences "
      + `(set-clipboard=${setClipboard || "unknown"}, allow-passthrough=${allowPassthrough || "unknown"}). `
      + "Nested agentd selections may stay inside tmux buffers only. "
      + "Add `set -s set-clipboard on` and/or `set -g allow-passthrough on` to your host ~/.tmux.conf.",
  );
}

/**
 * Parse `docker port` output into a display string, deduplicating IPv4/IPv6 entries.
 * Input:  "3000/tcp -> 0.0.0.0:49152\n3000/tcp -> [::]:49152"
 * Output: "3000→49152"
 */
export function parseDockerPortOutput(raw: string): string {
  const seen = new Set<string>();
  return raw.split("\n").map((line) => {
    const match = line.match(/^(\d+)\/\w+\s+->\s+.*:(\d+)$/);
    if (!match) return null;
    const entry = `${match[1]}\u2192${match[2]}`;
    if (seen.has(entry)) return null;
    seen.add(entry);
    return entry;
  }).filter(Boolean).join(", ");
}

/**
 * Shorten an absolute mount host path for statusbar display.
 * ~/code/my-project → my-project
 * /home/user/code/my-project → my-project
 * / → /
 */
export function shortenMountPath(hostPath: string): string {
  const name = basename(hostPath);
  return name || hostPath;  // basename("/") returns "", keep original
}

export interface SessionManagerOptions {
  agentdHome: string;
}

export interface InteractiveOptions {
  name: string;
  backend: AgentBackend;
  mounts: string[];
  secrets: string[];
  ports: string[];
  model?: string | undefined;
  rm?: boolean | undefined;
}

export interface DryRunResult {
  dockerArgs: string[];
  script: string;
  theme?: string | undefined;
}

export class SessionManager {
  private readonly paths: Paths;
  private readonly store: SessionStore;

  constructor(opts: SessionManagerOptions) {
    this.paths = createPaths(opts.agentdHome);
    this.store = new SessionStore(this.paths.stateFile);
  }

  /** Whether the given backend's credential file exists on the host. */
  hasCredentials(backend: AgentBackend): boolean {
    return existsSync(backend.credentialHostPath(this.paths));
  }

  /**
   * Build the docker create args and startup script for a session,
   * without executing anything.
   */
  async buildSpawnCommand(opts: InteractiveOptions): Promise<DryRunResult> {
    const backend = opts.backend;

    if (!await dockerImageExists(backend.dockerImage)) {
      throw new Error(
        `Docker image "${backend.dockerImage}" not found. Run "make build" first.`,
      );
    }

    const theme = await backend.hostTheme?.();
    const dockerArgs = [
      ...buildBaseContainerArgs(opts.name),
      "-e", `TERM=${resolveContainerTerm()}`,
    ];
    for (const [key, value] of forwardedTerminalEnv()) {
      dockerArgs.push("-e", `${key}=${value}`);
    }
    if (theme) dockerArgs.push("-e", `AGENTD_THEME=${theme}`);
    if (backend.containerEnv) {
      for (const [key, value] of Object.entries(backend.containerEnv)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
    }

    for (const mount of opts.mounts) {
      dockerArgs.push("-v", mount);
    }

    for (const port of opts.ports) {
      dockerArgs.push("-p", port);
    }

    const hasCreds = existsSync(backend.credentialHostPath(this.paths));
    mountSecretFilesStrict(
      dockerArgs, opts.secrets, this.paths.secretFile, hasCreds,
      (p) => backend.secretMissingHint(p), backend.noAuthWarning,
    );

    if (hasCreds) {
      dockerArgs.push("-v", `${backend.credentialHostPath(this.paths)}:${backend.credentialContainerPath}:ro`);
    }

    const mountInfo = opts.mounts
      .filter((m) => {
        const host = m.split(":")[0];
        return host != null && !host.startsWith("/tmp/") && !host.startsWith("/var/");
      })
      .map((m) => {
        const host = m.split(":")[0] as string;
        const display = shortenMountPath(host);
        return m.endsWith(":ro") ? `${display} (ro)` : display;
      })
      .join(", ");

    // Pass status bar context as env vars; set-statusbar.sh applies them inside the container.
    dockerArgs.push(
      "-e", `AGENTD_AGENT=${backend.name}`,
      "-e", `AGENTD_LABEL=${opts.name}`,
    );
    if (opts.rm) dockerArgs.push("-e", "AGENTD_RM=1");
    if (mountInfo) dockerArgs.push("-e", `AGENTD_MOUNTS=${mountInfo}`);

    const themeCmd = backend.applyThemeCommand?.();
    const entrypoint = [
      themeCmd ? `${themeCmd} &&` : null,
      "cd /workspace",
      "&& tmux new-session -d -s agent 'bash /tmp/agentd-cmd'",
      "&& bash /agentd/set-statusbar.sh",
      "&& while tmux has-session -t agent 2>/dev/null; do sleep 1; done",
    ].filter(Boolean).join(" ");

    dockerArgs.push(
      "--entrypoint", "bash",
      backend.dockerImage,
      "-c", entrypoint,
    );

    const preamble = credentialPreamble(backend);
    const script = [
      `#!/bin/bash`,
      preamble,
      ...secretSourceLines(opts.secrets),
      backend.startCommand(opts.model),
    ].join("\n");

    return { dockerArgs, script, theme };
  }

  async spawnInteractive(opts: InteractiveOptions): Promise<string> {
    const { dockerArgs, script, theme } = await this.buildSpawnCommand(opts);

    const containerId = await dockerCreate(dockerArgs);

    await this.writeCmdFile(containerId, script);
    await dockerStart(containerId);

    const credPath = opts.backend.credentialHostPath(this.paths);
    const hasCreds = existsSync(credPath);

    // Save session immediately after start so the container is always
    // tracked in state.json — prevents ghost containers if later steps fail.
    this.saveSession({
      label: opts.name,
      agent: opts.backend.name,
      theme,
      containerId,
      startedAt: new Date().toISOString(),
      autoRemove: opts.rm ?? false,
      credential: hasCreds ? credPath : undefined,
      secrets: opts.secrets,
      model: opts.model ?? opts.backend.defaultModel,
      mounts: opts.mounts,
      ports: opts.ports,
      resolvedPorts: [],
    });

    await this.waitForTmux(containerId);
    if (opts.ports.length > 0) {
      const resolvedPorts = await this.writePortMappings(containerId);
      if (resolvedPorts) {
        const session = this.getSession(opts.name);
        if (session) {
          this.saveSession({ ...session, resolvedPorts });
        }
      }
    }

    return containerId;
  }

  async cancel(label: string): Promise<void> {
    const session = this.getSession(label);
    if (session?.containerId) {
      try {
        await dockerRemove(session.containerId);
      } catch {
        // container may already be removed
      }
    }
    this.removeSession(label);
  }

  async containerState(containerId: string): Promise<"running" | "stopped" | "missing"> {
    return dockerInspectState(containerId);
  }

  async containerExists(containerId: string): Promise<boolean> {
    return await this.containerState(containerId) !== "missing";
  }

  async isContainerRunning(containerId: string): Promise<boolean> {
    return await this.containerState(containerId) === "running";
  }

  private async writeCmdFile(
    containerId: string,
    cmd: string,
  ): Promise<void> {
    // Try exec first (container running), fall back to docker cp (stopped)
    try {
      await dockerExec(containerId, [
        "bash", "-c",
        `echo '${cmd.replaceAll("'", "'\\''")}' > /tmp/agentd-cmd`,
      ]);
    } catch {
      const tmp = `/tmp/agentd-cmd-${containerId.slice(0, 12)}`;
      writeFileSync(tmp, cmd);
      await dockerCp(tmp, `${containerId}:/tmp/agentd-cmd`);
      unlinkSync(tmp);
    }
  }

  /**
   * Query actual host port mappings, write them into the container,
   * and refresh the statusbar so port info is visible.
   */
  private async writePortMappings(containerId: string): Promise<string[] | undefined> {
    const raw = await dockerPort(containerId);
    if (!raw) return undefined;
    const mapped = parseDockerPortOutput(raw);
    if (mapped) {
      try {
        await dockerExec(containerId, [
          "bash", "-c",
          `echo '${mapped}' > /tmp/agentd-ports && bash /agentd/set-statusbar.sh`,
        ]);
      } catch { /* best effort */ }
      return mapped.split(", ");
    }
    return undefined;
  }

  private async waitForTmux(containerId: string): Promise<void> {
    for (let i = 0; i < 30; i++) {
      try {
        await dockerExec(containerId, ["tmux", "has-session", "-t", "agent"]);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error("tmux session failed to start");
  }

  async attach(label: string): Promise<void> {
    const session = this.getSession(label);
    if (!session?.containerId) {
      throw new Error(`No session found for: ${label}`);
    }

    const backend = getBackend(session.agent);

    // Auto-resume: if container is stopped, restart it
    const state = await this.containerState(session.containerId);
    if (state !== "running") {
      if (state === "missing") {
        throw new Error(
          `Container for "${label}" no longer exists. `
            + `Cancel and recreate: agentd cancel ${label}`,
        );
      }

      // Write resume command before restarting
      const preamble = credentialPreamble(backend);
      const lines = [
        `#!/bin/bash`,
        preamble,
        ...secretSourceLines(session.secrets ?? []),
        backend.resumeCommand(session.model),
      ];
      await this.writeCmdFile(session.containerId, lines.join("\n"));

      await dockerStart(session.containerId);
      await this.waitForTmux(session.containerId);
    }

    try {
      warnIfHostTmuxMayBlockClipboard();
      dockerAttachSync(session.containerId);
    } finally {
      // Disable mouse modes, exit alternate screen, restore terminal
      process.stdout.write(
        "\x1b[?1049l"    // exit alternate screen buffer
        + "\x1b[?1000l"  // disable mouse click tracking
        + "\x1b[?1002l"  // disable mouse drag tracking
        + "\x1b[?1003l"  // disable all mouse motion tracking
        + "\x1b[?1006l"  // disable SGR mouse encoding
        + "\x1b[?25h",   // show cursor
      );
      try { execFileSync("stty", ["sane"], { stdio: "inherit" }); } catch {}
    }
  }

  saveSession(session: SessionState): void {
    this.store.save(session);
  }

  getSession(label: string): SessionState | undefined {
    return this.store.get(label);
  }

  removeSession(label: string): void {
    this.store.remove(label);
  }

  listSessions(): SessionState[] {
    return this.store.list();
  }
}
