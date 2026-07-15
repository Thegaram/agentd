import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildStaticViews,
  computeTranscriptCostUsd,
  contextTokensFromTail,
  contextWindowSize,
  isAwaitingUser,
  pricingForModel,
  recentTurns,
  isLoopbackHost,
  parseMounts,
  parsePorts,
  startDashboard,
  summarizeTranscriptTail,
  type DashboardHandle,
} from "./dashboard.js";
import { SessionManager } from "./session.js";

describe("parsePorts", () => {
  it("prefers resolved host mappings and builds localhost URLs", () => {
    expect(parsePorts(["3000→49152"], ["3000"])).toEqual([
      { container: "3000", host: "49152", url: "http://localhost:49152" },
    ]);
  });

  it("falls back to requested container ports with no URL", () => {
    expect(parsePorts([], ["8080:3000"])).toEqual([
      { container: "3000", host: "", url: "" },
    ]);
  });

  it("returns empty for no ports", () => {
    expect(parsePorts([], [])).toEqual([]);
  });
});

describe("parseMounts", () => {
  it("shortens the host path and detects :ro", () => {
    expect(parseMounts(["/home/me/code/my-project:/workspace"])).toEqual([
      { display: "my-project", path: "/home/me/code/my-project", ro: false },
    ]);
    expect(parseMounts(["/home/me/obsidian:/workspace:ro"])).toEqual([
      { display: "obsidian", path: "/home/me/obsidian", ro: true },
    ]);
  });
});

describe("summarizeTranscriptTail", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("returns the last assistant text", () => {
    const jsonl = [
      line({ type: "user", message: { role: "user", content: "hi" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done!" }] } }),
    ].join("\n");
    expect(summarizeTranscriptTail(jsonl)).toBe("All done!");
  });

  it("describes the last tool call when there's no trailing text, skipping tool results", () => {
    const jsonl = [
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    ].join("\n");
    expect(summarizeTranscriptTail(jsonl)).toBe("→ Bash: npm test");
  });

  it("collapses whitespace and truncates long text", () => {
    const jsonl = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a\n\n  b   c" }] } });
    expect(summarizeTranscriptTail(jsonl)).toBe("a b c");
    const longText = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] } });
    expect(summarizeTranscriptTail(longText, 10)).toBe("xxxxxxxxx…");
  });

  it("ignores blank lines and unparseable JSON", () => {
    expect(summarizeTranscriptTail("")).toBeUndefined();
    expect(summarizeTranscriptTail("not json\n{bad\n")).toBeUndefined();
  });
});

describe("isAwaitingUser", () => {
  const line = (obj: unknown) => JSON.stringify(obj);
  const asst = (content: unknown) => line({ type: "assistant", message: { role: "assistant", content } });
  const user = (content: unknown) => line({ type: "user", message: { role: "user", content } });

  it("is idle after a completed assistant turn (text, no tool)", () => {
    expect(isAwaitingUser(asst([{ type: "text", text: "All done!" }]))).toBe(true);
  });

  it("is working when the last assistant turn dispatched a tool", () => {
    expect(isAwaitingUser(asst([{ type: "tool_use", name: "Bash", input: {} }]))).toBe(false);
    // text + tool in the same turn still counts as working
    expect(isAwaitingUser(asst([{ type: "text", text: "running" }, { type: "tool_use", name: "Bash" }]))).toBe(false);
  });

  it("is working when the last entry is a user message or tool result", () => {
    expect(isAwaitingUser(user("do the thing"))).toBe(false);
    expect(isAwaitingUser(user([{ type: "tool_result", content: "ok" }]))).toBe(false);
  });

  it("uses the most recent main-thread turn, ignoring trailing sidechain entries", () => {
    const jsonl = [
      asst([{ type: "tool_use", name: "Task", input: {} }]),
      line({ isSidechain: true, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "sub done" }] } }),
    ].join("\n");
    expect(isAwaitingUser(jsonl)).toBe(false);
  });

  it("treats a conversation with no in-progress turn as awaiting the user (cleared/fresh)", () => {
    expect(isAwaitingUser("")).toBe(true);
    expect(isAwaitingUser(line({ type: "summary", summary: "x" }))).toBe(true);
    // a freshly /clear-ed transcript: only non-conversational meta entries
    const cleared = [line({ type: "mode" }), line({ type: "permission-mode" }), line({ type: "last-prompt" })].join("\n");
    expect(isAwaitingUser(cleared)).toBe(true);
  });
});

describe("contextTokensFromTail", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("sums input + cached prompt tokens from the latest usage entry", () => {
    const jsonl = line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 5000, output_tokens: 42 } },
    });
    expect(contextTokensFromTail(jsonl)).toBe(126000);
  });

  it("walks back past entries without usage", () => {
    const jsonl = [
      line({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 50000 } } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    ].join("\n");
    expect(contextTokensFromTail(jsonl)).toBe(50000);
  });

  it("returns undefined when no usage is present", () => {
    expect(contextTokensFromTail(line({ type: "user", message: { role: "user", content: "hi" } }))).toBeUndefined();
    expect(contextTokensFromTail("")).toBeUndefined();
  });
});

describe("contextWindowSize", () => {
  it("returns 1M for [1m] models, 200k otherwise", () => {
    expect(contextWindowSize("opus[1m]")).toBe(1_000_000);
    expect(contextWindowSize("sonnet")).toBe(200_000);
    expect(contextWindowSize(undefined)).toBe(200_000);
  });
});

describe("pricingForModel", () => {
  it("maps model names to the right pricing family (defaults to opus)", () => {
    expect(pricingForModel("opus[1m]")).toEqual({ input: 5, output: 25 });
    expect(pricingForModel("claude-sonnet")).toEqual({ input: 3, output: 15 });
    expect(pricingForModel("haiku")).toEqual({ input: 1, output: 5 });
    expect(pricingForModel(undefined)).toEqual({ input: 5, output: 25 });
  });
});

describe("computeTranscriptCostUsd", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("sums usage at input/output/cache-write(1.25x)/cache-read(0.1x) rates", () => {
    const jsonl = [
      line({ type: "assistant", message: { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }),
      line({ type: "assistant", message: { usage: { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 } } }),
    ].join("\n");
    // opus: 1M input ($5) + 1M output ($25) + 1M cache-write (5*1.25=$6.25) + 1M cache-read (5*0.1=$0.50)
    expect(computeTranscriptCostUsd(jsonl, { input: 5, output: 25 })).toBeCloseTo(36.75, 5);
  });

  it("returns 0 for transcripts with no usage", () => {
    expect(computeTranscriptCostUsd("", { input: 5, output: 25 })).toBe(0);
  });
});

describe("recentTurns", () => {
  const line = (obj: unknown) => JSON.stringify(obj);

  it("returns role-tagged turns in chronological order, newest last", () => {
    const jsonl = [
      line({ type: "user", message: { role: "user", content: "do X" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    expect(recentTurns(jsonl)).toEqual([
      { role: "user", text: "do X" },
      { role: "assistant", text: "→ Bash: ls" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("keeps only the last n turns", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "t" + i }] } }));
    const turns = recentTurns(lines.join("\n"), 5);
    expect(turns).toHaveLength(5);
    expect(turns[4]).toEqual({ role: "assistant", text: "t29" });
  });
});

describe("buildStaticViews", () => {
  it("returns state.json-derived fields synchronously with status 'loading'", () => {
    const home = mkdtempSync(join(tmpdir(), "agentd-static-"));
    try {
      const mgr = new SessionManager({ agentdHome: home });
      mgr.saveSession({
        label: "demo",
        agent: "claude",
        model: "opus",
        containerId: "abcdef0123456789",
        startedAt: new Date().toISOString(),
        autoRemove: false,
        secrets: [],
        mounts: ["/home/me/code/demo:/workspace"],
        ports: ["3000"],
        resolvedPorts: ["3000→49152"],
      });
      const views = buildStaticViews(mgr);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        label: "demo",
        status: "loading",
        containerId: "abcdef012345",
        ports: [{ host: "49152", url: "http://localhost:49152" }],
        mounts: [{ display: "demo", ro: false }],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback hosts with or without a port", () => {
    for (const h of ["127.0.0.1", "127.0.0.1:8787", "localhost:8787", "::1", "[::1]:8787"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects non-loopback and missing hosts", () => {
    for (const h of ["evil.com", "evil.com:8787", "10.0.0.5", "0.0.0.0", undefined]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("dashboard server", () => {
  let home: string;
  let mgr: SessionManager;
  let handle: DashboardHandle;
  let port: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "agentd-dash-"));
    mgr = new SessionManager({ agentdHome: home });
    handle = await startDashboard(mgr, { port: 0 });
    port = Number(new URL(handle.url).port);
  });

  afterEach(async () => {
    await handle.close();
    rmSync(home, { recursive: true, force: true });
  });

  const req = (
    path: string,
    opts: { method?: string; host?: string } = {},
  ): Promise<{ status: number; body: string; contentType?: string | undefined }> =>
    new Promise((resolveReq, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: opts.method ?? "GET",
          headers: opts.host ? { host: opts.host } : {},
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolveReq({
              status: res.statusCode ?? 0,
              body,
              contentType: res.headers["content-type"],
            }),
          );
        },
      );
      r.on("error", reject);
      r.end();
    });

  it("serves the HTML page at /", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("agentd");
  });

  it("serves an empty session list as JSON", async () => {
    const res = await req("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(JSON.parse(res.body)).toMatchObject({ sessions: [] });
  });

  it("serves the quick (state-only) view at /api/sessions?quick=1", async () => {
    const res = await req("/api/sessions?quick=1");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ sessions: [] });
  });

  it("ignores symlinked transcript files", async () => {
    const transcriptsKey = "transcripts-with-symlink";
    const dir = mgr.transcriptsHostDir(transcriptsKey);
    const target = join(home, "outside.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "should not leak" }] },
    }) + "\n");
    symlinkSync(target, join(dir, "latest.jsonl"));
    mgr.saveSession({
      label: "demo",
      agent: "claude",
      model: "opus",
      containerId: "abcdef0123456789",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
      transcriptsKey,
    });

    const sessionsRes = await req("/api/sessions");
    expect(sessionsRes.status).toBe(200);
    expect(JSON.parse(sessionsRes.body).sessions[0]).not.toHaveProperty("lastLine");

    const transcriptRes = await req("/api/transcript?label=demo");
    expect(transcriptRes.status).toBe(200);
    expect(JSON.parse(transcriptRes.body)).toMatchObject({ turns: [] });
  });

  it("does not parse a non-Claude session's bucket as a Claude transcript", async () => {
    // Every backend now persists a transcriptsKey bucket, but the parsers only
    // understand Claude's JSONL. A pi session must stay blank even if a
    // Claude-shaped .jsonl lands in its bucket.
    const transcriptsKey = "pi-session-bucket";
    const dir = mgr.transcriptsHostDir(transcriptsKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "pi said this" }] },
    }) + "\n");
    mgr.saveSession({
      label: "pi-demo",
      agent: "pi",
      model: "gpt-5.4",
      containerId: "abcdef0123456789",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
      transcriptsKey,
    });

    const sessionsRes = await req("/api/sessions");
    expect(sessionsRes.status).toBe(200);
    const view = JSON.parse(sessionsRes.body).sessions[0];
    expect(view.label).toBe("pi-demo");
    expect(view.lastLine).toBeUndefined();
    expect(view.costUsd).toBeUndefined();
    expect(view.contextPct).toBeUndefined();

    const transcriptRes = await req("/api/transcript?label=pi-demo");
    expect(transcriptRes.status).toBe(200);
    expect(JSON.parse(transcriptRes.body)).toMatchObject({ turns: [] });
  });

  it("surfaces the native credential mount as a chip (filename only)", async () => {
    mgr.saveSession({
      label: "with-cred",
      agent: "claude",
      model: "opus",
      containerId: "abcdef0123456789",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      credential: join(home, "secrets", "claude-oauth.json"),
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
    });
    const res = await req("/api/sessions");
    expect(res.status).toBe(200);
    // Basename only — never the host path or contents.
    expect(JSON.parse(res.body).sessions[0]).toMatchObject({ credentialName: "claude-oauth.json" });
  });

  it("omits credentialName when no credential is mounted", async () => {
    mgr.saveSession({
      label: "no-cred",
      agent: "aider",
      containerId: "abcdef0123456789",
      startedAt: new Date().toISOString(),
      autoRemove: false,
      secrets: [],
      mounts: [],
      ports: [],
      resolvedPorts: [],
    });
    const res = await req("/api/sessions");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).sessions[0]).not.toHaveProperty("credentialName");
  });

  it("rejects requests with a non-loopback Host header (DNS-rebinding guard)", async () => {
    const res = await req("/api/sessions", { host: "evil.com" });
    expect(res.status).toBe(403);
  });

  it("rejects non-GET methods", async () => {
    const res = await req("/api/sessions", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("404s unknown paths", async () => {
    const res = await req("/nope");
    expect(res.status).toBe(404);
  });
});
