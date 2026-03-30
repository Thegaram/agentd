import { describe, expect, it } from "vitest";
import {
  SessionStateSchema,
  StateFileSchema,
} from "./schema.js";

describe("SessionStateSchema", () => {
  it("parses a valid session state", () => {
    const state = SessionStateSchema.parse({
      label: "my-project",
      containerId: "abc123",
      startedAt: "2026-03-17T10:00:00Z",
    });
    expect(state.label).toBe("my-project");
    expect(state.containerId).toBe("abc123");
  });

  it("applies defaults", () => {
    const state = SessionStateSchema.parse({
      label: "my-project",
      containerId: "def456",
      startedAt: "2026-03-17T10:00:00Z",
    });
    expect(state.agent).toBe("claude");
    expect(state.autoRemove).toBe(false);
    expect(state.secrets).toEqual([]);
    expect(state.mounts).toEqual([]);
    expect(state.ports).toEqual([]);
    expect(state.model).toBeUndefined();
  });

  it("preserves explicit agent value", () => {
    const state = SessionStateSchema.parse({
      label: "my-project",
      agent: "codex",
      containerId: "abc123",
      startedAt: "2026-03-17T10:00:00Z",
    });
    expect(state.agent).toBe("codex");
  });

  it("rejects invalid datetime", () => {
    expect(() =>
      SessionStateSchema.parse({
        label: "my-project",
        containerId: "jkl012",
        startedAt: "not-a-date",
      }),
    ).toThrow();
  });
});

describe("StateFileSchema", () => {
  it("parses with sessions", () => {
    const state = StateFileSchema.parse({
      sessions: [
        {
          label: "my-project",
          containerId: "abc123",
          startedAt: "2026-03-17T10:00:00Z",
        },
      ],
    });
    expect(state.sessions).toHaveLength(1);
  });

  it("defaults to empty sessions", () => {
    const state = StateFileSchema.parse({});
    expect(state.sessions).toEqual([]);
  });
});
