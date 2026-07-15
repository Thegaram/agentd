import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";

import {
  dockerListStates,
  dockerStats,
  type ContainerState,
} from "./docker.js";
import { formatAge } from "./format.js";
import { PORT_MAPPING_ARROW, shortenMountPath } from "./session.js";
import type { SessionManager } from "./session.js";
import type { SessionState } from "./schema.js";

export interface PortView {
  container: string;
  host: string;
  /** http://localhost:<host> when a host port is published, else "". */
  url: string;
}

export interface MountView {
  display: string;
  path: string;
  ro: boolean;
}

export interface SessionView {
  label: string;
  agent: string;
  model?: string | undefined;
  status: "running" | "idle" | "suspended" | "terminated" | "unknown" | "loading";
  age: string;
  startedAt: string;
  autoRemove: boolean;
  containerId: string;
  ports: PortView[];
  mounts: MountView[];
  secrets: string[];
  /**
   * Basename of the agent's native credential file when one is mounted
   * (e.g. "claude-oauth.json"). The dashboard never reads the file — this is
   * the filename only, surfaced so the card shows every secret mounted into the
   * sandbox, not just user `--secret` env scopes.
   */
  credentialName?: string | undefined;
  /** Live CPU%, running containers only (e.g. "0.20%"). */
  cpu?: string | undefined;
  /** Live memory in use, running containers only (e.g. "45.2MiB"). */
  mem?: string | undefined;
  /** Relative time since the transcript bucket last changed (e.g. "2m"). */
  lastActivity?: string | undefined;
  /** Epoch ms of the last transcript change (monotonic; for idle-notification detection). */
  lastActivityMs?: number | undefined;
  /** Most recent agent action summarized from the transcript. */
  lastLine?: string | undefined;
  /** Current context-window occupancy in tokens (transcript-backed; Claude only). */
  contextTokens?: number | undefined;
  /** Context occupancy as a percentage of the model's window. */
  contextPct?: number | undefined;
  /** Estimated cumulative cost in USD at API rates (transcript-backed; Claude only). */
  costUsd?: number | undefined;
}

/**
 * Parse a session's port info into a display model. Prefers the resolved
 * host mappings (e.g. "3000→49152"); falls back to the requested container
 * ports (no host URL, e.g. while suspended).
 */
export function parsePorts(resolved: string[], requested: string[]): PortView[] {
  if (resolved.length > 0) {
    return resolved.map((entry) => {
      const [container, host] = entry.split(PORT_MAPPING_ARROW);
      return {
        container: container ?? entry,
        host: host ?? "",
        url: host ? `http://localhost:${host}` : "",
      };
    });
  }
  return requested.map((p) => {
    const parts = p.split(":");
    const container = parts[parts.length - 1] ?? p;
    return { container, host: "", url: "" };
  });
}

/** Parse "host:container" / "host:container:ro" mount specs into a display model. */
export function parseMounts(mounts: string[]): MountView[] {
  return mounts.map((m) => {
    const ro = m.endsWith(":ro");
    const body = ro ? m.slice(0, -3) : m;
    const host = body.split(":")[0] ?? body;
    return { display: shortenMountPath(host), path: host, ro };
  });
}

/**
 * Reject requests whose Host header isn't loopback. Combined with binding to
 * 127.0.0.1, this defeats DNS-rebinding attacks (a remote page resolving its
 * own domain to 127.0.0.1 to reach this server from the victim's browser).
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  const bracketed = host.match(/^\[(.+)\]/); // [::1] or [::1]:8787
  if (bracketed) {
    host = bracketed[1] as string;
  } else if (host.split(":").length === 2) {
    // host:port for IPv4/names; a bare IPv6 (e.g. ::1) has >2 colon parts
    host = host.split(":")[0] as string;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** One-line hint describing a tool_use entry, e.g. "Bash: npm test". */
function toolSnippet(item: { name?: unknown; input?: unknown }): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  const input = (item.input ?? {}) as Record<string, unknown>;
  const hintKey = ["command", "description", "file_path", "path", "pattern", "url", "query"].find(
    (k) => typeof input[k] === "string" && (input[k] as string).trim() !== "",
  );
  const hint = hintKey ? collapseWs(input[hintKey] as string) : "";
  return hint ? `${name}: ${hint}` : name;
}

interface TranscriptEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function snippetFromEntry(entry: TranscriptEntry): string | undefined {
  const content = entry?.message?.content;
  if (typeof content === "string") {
    return collapseWs(content) || undefined;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const tools: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const text = it["text"];
      if (it["type"] === "text" && typeof text === "string" && text.trim() !== "") {
        texts.push(collapseWs(text));
      } else if (it["type"] === "tool_use") {
        tools.push(toolSnippet(it as { name?: unknown; input?: unknown }));
      }
    }
    if (texts.length) return collapseWs(texts.join(" "));
    if (tools.length) return `→ ${tools.join(", ")}`;
  }
  return undefined;
}

/**
 * Most recent human-readable activity from a transcript JSONL tail: the last
 * assistant text, or failing that the last tool call. Walks lines from the end
 * and skips entries that yield nothing (tool results, system, parse failures).
 */
export function summarizeTranscriptTail(jsonl: string, max = 280): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const snippet = snippetFromEntry(entry);
    if (snippet) return snippet.length > max ? `${snippet.slice(0, max - 1)}…` : snippet;
  }
  return undefined;
}

/**
 * Heuristic from the transcript tail: is the agent waiting for the user (idle)
 * rather than mid-task? True when the last conversational entry is a completed
 * assistant turn (text, no pending tool_use), OR when there's no in-progress
 * turn at all (a fresh or `/clear`-ed conversation — the agent sits at the
 * prompt waiting for you). False when the last entry is a user message, a tool
 * result, or a pending tool call (work in flight).
 *
 * Sidechain (subagent) entries are skipped so a finished subagent line doesn't
 * mask the main thread still working.
 */
export function isAwaitingUser(jsonl: string): boolean {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: TranscriptEntry & { isSidechain?: unknown };
    try {
      entry = JSON.parse(line) as TranscriptEntry & { isSidechain?: unknown };
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const role = entry.message?.role ?? entry.type;
    if (role !== "assistant" && role !== "user") continue; // skip system/summary/etc.
    if (role === "user") return false; // user prompt or tool_result → agent will act next
    // Assistant turn: idle unless it dispatched a tool (work still pending).
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && (item as Record<string, unknown>)["type"] === "tool_use") {
          return false;
        }
      }
    }
    return true;
  }
  return true; // no in-progress turn found (cleared/fresh) → awaiting the user
}

/**
 * Current context-window occupancy (prompt tokens) from the most recent usage
 * entry in the transcript tail: input + cached prompt tokens. Undefined if no
 * usage is present.
 */
export function contextTokensFromTail(jsonl: string): number | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: { message?: { usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(line) as { message?: { usage?: Record<string, unknown> } };
    } catch {
      continue;
    }
    const u = entry.message?.usage;
    if (u && typeof u === "object") {
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
      if (total > 0) return total;
    }
  }
  return undefined;
}

/** Context window size implied by a model name ("…[1m]" → 1M, else 200k). */
export function contextWindowSize(model: string | undefined): number {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}

export interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Per-million-token list pricing (Claude API rates, cached 2026-06-04).
 * Cache writes bill at 1.25× input (5-min TTL); cache reads at 0.1× input.
 */
const PRICING = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

/** Map a model name to its pricing family (defaults to opus). */
export function pricingForModel(model: string | undefined): ModelPricing {
  const m = (model ?? "").toLowerCase();
  if (m.includes("haiku")) return PRICING.haiku;
  if (m.includes("sonnet")) return PRICING.sonnet;
  return PRICING.opus;
}

/**
 * Estimate cumulative session cost (USD) by summing usage across all assistant
 * turns in the transcript. Cache writes bill at 1.25× input, reads at 0.1×.
 */
export function computeTranscriptCostUsd(jsonl: string, pricing: ModelPricing): number {
  let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { message?: { usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(trimmed) as { message?: { usage?: Record<string, unknown> } };
    } catch {
      continue;
    }
    const u = entry.message?.usage;
    if (!u || typeof u !== "object") continue;
    const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
    input += n("input_tokens");
    output += n("output_tokens");
    cacheWrite += n("cache_creation_input_tokens");
    cacheRead += n("cache_read_input_tokens");
  }
  const inRate = pricing.input / 1_000_000;
  const outRate = pricing.output / 1_000_000;
  return input * inRate + output * outRate + cacheWrite * inRate * 1.25 + cacheRead * inRate * 0.1;
}

/** One transcript turn for the peek view. */
export interface TranscriptTurn {
  role: string;
  text: string;
}

/** Recent conversational turns (most recent last) for the click-to-peek view. */
export function recentTurns(jsonl: string, n = 14, max = 400): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: TranscriptEntry & { isSidechain?: unknown };
    try {
      entry = JSON.parse(trimmed) as TranscriptEntry & { isSidechain?: unknown };
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const role = entry.message?.role ?? entry.type;
    if (role !== "assistant" && role !== "user") continue;
    const text = snippetFromEntry(entry);
    if (!text) continue;
    out.push({ role, text: text.length > max ? `${text.slice(0, max - 1)}…` : text });
  }
  return out.slice(-n);
}

/** Read up to the last maxBytes of a file (for cheaply tailing large transcripts). */
function readTail(path: string, maxBytes = 65536): string | undefined {
  let fd: number | undefined;
  try {
    const opened = openTranscriptFile(path);
    fd = opened.fd;
    const size = opened.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    // Honor the byte count: if the agent truncates the file between fstat and
    // read, the unread tail of an allocUnsafe buffer is stale heap memory —
    // stringify only what was actually read.
    const read = readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Open a transcript without following symlinks (O_NOFOLLOW) and confirm it's a
 * regular file via the fd. O_NONBLOCK ensures that if the agent swaps the file
 * for a FIFO/device, the open returns immediately instead of blocking the event
 * loop; the isFile() check then rejects it (O_NONBLOCK is a no-op on regular files).
 */
function openTranscriptFile(path: string): { fd: number; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new Error("not a regular file");
  }
  return { fd, size: st.size };
}

function readTranscriptFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const opened = openTranscriptFile(path);
    fd = opened.fd;
    const size = opened.size;
    const buf = Buffer.allocUnsafe(size);
    // Honor the byte count (see readTail): never stringify the uninitialized
    // tail of the buffer if the file shrank between fstat and read.
    const read = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
    return buf.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Cache of cumulative cost keyed by transcript path, invalidated on mtime/size change. */
const costCache = new Map<string, { mtimeMs: number; size: number; costUsd: number }>();

/** Path + stat of the newest .jsonl transcript in a bucket. */
function newestTranscript(dir: string): { path: string; mtimeMs: number; size: number } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number; size: number } | undefined;
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    try {
      const st = lstatSync(join(dir, e));
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { path: join(dir, e), mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch { /* skip */ }
  }
  return best;
}

/** Newest transcript's recent turns (for the peek view). */
function newestTranscriptTurns(dir: string): TranscriptTurn[] {
  const newest = newestTranscript(dir);
  if (!newest) return [];
  const tail = readTail(newest.path, 131072);
  return tail ? recentTurns(tail) : [];
}

function transcriptInfo(dir: string, model: string | undefined): {
  mtimeMs?: number | undefined;
  line?: string | undefined;
  idle?: boolean | undefined;
  contextTokens?: number | undefined;
  costUsd?: number | undefined;
} {
  const newest = newestTranscript(dir);
  if (!newest) return {};
  const content = readTail(newest.path);

  // Cost needs the full file; cache it by mtime+size so we only re-read on growth.
  let costUsd: number | undefined;
  const cached = costCache.get(newest.path);
  if (cached && cached.mtimeMs === newest.mtimeMs && cached.size === newest.size) {
    costUsd = cached.costUsd;
  } else {
    try {
      const full = readTranscriptFile(newest.path);
      if (full !== undefined) {
        costUsd = computeTranscriptCostUsd(full, pricingForModel(model));
        costCache.set(newest.path, { mtimeMs: newest.mtimeMs, size: newest.size, costUsd });
      }
    } catch { /* leave undefined */ }
  }

  return {
    mtimeMs: newest.mtimeMs,
    line: content ? summarizeTranscriptTail(content) : undefined,
    // content != null distinguishes a readable-but-empty transcript (fresh
    // session → awaiting user → idle) from an unreadable one (undefined → unknown).
    idle: content != null ? isAwaitingUser(content) : undefined,
    contextTokens: content ? contextTokensFromTail(content) : undefined,
    costUsd,
  };
}

/** The fields of a SessionView derived purely from state.json (no Docker/transcript). */
function baseView(s: SessionState) {
  return {
    label: s.label,
    agent: s.agent,
    model: s.model,
    age: formatAge(s.startedAt),
    startedAt: s.startedAt,
    autoRemove: s.autoRemove ?? false,
    containerId: s.containerId.slice(0, 12),
    ports: parsePorts(s.resolvedPorts ?? [], s.ports ?? []),
    mounts: parseMounts(s.mounts ?? []),
    secrets: s.secrets ?? [],
    // Basename only — never the file contents (see SessionView.credentialName).
    credentialName: s.credential ? basename(s.credential) : undefined,
  };
}

/**
 * Synchronous view built purely from state.json — no Docker or filesystem
 * calls, so it returns instantly. Status is "loading" until the enriched
 * `collectSessionViews` response arrives; powers the dashboard's first paint.
 */
export function buildStaticViews(mgr: SessionManager): SessionView[] {
  return mgr.listSessions().map((s) => ({ ...baseView(s), status: "loading" }));
}

/** A running session whose transcript has been quiet this long is treated as idle. */
const IDLE_STALE_MS = 60_000;

/**
 * Build the read-only view of all sessions. Performs no mutations — unlike
 * `agentd ls`, it never cancels terminated auto-remove sessions.
 *
 * Status and CPU/mem are gathered in two batched Docker calls (`ps` + `stats`)
 * rather than one inspect per session. Per-session screen capture is the only
 * unavoidable fan-out, and only for running containers.
 */
export async function collectSessionViews(mgr: SessionManager): Promise<SessionView[]> {
  const sessions = mgr.listSessions();
  if (sessions.length === 0) return [];

  const [statesResult, stats] = await Promise.all([
    dockerListStates()
      .then((map) => ({ ok: true, map }))
      .catch(() => ({ ok: false, map: new Map<string, ContainerState>() })),
    dockerStats(),
  ]);

  return Promise.all(
    sessions.map(async (s): Promise<SessionView> => {
      const raw = statesResult.map.get(s.containerId);
      let status: SessionView["status"] =
        !statesResult.ok ? "unknown"
        : raw === "running" ? "running"
        : raw === "stopped" ? "suspended"
        : "terminated";

      const stat = status === "running" ? stats.get(s.containerId.slice(0, 12)) : undefined;

      // "Last activity" and "last line" both come from the transcript JSONL,
      // not the tmux pane: capturing the pane only yields the agent's rendered
      // UI chrome (e.g. its mode footer), not what it actually did. The same
      // tail tells us whether a running agent is idle (awaiting the user).
      let lastActivity: string | undefined;
      let lastActivityMs: number | undefined;
      let lastLine: string | undefined;
      let contextTokens: number | undefined;
      let contextPct: number | undefined;
      let costUsd: number | undefined;
      // These parsers understand Claude Code's JSONL only. Every backend now
      // persists a transcriptsKey bucket, but reading another agent's format
      // (e.g. pi's flat *.jsonl) would yield garbage — so gate on Claude.
      if (s.agent === "claude" && s.transcriptsKey) {
        const info = transcriptInfo(mgr.transcriptsHostDir(s.transcriptsKey), s.model);
        if (info.mtimeMs !== undefined) {
          lastActivity = formatAge(new Date(info.mtimeMs).toISOString());
          lastActivityMs = info.mtimeMs;
        }
        lastLine = info.line;
        // A running container is idle when the transcript says the agent finished
        // its turn, OR when the transcript has gone quiet for a while — it's waiting,
        // not working (e.g. after /clear, where the transcript shape isn't conclusive).
        // The one false-positive is a long silent tool call; it self-corrects on the
        // agent's next write.
        if (status === "running") {
          const quiet = lastActivityMs != null && Date.now() - lastActivityMs > IDLE_STALE_MS;
          if (info.idle === true || quiet) status = "idle";
        }
        contextTokens = info.contextTokens;
        if (contextTokens !== undefined) {
          contextPct = Math.min(100, Math.round((contextTokens / contextWindowSize(s.model)) * 100));
        }
        costUsd = info.costUsd;
      }

      return {
        ...baseView(s),
        status,
        cpu: stat?.cpu,
        mem: stat?.mem,
        lastActivity,
        lastActivityMs,
        lastLine,
        contextTokens,
        contextPct,
        costUsd,
      };
    }),
  );
}

export interface DashboardHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * Start the read-only dashboard HTTP server, bound to loopback only.
 * Resolves once it's listening, with the URL and a close() handle.
 */
export function startDashboard(
  mgr: SessionManager,
  opts: { port: number; host?: string } = { port: 8787 },
): Promise<DashboardHandle> {
  const host = opts.host ?? "127.0.0.1";

  const server: Server = createServer(async (req, res) => {
    // Defense in depth on top of the loopback bind.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(PAGE);
      return;
    }

    if (req.url === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(ICON_SVG);
      return;
    }

    if (req.url && (req.url === "/api/sessions" || req.url.startsWith("/api/sessions?"))) {
      try {
        // ?quick=1 returns the instant state.json-only view (no Docker/fs).
        const quick = new URL(req.url, "http://localhost").searchParams.get("quick") === "1";
        const sessions = quick ? buildStaticViews(mgr) : await collectSessionViews(mgr);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ sessions, now: new Date().toISOString() }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (req.url && (req.url === "/api/transcript" || req.url.startsWith("/api/transcript?"))) {
      try {
        const label = new URL(req.url, "http://localhost").searchParams.get("label") ?? "";
        const session = mgr.getSession(label);
        // Claude-only: newestTranscriptTurns parses Claude's JSONL shape.
        const turns = session && session.agent === "claude" && session.transcriptsKey
          ? newestTranscriptTurns(mgr.transcriptsHostDir(session.transcriptsKey))
          : [];
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ label, turns }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        url: `http://${host}:${port}`,
        // closeAllConnections() drops lingering keep-alive sockets (e.g. an open
        // dashboard tab polling every 2s); without it server.close() blocks until
        // those drain, so Ctrl-C appears to need a second press to force-quit.
        close: () => new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  });
}

// Brand mark — served at /icon.svg, used as the favicon and notification icon.
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="7" fill="#ff8700"/>'
  + '<circle cx="16" cy="16" r="6" fill="#16181c"/></svg>';

// Self-contained page: no external fonts/CDN, all session-derived strings go
// through textContent/DOM APIs (never innerHTML) so labels/paths can't inject
// markup. Client JS avoids template literals and ${...} so this whole string
// stays a plain template literal with no escaping.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/icon.svg">
<title>agentd</title>
<script>
  // Resolve theme before first paint to avoid a flash.
  (function () {
    try {
      var saved = localStorage.getItem("agentd-theme");
      var theme = saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      document.documentElement.setAttribute("data-theme", theme);
    } catch (e) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  })();
</script>
<style>
  :root {
    --bg: #16181c; --panel: #1d2025; --line: #2a2e36; --fg: #e6e8eb;
    --dim: #8b919b; --accent: #ff8700; --chip-bg: #16181c;
    --running: #46c46a; --idle: #e8b93e; --suspended: #5aa6e8; --terminated: #e25555; --unknown: #e0b341;
  }
  :root[data-theme="light"] {
    --bg: #f4f6f9; --panel: #ffffff; --line: #e2e5ea; --fg: #1b1e24;
    --dim: #6b7280; --accent: #c96a08; --chip-bg: #f0f2f5;
    --running: #1a9c46; --idle: #b5840a; --suspended: #2f7fd1; --terminated: #cf3b3b; --unknown: #b07d12;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-height: 100vh; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--bg); z-index: 1;
  }
  .brand {
    background: var(--accent); color: #1a1a1a; font-weight: 700;
    padding: 2px 8px; border-radius: 4px; letter-spacing: .5px; font-size: 12px;
  }
  .title { font-weight: 600; }
  .counts { color: var(--dim); }
  .spacer { flex: 1; }
  .updated { color: var(--dim); font-size: 12px; }
  .updated.stale { color: var(--terminated); }
  .toggle {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 4px 9px; cursor: pointer; font: inherit; font-size: 14px;
  }
  .toggle:hover { border-color: var(--accent); }
  .toggle svg, .pin svg { display: block; }
  .toggle.off { color: var(--dim); }
  .toggle.warn { color: var(--unknown); border-color: var(--unknown); }
  .cols { display: inline-flex; align-items: center; gap: 5px; color: var(--dim); font-size: 12px; }
  .cols button {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; width: 26px; height: 28px; cursor: pointer; font: inherit; line-height: 1;
  }
  .cols button:hover { border-color: var(--accent); }
  .cols #cols-n { min-width: 12px; text-align: center; }
  .search {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 13px; width: 130px;
    transition: width .15s ease, border-color .12s ease;
  }
  .search:focus { outline: none; border-color: var(--accent); width: 200px; }
  .peek { background: none; border: none; cursor: pointer; padding: 0 2px; flex: none;
    font-size: 13px; line-height: 1; opacity: .45; }
  .peek:hover { opacity: 1; }
  .peek-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; z-index: 10; padding: 20px;
  }
  .peek-overlay[hidden] { display: none; }
  .peek-panel {
    background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
    width: 100%; max-width: 760px; max-height: 80vh; display: flex; flex-direction: column;
  }
  .peek-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .peek-title { font-weight: 600; }
  .peek-head .toggle { margin-left: auto; }
  .peek-body { overflow-y: auto; padding: 8px 16px 16px; }
  .turn { padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  .turn:last-child { border-bottom: none; }
  .turn .who { color: var(--dim); text-transform: uppercase; font-size: 11px; letter-spacing: .5px; margin-right: 8px; }
  .turn.assistant .who { color: var(--accent); }
  main {
    padding: 16px 20px; max-width: 1400px; margin: 0 auto; width: 100%;
    flex: 1 0 auto;
    display: grid; gap: 12px; align-content: start;
    grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
  }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 14px 16px; transition: border-color .12s ease;
  }
  .card:hover { border-color: var(--accent); }
  .card.pinned { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pin {
    background: none; border: none; cursor: pointer; padding: 0 2px; flex: none;
    color: var(--dim); line-height: 0;
  }
  .pin:hover { color: var(--fg); }
  .pin.on { color: var(--accent); }
  .row1 { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .label {
    font-weight: 600; font-size: 15px;
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .submeta {
    color: var(--dim); font-size: 13px; margin-top: 3px;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .status { flex: none; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .detail { margin-top: 10px; display: grid; grid-template-columns: 60px 1fr; gap: 4px 12px; font-size: 13px; }
  .k { color: var(--dim); }
  .v { word-break: break-all; }
  a.port { color: var(--accent); text-decoration: none; }
  a.port:hover { text-decoration: underline; }
  .chip {
    display: inline-block; background: var(--chip-bg); border: 1px solid var(--line);
    border-radius: 4px; padding: 0 6px; margin-right: 6px; color: var(--dim); font-size: 12px;
  }
  .badge-rm { color: var(--terminated); border-color: var(--terminated); margin-right: 0; }
  .ro { color: var(--unknown); }
  .expandable { cursor: pointer; border-bottom: 1px dotted var(--dim); }
  .expandable:hover { border-bottom-color: var(--accent); }
  .screenline { color: var(--dim); white-space: pre-wrap; }
  .usage .n { color: var(--fg); }
  .empty { grid-column: 1 / -1; color: var(--dim); padding: 48px 0; text-align: center; }
  footer { color: var(--dim); font-size: 12px; padding: 12px 20px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<header>
  <span class="brand">SANDBOXED</span>
  <span class="title">agentd</span>
  <span class="counts" id="counts"></span>
  <span class="spacer"></span>
  <input class="search" id="search" type="search" placeholder="search…" autocomplete="off" spellcheck="false" aria-label="Search sessions">
  <span class="updated" id="updated">connecting…</span>
  <span class="cols" aria-label="Columns per row">
    <button id="cols-dec" title="Fewer columns" aria-label="Fewer columns">−</button>
    <span id="cols-n">3</span>
    <button id="cols-inc" title="More columns" aria-label="More columns">+</button>
  </span>
  <button class="toggle" id="notify-toggle" title="Idle notifications" aria-label="Toggle idle notifications"></button>
  <button class="toggle" id="theme-toggle" title="Toggle light / dark" aria-label="Toggle theme"></button>
</header>
<main id="list"></main>
<footer>read-only · localhost only · refreshes every 2s</footer>
<div class="peek-overlay" id="peek" hidden>
  <div class="peek-panel">
    <div class="peek-head">
      <span class="peek-title" id="peek-title"></span>
      <button class="toggle" id="peek-close" aria-label="Close">✕</button>
    </div>
    <div class="peek-body" id="peek-body"></div>
  </div>
</div>
<script>
"use strict";
// Minimal monochrome icons (inherit color via currentColor). Constant markup — safe as innerHTML.
var SVG_PIN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
var SVG_BELL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>';
var SVG_BELL_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/><path d="M3.5 3.5l17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
var STATUS_COLOR = {
  running: "var(--running)", idle: "var(--idle)", suspended: "var(--suspended)",
  terminated: "var(--terminated)", unknown: "var(--unknown)", loading: "var(--dim)"
};
// Display order: working sessions first, then idle, then loading/suspended, dead last.
var STATUS_RANK = { running: 0, idle: 1, loading: 2, suspended: 3, unknown: 4, terminated: 5 };
// A running container with an actively-working agent is shown as "busy".
var STATUS_LABEL = {
  running: "busy", idle: "idle", suspended: "suspended",
  terminated: "terminated", unknown: "unknown", loading: "…"
};
var list = document.getElementById("list");
var countsEl = document.getElementById("counts");
var updatedEl = document.getElementById("updated");
var toggleEl = document.getElementById("theme-toggle");

function currentTheme() { return document.documentElement.getAttribute("data-theme") || "dark"; }
function paintToggle() { toggleEl.textContent = currentTheme() === "light" ? "☾" : "☀"; }
toggleEl.addEventListener("click", function () {
  var next = currentTheme() === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("agentd-theme", next); } catch (e) { /* ignore */ }
  paintToggle();
});
paintToggle();

// Columns-per-row control (persisted; drives the --cols grid variable).
var COLS_MIN = 1, COLS_MAX = 8;
var cols = parseInt(localStorage.getItem("agentd-cols"), 10);
if (!(cols >= COLS_MIN && cols <= COLS_MAX)) cols = 3;
var colsN = document.getElementById("cols-n");
function applyCols() {
  document.documentElement.style.setProperty("--cols", String(cols));
  colsN.textContent = cols;
  try { localStorage.setItem("agentd-cols", String(cols)); } catch (e) { /* ignore */ }
}
document.getElementById("cols-dec").addEventListener("click", function () { if (cols > COLS_MIN) { cols--; applyCols(); } });
document.getElementById("cols-inc").addEventListener("click", function () { if (cols < COLS_MAX) { cols++; applyCols(); } });
applyCols();

// Idle notifications: alert when a session goes busy → idle (needs you).
var notifyEnabled = false;
try { notifyEnabled = localStorage.getItem("agentd-notify") === "1"; } catch (e) { /* ignore */ }
var notifyToggle = document.getElementById("notify-toggle");
var hasNotif = "Notification" in window;
// Idle-notification tracking. Detect "did new work and is now idle" via the
// transcript activity timestamp (monotonic) rather than catching a transient
// "busy" poll — robust even when a backgrounded tab throttles polling.
var actInit = {};   // label -> seen a real activity timestamp at least once
var idleAckMs = {}; // label -> activity ts already acknowledged as idle
var notifyDebug = false;
try { notifyDebug = localStorage.getItem("agentd-debug") === "1"; } catch (e) { /* ignore */ }
function checkNotifications(all) {
  all.forEach(function (s) {
    var act = s.lastActivityMs;
    if (notifyDebug) {
      console.log("[agentd]", s.label, "status=" + s.status, "lastActivityMs=" + act,
        "ack=" + idleAckMs[s.label], "init=" + !!actInit[s.label], "notifyEnabled=" + notifyEnabled);
    }
    if (act == null) return; // no transcript data (quick view / non-Claude)
    if (!actInit[s.label]) {
      // Baseline on first real observation; suppress a session already idle.
      actInit[s.label] = true;
      if (s.status === "idle") idleAckMs[s.label] = act;
      return;
    }
    if (s.status === "idle" && act > (idleAckMs[s.label] || 0)) {
      // Only pinned sessions notify; still ack regardless so pinning a
      // currently-idle session later won't immediately fire a stale ping.
      if (notifyEnabled && pinned[s.label]) notifyIdle(s.label);
      idleAckMs[s.label] = act;
    }
  });
}
function notifPermission() { return hasNotif ? Notification.permission : "unsupported"; }
function fireNotification(title, body, tag, sticky) {
  if (notifPermission() !== "granted") return false;
  try {
    var opts = { tag: tag, icon: "/icon.svg" };
    if (body) opts.body = body;
    // requireInteraction keeps it on screen until clicked/dismissed (desktop
    // Chrome/Edge; ignored elsewhere). On macOS also requires the browser's
    // notification style to be "Alerts" (not "Banners") in System Settings.
    if (sticky) opts.requireInteraction = true;
    var n = new Notification(title, opts);
    n.onclick = function () { window.focus(); n.close(); };
    return true;
  } catch (e) { return false; }
}
function paintNotify() {
  var blocked = notifyEnabled && notifPermission() !== "granted";
  notifyToggle.innerHTML = notifyEnabled ? SVG_BELL : SVG_BELL_OFF;
  notifyToggle.classList.toggle("off", !notifyEnabled);
  notifyToggle.classList.toggle("warn", blocked);
  notifyToggle.title = !notifyEnabled ? "Idle notifications off — click to enable"
    : !hasNotif ? "This browser doesn't support notifications"
    : notifPermission() === "denied" ? "Notifications blocked — allow them for this site in your browser, then toggle again"
    : notifPermission() !== "granted" ? "Permission not granted yet — click to request"
    : "Idle notifications on (pings when a pinned session goes busy → idle)";
}
notifyToggle.addEventListener("click", function () {
  notifyEnabled = !notifyEnabled;
  try { localStorage.setItem("agentd-notify", notifyEnabled ? "1" : "0"); } catch (e) { /* ignore */ }
  if (notifyEnabled && hasNotif) {
    if (Notification.permission === "granted") {
      fireNotification("agentd notifications on", "", "agentd-test-" + Date.now());
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then(function (p) {
        paintNotify();
        if (p === "granted") fireNotification("agentd notifications on", "", "agentd-test-" + Date.now());
      });
    }
  }
  paintNotify();
});
paintNotify();
function notifyIdle(label) {
  // Unique tag per fire: a stable tag gets silently coalesced (updated in place,
  // no re-alert) by macOS/Chrome. The ack logic already prevents duplicate fires.
  fireNotification("session " + label + " done", "", "agentd-idle-" + label + "-" + Date.now(), true);
}

// Filter box.
var searchEl = document.getElementById("search");
var filterQuery = "";
searchEl.addEventListener("input", function () {
  filterQuery = searchEl.value.trim().toLowerCase();
  render(lastData);
});
function matchesFilter(s) {
  if (!filterQuery) return true;
  return (s.label + " " + s.agent + " " + (s.model || "")).toLowerCase().indexOf(filterQuery) !== -1;
}

// Click-to-peek transcript modal.
var peekEl = document.getElementById("peek");
var peekTitle = document.getElementById("peek-title");
var peekBody = document.getElementById("peek-body");
var peekLabel = null;
function openPeek(label) { peekLabel = label; peekTitle.textContent = label; peekBody.textContent = "loading…"; peekEl.hidden = false; fetchPeek(); }
function closePeek() { peekLabel = null; peekEl.hidden = true; }
document.getElementById("peek-close").addEventListener("click", closePeek);
peekEl.addEventListener("click", function (e) { if (e.target === peekEl) closePeek(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && peekLabel) closePeek(); });
function fetchPeek() {
  if (!peekLabel) return;
  var label = peekLabel;
  fetch("/api/transcript?label=" + encodeURIComponent(label), { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (peekLabel !== label) return;
      var turns = d.turns || [];
      peekBody.textContent = "";
      if (!turns.length) { peekBody.appendChild(el("div", "turn", "No transcript yet.")); return; }
      turns.forEach(function (t) {
        var row = el("div", "turn " + (t.role === "assistant" ? "assistant" : "user"));
        row.appendChild(el("span", "who", t.role === "assistant" ? "agent" : "user"));
        row.appendChild(document.createTextNode(t.text));
        peekBody.appendChild(row);
      });
      peekBody.scrollTop = peekBody.scrollHeight;
    })
    .catch(function () { if (peekLabel === label) peekBody.textContent = "failed to load transcript"; });
}

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function detailRow(parent, key, valueNode) {
  parent.appendChild(el("div", "k", key));
  var v = el("div", "v");
  v.appendChild(valueNode);
  parent.appendChild(v);
}

function shorten(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\\.0$/, "") + "M";
  if (n >= 1000) {
    var k = Math.round(n / 1000);
    return k >= 1000 ? "1M" : k + "k"; // avoid "1000k" from rounding
  }
  return String(n);
}

// Pinned session labels (persisted), kept so pins survive reloads + re-renders.
var pinned = {};
try {
  (JSON.parse(localStorage.getItem("agentd-pinned") || "[]") || []).forEach(function (l) { pinned[l] = true; });
} catch (e) { /* ignore */ }
var lastData = { sessions: [] };
function togglePin(label) {
  if (pinned[label]) delete pinned[label]; else pinned[label] = true;
  try { localStorage.setItem("agentd-pinned", JSON.stringify(Object.keys(pinned))); } catch (e) { /* ignore */ }
  render(lastData);
}

// Click to toggle between short/full text. Expansion state is keyed and kept in
// expandedKeys so it survives the periodic full re-render.
var expandedKeys = {};
function makeExpandable(node, key, shortText, fullText) {
  node.classList.add("expandable");
  node.title = fullText;
  function apply() { node.textContent = expandedKeys[key] ? fullText : shortText; }
  node.addEventListener("click", function () {
    expandedKeys[key] = !expandedKeys[key];
    apply();
  });
  apply();
  return node;
}

function renderCard(s) {
  var card = el("div", "card");
  if (pinned[s.label]) card.classList.add("pinned");

  var row1 = el("div", "row1");
  var dot = el("span", "dot");
  dot.style.background = STATUS_COLOR[s.status] || "var(--unknown)";
  row1.appendChild(dot);
  row1.appendChild(el("span", "label", s.label));
  var statusWrap = el("span", "status");
  if (s.status === "idle") statusWrap.title = "Idle — waiting for user input";
  var statusText = el("span", null, STATUS_LABEL[s.status] || s.status);
  statusText.style.color = STATUS_COLOR[s.status] || "var(--unknown)";
  statusWrap.appendChild(statusText);
  row1.appendChild(statusWrap);
  var isPinned = !!pinned[s.label];
  var pin = el("button", "pin" + (isPinned ? " on" : ""));
  pin.innerHTML = SVG_PIN;
  pin.title = isPinned ? "Unpin" : "Pin to top";
  pin.addEventListener("click", function () { togglePin(s.label); });
  row1.appendChild(pin);
  if (s.lastActivity != null || s.lastLine != null || s.contextPct != null || s.costUsd != null) {
    var peekBtn = el("button", "peek", "⤢");
    peekBtn.title = "Peek at recent transcript";
    peekBtn.addEventListener("click", function () { openPeek(s.label); });
    row1.appendChild(peekBtn);
  }
  card.appendChild(row1);

  // Line 2: agent · model · age (the "type"), plus the rm badge — kept off
  // line 1 so the label/status never get pushed into an accidental wrap.
  var submeta = el("div", "submeta");
  var meta = el("span", null, s.agent + (s.model ? " · " + s.model : "") + " · up " + s.age + " · " + s.containerId);
  try { meta.title = "started " + new Date(s.startedAt).toLocaleString(); } catch (e) { /* ignore */ }
  submeta.appendChild(meta);
  if (s.autoRemove) {
    var rm = el("span", "chip badge-rm", "rm");
    rm.title = "Auto-removes when the session ends";
    submeta.appendChild(rm);
  }
  card.appendChild(submeta);

  var detail = el("div", "detail");

  if (s.lastActivity) {
    detailRow(detail, "active", el("span", null, s.lastActivity + " ago"));
  }

  // usage: cpu · mem · ctx% · ~$cost (whichever are available)
  if (s.cpu || s.mem || s.contextPct != null || s.costUsd != null) {
    var usage = el("span", "usage");
    var parts = [];
    if (s.cpu) {
      var cpuEl = el("span");
      cpuEl.appendChild(el("span", "n", s.cpu));
      cpuEl.appendChild(document.createTextNode(" cpu"));
      parts.push(cpuEl);
    }
    if (s.mem) {
      var memEl = el("span");
      memEl.appendChild(el("span", "n", s.mem));
      memEl.appendChild(document.createTextNode(" mem"));
      parts.push(memEl);
    }
    if (s.contextPct != null) {
      var ctxEl = el("span", "n", s.contextPct + "% ctx");
      ctxEl.style.color = s.contextPct >= 80 ? "var(--terminated)"
        : s.contextPct >= 50 ? "var(--unknown)" : "var(--running)";
      if (s.contextTokens != null) ctxEl.title = formatTokens(s.contextTokens) + " tokens in context";
      parts.push(ctxEl);
    }
    if (s.costUsd != null) {
      var costEl = el("span", "n", "~$" + (s.costUsd >= 10 ? s.costUsd.toFixed(0) : s.costUsd.toFixed(2)));
      costEl.title = "Estimated cumulative cost at API list rates";
      parts.push(costEl);
    }
    parts.forEach(function (p, i) {
      if (i) usage.appendChild(document.createTextNode(" · "));
      usage.appendChild(p);
    });
    detailRow(detail, "usage", usage);
  }

  if (s.ports && s.ports.length) {
    var portsWrap = el("span");
    s.ports.forEach(function (p, i) {
      if (i) portsWrap.appendChild(document.createTextNode("  "));
      if (p.url) {
        var a = el("a", "port", p.container + " → " + p.host);
        a.href = p.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        portsWrap.appendChild(a);
      } else {
        portsWrap.appendChild(el("span", null, ":" + p.container));
      }
    });
    detailRow(detail, "ports", portsWrap);
  }

  if (s.mounts && s.mounts.length) {
    var mountsWrap = el("span");
    s.mounts.forEach(function (m, i) {
      if (i) mountsWrap.appendChild(document.createTextNode("  "));
      var mt = el("span", "mount", m.display);
      if (m.path && m.path !== m.display) {
        makeExpandable(mt, s.label + "|mount|" + i, m.display, m.path);
      }
      mountsWrap.appendChild(mt);
      if (m.ro) mountsWrap.appendChild(el("span", "ro", " (ro)"));
    });
    detailRow(detail, "mounts", mountsWrap);
  }

  if ((s.secrets && s.secrets.length) || s.credentialName) {
    var secWrap = el("span");
    s.secrets.forEach(function (name) { secWrap.appendChild(el("span", "chip", name)); });
    // The agent's login credential is mounted read-only just like an env
    // secret; show it (filename only) so the card reflects everything mounted.
    if (s.credentialName) {
      var cred = el("span", "chip", s.credentialName);
      cred.title = "Agent credential, mounted read-only";
      secWrap.appendChild(cred);
    }
    detailRow(detail, "secrets", secWrap);
  }

  if (s.lastLine) {
    var shortLast = shorten(s.lastLine, 72);
    var lastEl = el("span", "screenline", shortLast);
    if (shortLast !== s.lastLine) {
      makeExpandable(lastEl, s.label + "|last", shortLast, s.lastLine);
    }
    detailRow(detail, "last", lastEl);
  }

  card.appendChild(detail);
  return card;
}

function sortSessions(sessions) {
  return sessions.slice().sort(function (a, b) {
    var pa = pinned[a.label] ? 0 : 1;
    var pb = pinned[b.label] ? 0 : 1;
    if (pa !== pb) return pa - pb;
    var ra = STATUS_RANK[a.status]; if (ra == null) ra = 5;
    var rb = STATUS_RANK[b.status]; if (rb == null) rb = 5;
    if (ra !== rb) return ra - rb;
    return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0);
  });
}

function render(data) {
  lastData = data;
  var all = data.sessions || [];

  // Idle-notification detection (activity-timestamp based; runs on the full set).
  checkNotifications(all);

  var sessions = sortSessions(all.filter(matchesFilter));
  list.textContent = "";
  if (!all.length) {
    list.appendChild(el("div", "empty", "No active sessions"));
  } else if (!sessions.length) {
    list.appendChild(el("div", "empty", "No matches for “" + filterQuery + "”"));
  } else {
    sessions.forEach(function (s) { list.appendChild(renderCard(s)); });
  }
  var running = all.filter(function (s) { return s.status === "running"; }).length;
  var idle = all.filter(function (s) { return s.status === "idle"; }).length;
  var suspended = all.filter(function (s) { return s.status === "suspended"; }).length;
  countsEl.textContent = "● " + running + " busy   ● " + idle + " idle   ◐ " + suspended + " suspended";
}

// Instant first paint from state.json only; the enriched poll (docker ps/stats
// + transcript reads) fills in status/usage/last afterwards. gotFull guards
// against a slow quick response landing after real data.
var gotFull = false;
fetch("/api/sessions?quick=1", { cache: "no-store" })
  .then(function (r) { return r.json(); })
  .then(function (d) { if (!gotFull) render(d); })
  .catch(function () { /* the enriching tick reports connection errors */ });

// Relative "updated Ns ago", refreshed every second between polls.
var lastUpdateMs = 0;
var connected = false;
function paintUpdated() {
  if (!connected || !lastUpdateMs) return;
  var secs = Math.max(0, Math.round((Date.now() - lastUpdateMs) / 1000));
  var ago = secs < 60 ? secs + "s ago" : Math.floor(secs / 60) + "m ago";
  updatedEl.textContent = "updated " + ago;
}
setInterval(paintUpdated, 1000);

var inFlight = false;
function tick() {
  // Skip a tick if the previous (heavier) request hasn't returned yet so
  // requests can't pile up.
  if (inFlight) return;
  inFlight = true;
  fetch("/api/sessions", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      gotFull = true;
      render(d);
      if (peekLabel) fetchPeek();
      connected = true;
      lastUpdateMs = Date.now();
      updatedEl.classList.remove("stale");
      paintUpdated();
    })
    .catch(function () {
      connected = false;
      updatedEl.classList.add("stale");
      updatedEl.textContent = "disconnected (agentd serve stopped?)";
    })
    .finally(function () { inFlight = false; });
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
