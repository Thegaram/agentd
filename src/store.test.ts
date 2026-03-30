import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./store.js";

describe("SessionStore", () => {
  let stateFile: string;
  let store: SessionStore;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "agentd-store-test-"));
    stateFile = join(dir, "state.json");
    store = new SessionStore(stateFile);
  });

  afterEach(() => {
    rmSync(join(stateFile, ".."), { recursive: true, force: true });
  });

  const base = () => ({
    agent: "claude",
    startedAt: new Date().toISOString(),
    autoRemove: false,
    secrets: [] as string[],
    mounts: [] as string[],
    ports: [] as string[],
    resolvedPorts: [] as string[],
  });

  it("returns empty list when no state file exists", () => {
    expect(store.list()).toEqual([]);
  });

  it("saves and retrieves a session", () => {
    store.save({ label: "task-001", containerId: "abc123", ...base() });
    const session = store.get("task-001");
    expect(session?.containerId).toBe("abc123");
  });

  it("overwrites session with same label", () => {
    store.save({ label: "task-001", containerId: "old", ...base() });
    store.save({ label: "task-001", containerId: "new", ...base() });
    expect(store.list()).toHaveLength(1);
    expect(store.get("task-001")?.containerId).toBe("new");
  });

  it("removes a session", () => {
    store.save({ label: "task-001", containerId: "abc123", ...base() });
    store.remove("task-001");
    expect(store.get("task-001")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("returns undefined for nonexistent session", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("preserves other sessions on remove", () => {
    store.save({ label: "a", containerId: "1", ...base() });
    store.save({ label: "b", containerId: "2", ...base() });
    store.remove("a");
    expect(store.list()).toHaveLength(1);
    expect(store.get("b")?.containerId).toBe("2");
  });
});
