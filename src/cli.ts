import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Cli, z } from "incur";
import { SessionManager } from "./session.js";
import type { ContainerState } from "./docker.js";
import { startDashboard } from "./dashboard.js";
import { formatAge } from "./format.js";
import { paths } from "./paths.js";
import { getBackend, AGENT_NAMES, DEFAULT_AGENT } from "./agents/index.js";
import { resolvePersonaFile } from "./persona.js";
import { shellOptionsSchema } from "./shell-options.js";

/** Resolve agent name from mutually-exclusive boolean flags (--claude, --codex, etc.). */
function resolveAgent(options: Record<string, unknown>): { name: string; explicit: boolean } {
  const picked = AGENT_NAMES.filter((name) => options[name] === true);
  if (picked.length > 1) {
    throw new Error(`Only one agent flag allowed, got: ${picked.map((n) => `--${n}`).join(", ")}`);
  }
  return { name: picked[0] ?? DEFAULT_AGENT, explicit: picked.length > 0 };
}

const mgr = new SessionManager({ agentdHome: paths.home });

/**
 * ASCII banner shown above `agentd --help` (root help only, no subcommand).
 * Scoped to human consumers so machine/agent (MCP) output stays clean, and
 * colorized only on a TTY so piped help doesn't carry raw escape codes.
 */
const BANNER = [
  "                         _      _",
  "   __ _  __ _  ___ _ __ | |_ __| |",
  "  / _` |/ _` |/ _ \\ '_ \\| __/ _` |",
  " | (_| | (_| |  __/ | | | || (_| |",
  "  \\__,_|\\__, |\\___|_| |_|\\__\\__,_|",
  "        |___/",
].join("\n");

const cli = Cli.create("agentd", {
  version: "0.1.0",
  description: "Sandboxed AI coding agent sessions",
  banner: {
    render: () => (process.stdout.isTTY ? `\x1b[36m${BANNER}\x1b[0m` : BANNER),
    mode: "human",
  },
});

type SessionRow = {
  label: string;
  agent: string;
  status: string;
  containerId: string;
  age: string;
};

/**
 * Printed after the user detaches/exits a session. Tearing the container down
 * and persisting state.json takes a few seconds; this warns the user not to
 * Ctrl-C in the meantime (which could interrupt the state.json update).
 */
const SHUTDOWN_NOTICE = "\nShutting down, please wait a few seconds (don't press Ctrl-C)...\n";

const STATUS_DISPLAY: Record<string, string> = {
  running:    "\x1b[32m●\x1b[0m running",    // green
  suspended:  "\x1b[34m●\x1b[0m suspended",  // blue
  terminated: "\x1b[31m●\x1b[0m terminated", // red
  unknown:    "\x1b[33m●\x1b[0m unknown",    // yellow
};

function statusDisplay(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

/** Visible length of a string, ignoring ANSI escape sequences. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  ANSI_RE.lastIndex = 0;
  return s.replace(ANSI_RE, "").length;
}

const recentlyTerminated = new Map<string, SessionRow>();

function toRow(s: { label: string; agent: string; containerId: string; startedAt: string }, status: string): SessionRow {
  return { label: s.label, agent: s.agent, status, containerId: s.containerId?.slice(0, 12) ?? "", age: formatAge(s.startedAt) };
}

async function fetchSessionRows(forWatch = false): Promise<SessionRow[]> {
  const sessions = mgr.listSessions();
  let inspectFailure: string | undefined;
  const rows = await Promise.all(
    sessions.map(async (s) => {
      let state: ContainerState;
      try {
        state = await mgr.containerState(s.containerId);
      } catch (e) {
        inspectFailure ??= (e as Error).message;
        return toRow(s, "unknown");
      }
      if (state !== "running" && s.autoRemove) {
        // Capture before cancel() so the autoRemoved row stays visible briefly
        // in --watch after vanishing from listSessions.
        if (forWatch) recentlyTerminated.set(s.label, toRow(s, "terminated"));
        await mgr.cancel(s.label);
        return null;
      }
      const status = state === "running" ? "running"
        : state === "stopped" ? "suspended"
        : "terminated";
      return toRow(s, status);
    }),
  );
  const active = rows.filter((r) => r !== null);

  // Suppressed in --watch to avoid per-tick spam.
  if (inspectFailure && !forWatch) {
    process.stderr.write(`Warning: ${inspectFailure}\n`);
  }

  if (forWatch) {
    const terminated = [...recentlyTerminated.values()].filter(
      (t) => !active.some((a) => a.label === t.label),
    );
    return [...active, ...terminated];
  }
  return active;
}

function renderTable(rows: SessionRow[]): string {
  const headers = ["LABEL", "AGENT", "STATUS", "CONTAINER", "AGE"];
  const keys: (keyof SessionRow)[] = ["label", "agent", "status", "containerId", "age"];
  // For STATUS column, measure visible width (status values have ANSI codes when displayed).
  const displayed = rows.map((r) => keys.map((k) => {
    if (k === "status") return statusDisplay(r[k]);
    if (k === "label") return `\x1b[1m${r[k]}\x1b[0m`;
    return r[k];
  }));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...displayed.map((d) => visibleLength(d[i] as string))),
  );
  const padVisible = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleLength(s)));
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padVisible(h, widths[i] as number)).join("  "));
  for (const d of displayed) {
    lines.push(d.map((v, i) => padVisible(v as string, widths[i] as number)).join("  "));
  }
  return lines.join("\n");
}

cli.command("ls", {
  description: "List all active sessions",
  options: z.object({
    watch: z
      .boolean()
      .optional()
      .describe("Live-updating dashboard (refreshes every 2s)"),
  }),
  output: z.object({
    sessions: z.array(
      z.object({
        label: z.string(),
        agent: z.string(),
        status: z.string(),
        containerId: z.string(),
        age: z.string(),
      }),
    ),
    message: z.string().optional(),
  }),
  async run(c) {
    if (c.options.watch) {
      const INTERVAL_MS = 2000;
      const tick = async () => {
        const rows = await fetchSessionRows(true);
        const now = new Date().toLocaleTimeString();
        process.stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor to top
        if (rows.length === 0) {
          process.stdout.write(`agentd sessions  (${now})\n\nNo active sessions\n`);
        } else {
          process.stdout.write(`agentd sessions  (${now})\n\n${renderTable(rows)}\n`);
        }
      };
      let stopped = false;
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => {
          stopped = true;
          process.stdout.write("\n");
          resolve();
        });
        const loop = async () => {
          await tick();
          if (!stopped) setTimeout(loop, INTERVAL_MS);
        };
        loop();
      });
      return c.ok({ sessions: [] });
    }

    const active = await fetchSessionRows();
    if (active.length === 0) {
      return c.ok({ sessions: [], message: "No active sessions" });
    }
    return c.ok({ sessions: active });
  },
});

cli.command("cancel", {
  description: "Cancel a session and remove its container",
  args: z.object({
    label: z.string().describe("Session label to cancel"),
  }),
  output: z.object({
    label: z.string(),
    cancelled: z.boolean(),
  }),
  examples: [
    { args: { label: "my-project" }, description: "Cancel a session" },
  ],
  async run(c) {
    const session = mgr.getSession(c.args.label);
    if (!session) {
      return c.error({
        code: "NOT_FOUND",
        message: `No session found for: ${c.args.label}`,
        retryable: false,
      });
    }
    await mgr.cancel(c.args.label);
    return c.ok({ label: c.args.label, cancelled: true });
  },
});

cli.command("shell", {
  description: "Sandboxed coding agent session (label defaults to current folder name)",
  args: z.object({
    name: z
      .string()
      .optional()
      .describe("Session label (defaults to current folder name, e.g. 'my-project')"),
  }),
  options: shellOptionsSchema,
  output: z.object({
    label: z.string(),
    agent: z.string(),
    status: z.string(),
    containerId: z.string(),
    sessionId: z.string().optional(),
    model: z.string().optional(),
    mounts: z.array(z.string()).optional(),
    ports: z.array(z.string()).optional(),
    dockerCmd: z.string().optional(),
    script: z.string().optional(),
  }),
  examples: [
    { description: "Quick session in current dir (Claude by default)" },
    {
      options: { claude: true },
      description: "Explicit Claude session",
    },
    {
      options: { codex: true },
      description: "Use OpenAI Codex instead of Claude",
    },
    {
      options: { model: "opus" },
      description: "Use opus model",
    },
    {
      options: { rm: true },
      description: "Throwaway session, auto-cleanup on exit",
    },
    {
      args: { name: "obsidian" },
      options: { mount: ["~/obsidian:/workspace"], secret: ["claude"] },
      description: "Named session with custom mount",
    },
  ],
  async run(c) {
    const agent = resolveAgent(c.options);
    const agentName = agent.name;
    const backend = getBackend(agentName);

    const cwd = process.cwd();
    const rm = c.options.rm ?? false;
    const noMount = c.options["skip-mount"] === true;
    const extraMounts = c.options.mount ?? [];

    // --mount replaces default cwd mount; --skip-mount disables all default mounts
    const mounts = (noMount || extraMounts.length > 0)
      ? extraMounts.map(normalizeMount)
      : [`${cwd}:/workspace`];

    const noPorts = c.options["skip-ports"] === true;
    const extraPorts = c.options.port ?? [];
    // --port replaces default; --skip-ports disables all
    const ports = (noPorts || extraPorts.length > 0)
      ? extraPorts
      : ["3000"];

    const name = c.args.name ?? cwdName();
    const secrets = c.options.secret
      ?? (backend.requiresAuth === false || mgr.hasCredentials(backend) ? [] : [backend.defaultSecretScope]);

    const existing = mgr.getSession(name);
    if (existing) {
      const conflicts: string[] = [];
      if (agent.explicit && agentName !== existing.agent) {
        conflicts.push(`agent: existing session uses ${existing.agent}, wanted ${agentName}`);
      }
      if (c.options.model != null && c.options.model !== existing.model) {
        const has = existing.model ?? "default";
        conflicts.push(`model: existing session uses ${has}, wanted ${c.options.model}`);
      }
      // Theme is host-derived, not a flag, so evaluate it against the session's
      // own backend. A bare resume defaults the agent, so reading the theme from
      // `backend` would compare e.g. a pi session (no theme) against Claude's.
      const existingTheme = await getBackend(existing.agent).explicitHostTheme?.();
      if (existingTheme != null && existingTheme !== existing.theme) {
        conflicts.push(`theme: existing session uses ${existing.theme ?? "none"}, wanted ${existingTheme}`);
      }
      if (c.options.rm != null && rm !== existing.autoRemove) {
        const has = existing.autoRemove ? "auto-remove" : "persistent";
        conflicts.push(`rm: existing session is ${has}`);
      }
      if (c.options.secret != null && !arraysEqual(existing.secrets ?? [], secrets)) {
        const has = (existing.secrets ?? []).length > 0 ? (existing.secrets ?? []).join(", ") : "none";
        conflicts.push(`secrets: existing session has [${has}], wanted [${secrets.join(", ")}]`);
      }
      if ((c.options.mount != null || c.options["skip-mount"] != null) && !arraysEqual(existing.mounts ?? [], mounts)) {
        conflicts.push(`mounts: existing session has different mounts`);
      }
      if ((c.options.port != null || c.options["skip-ports"] != null) && !arraysEqual(existing.ports ?? [], ports)) {
        conflicts.push(`ports: existing session has [${(existing.ports ?? []).join(", ")}], wanted [${ports.join(", ")}]`);
      }
      // Resolve against the existing session's agent, and skip entirely for
      // backends that don't support a persona (e.g. aider never stores one,
      // so any --persona/--no-persona request is a no-op, not a conflict).
      if (
        getBackend(existing.agent).personaContainerPath
        && (c.options.persona != null || c.options["no-persona"] === true)
      ) {
        const wanted = resolvePersonaFile(
          { agent: existing.agent, explicitPath: c.options.persona, disabled: c.options["no-persona"] },
          paths,
        );
        if (wanted !== existing.persona) {
          conflicts.push(`persona: existing session uses ${existing.persona ?? "none"}, wanted ${wanted ?? "none"}`);
        }
      }
      if (conflicts.length > 0) {
        throw new Error(
          `Session "${name}" exists with different options:\n`
            + conflicts.map((msg) => `  - ${msg}`).join("\n") + "\n"
            + `Options:\n`
            + `  Resume as-is:    agentd shell ${name}\n`
            + `  Cancel (loses unsaved work and conversation): agentd cancel ${name}`,
        );
      }
      // attach() throws if the container is missing or the daemon is unreachable.
      const sessionId = existing.transcriptsKey;
      try {
        await mgr.attach(name);
        process.stderr.write(SHUTDOWN_NOTICE);
      } finally {
        if (existing.autoRemove) {
          await mgr.cancel(name);
        }
      }
      const status = existing.autoRemove
        ? "removed"
        : await resolveStatus(mgr, existing.containerId);
      return c.ok({
        label: name, agent: existing.agent, status,
        containerId: existing.containerId.slice(0, 12), sessionId,
      });
    }

    const model = c.options.model ?? backend.defaultModel;
    const spawnOpts = {
      name, backend, mounts, secrets, ports, model, rm,
      persona: c.options.persona,
      noPersona: c.options["no-persona"],
    };

    if (c.options["dry-run"]) {
      const { dockerArgs, script } = await mgr.buildSpawnCommand(spawnOpts);
      const dockerCmd = formatDockerCmd(dockerArgs);
      return c.ok({
        label: name, agent: agentName, status: "dry-run", containerId: "(dry-run)", model,
        mounts: mounts.length > 0 ? mounts : undefined,
        ports: ports.length > 0 ? ports : undefined,
        dockerCmd, script,
      });
    }

    // transcriptsKey is the stable session id; spawnInteractive hands it back so
    // we don't re-read state.json (which --rm's later cancel would drop anyway).
    const { containerId, transcriptsKey: sessionId } = await mgr.spawnInteractive(spawnOpts);
    try {
      await mgr.attach(name);
      process.stderr.write(SHUTDOWN_NOTICE);
    } finally {
      if (rm) {
        await mgr.cancel(name);
      }
    }
    const status = rm
      ? "removed"
      : await resolveStatus(mgr, containerId);
    return c.ok({
      label: name, agent: agentName, status,
      containerId: containerId.slice(0, 12), sessionId,
    });
  },
});

cli.command("code", {
  description: "Open a running session in VS Code (Dev Containers)",
  args: z.object({
    label: z
      .string()
      .optional()
      .describe("Session label (defaults to current directory name)"),
  }),
  output: z.object({
    label: z.string(),
    containerId: z.string(),
  }),
  examples: [
    {
      description: "Open current directory's session in VS Code",
    },
    {
      args: { label: "obsidian" },
      description: "Open named session in VS Code",
    },
  ],
  async run(c) {
    const label = c.args.label ?? cwdName();
    const session = mgr.getSession(label);
    if (!session?.containerId) {
      return c.error({
        code: "NOT_FOUND",
        message: `No session found for: ${label}`,
        retryable: false,
      });
    }
    const running = await mgr.isContainerRunning(session.containerId);
    if (!running) {
      return c.error({
        code: "NOT_RUNNING",
        message: `Container not running. Resume first: agentd shell ${label}`,
        retryable: false,
      });
    }
    const { execFileSync } = await import("node:child_process");
    const hex = Buffer.from(session.containerId).toString("hex");
    const uri =
      `vscode-remote://attached-container+${hex}/workspace`;
    try {
      execFileSync("code", ["--folder-uri", uri], { stdio: "inherit" });
    } catch {
      return c.error({
        code: "VSCODE_NOT_FOUND",
        message: `VS Code CLI ("code") not found. Install it from VS Code: Cmd+Shift+P → "Shell Command: Install 'code' command"`,
        retryable: false,
      });
    }
    return c.ok({
      label,
      containerId: session.containerId.slice(0, 12),
    });
  },
});

cli.command("serve", {
  description: "Read-only web dashboard for active sessions (localhost only)",
  options: z.object({
    port: z
      .string()
      .optional()
      .describe("Port to bind on 127.0.0.1 (default 8787)"),
    "skip-open": z
      .boolean()
      .optional()
      .describe("Don't open the dashboard in your browser (opens by default)"),
  }),
  output: z.object({
    url: z.string(),
  }),
  examples: [
    { description: "Start the dashboard (opens in your browser)" },
    { description: "Start without launching a browser", options: { "skip-open": true } },
  ],
  async run(c) {
    const port = c.options.port != null ? Number(c.options.port) : 8787;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.error({
        code: "INVALID_PORT",
        message: `Invalid --port: ${c.options.port}`,
        retryable: false,
      });
    }

    let handle;
    try {
      handle = await startDashboard(mgr, { port });
    } catch (e) {
      return c.error({
        code: "LISTEN_FAILED",
        message: `Could not start dashboard on port ${port}: ${(e as Error).message}`,
        retryable: false,
      });
    }

    process.stdout.write(`agentd dashboard → ${handle.url}  (read-only, Ctrl-C to stop)\n`);
    if (c.options["skip-open"] !== true) openBrowser(handle.url);

    await new Promise<void>((resolveWait) => {
      process.once("SIGINT", () => {
        process.stdout.write("\n");
        resolveWait();
      });
    });
    await handle.close();
    return c.ok({ url: handle.url });
  },
});

cli.serve();

export default cli;

function cwdName(): string {
  const raw = process.cwd().split("/").pop() ?? "shell";
  return slugify(raw);
}

/** Convert a string to a valid Docker container name / session label. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "shell";
}

async function resolveStatus(mgr: SessionManager, containerId: string): Promise<string> {
  // After detach the container may still be "running" for a brief moment
  // while Docker tears it down.  Poll a few times so we report the settled
  // state rather than a stale intermediate.
  for (let i = 0; i < 5; i++) {
    if (await mgr.containerState(containerId) !== "running") return "suspended";
    await new Promise((r) => setTimeout(r, 200));
  }
  return "running (background)";
}

/** Shell-quote a single argument if it contains special characters. */
function shellQuote(arg: string): string {
  return /[^a-zA-Z0-9_./:=@-]/.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg;
}

/**
 * Format docker create args for readable shell output.
 * Groups flags (--flag value) on the same line, one group per line.
 */
function formatDockerCmd(args: string[]): string {
  const groups: string[] = [];
  for (let i = 0; i < args.length;) {
    const arg = args[i] as string;
    const next = args[i + 1];
    if (arg.startsWith("-") && next != null && !next.startsWith("-")) {
      groups.push(`${shellQuote(arg)} ${shellQuote(next)}`);
      i += 2;
    } else {
      groups.push(shellQuote(arg));
      i++;
    }
  }
  return `docker create \\\n  ${groups.join(" \\\n  ")}`;
}

/**
 * Normalize a --mount value:
 *  - Bare path (no ":") → resolve to absolute, map to /workspace
 *  - host:container → resolve host to absolute
 *  - host:container:ro → resolve host to absolute, preserve :ro
 */
function normalizeMount(mount: string): string {
  const colon = mount.indexOf(":");
  if (colon === -1) {
    return `${resolve(mount)}:/workspace`;
  }
  return `${resolve(mount.slice(0, colon))}:${mount.slice(colon + 1)}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
}

/** Open a URL in the host's default browser (best effort, non-blocking). */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // ENOENT (e.g. no xdg-open on a headless host) surfaces as an async
    // 'error' event; swallow it so serving keeps working without a browser.
    child.on("error", () => { /* no browser opener available */ });
    child.unref();
  } catch { /* best effort */ }
}
