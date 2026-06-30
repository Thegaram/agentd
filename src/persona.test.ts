import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolvePersonaFile } from "./persona.js";
import { createPaths } from "./paths.js";

describe("resolvePersonaFile", () => {
  let home: string;
  let paths: ReturnType<typeof createPaths>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentd-persona-test-"));
    paths = createPaths(home);
    mkdirSync(join(home, "persona"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns undefined when no persona file exists (the default)", () => {
    expect(resolvePersonaFile({ agent: "claude" }, paths)).toBeUndefined();
  });

  it("returns the per-agent file when present", () => {
    const perAgent = paths.personaFile("claude");
    writeFileSync(perAgent, "# claude persona");
    expect(resolvePersonaFile({ agent: "claude" }, paths)).toBe(perAgent);
  });

  it("falls back to default.md when no per-agent file exists", () => {
    const generic = paths.personaFile("default");
    writeFileSync(generic, "# shared persona");
    expect(resolvePersonaFile({ agent: "codex" }, paths)).toBe(generic);
  });

  it("prefers the per-agent file over default.md", () => {
    writeFileSync(paths.personaFile("default"), "# shared");
    const perAgent = paths.personaFile("claude");
    writeFileSync(perAgent, "# claude only");
    expect(resolvePersonaFile({ agent: "claude" }, paths)).toBe(perAgent);
  });

  it("uses an explicit --persona path over any generic file", () => {
    writeFileSync(paths.personaFile("claude"), "# generic");
    const explicit = join(home, "my-persona.md");
    writeFileSync(explicit, "# explicit");
    expect(resolvePersonaFile({ agent: "claude", explicitPath: explicit }, paths)).toBe(explicit);
  });

  it("resolves a bare --persona name to a reusable persona file", () => {
    const named = paths.personaFile("abc");
    writeFileSync(named, "# abc");
    expect(resolvePersonaFile({ agent: "claude", explicitPath: "abc" }, paths)).toBe(named);
  });

  it("resolves a bare --persona name with an .md suffix", () => {
    const named = paths.personaFile("abc");
    writeFileSync(named, "# abc");
    expect(resolvePersonaFile({ agent: "claude", explicitPath: "abc.md" }, paths)).toBe(named);
  });

  it("falls back to a file path when a bare --persona name has no reusable file", () => {
    // run from `home` so the bare name resolves there as a relative path.
    // After chdir, process.cwd() returns the canonical path (e.g. macOS
    // /var -> /private/var), so derive the expected path via resolve() too
    // rather than join(home, ...), which would keep the pre-symlink path.
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const explicit = resolve("abc.md");
      writeFileSync(explicit, "# explicit");
      expect(resolvePersonaFile({ agent: "claude", explicitPath: "abc.md" }, paths)).toBe(explicit);
    } finally {
      process.chdir(cwd);
    }
  });

  it("treats a value with a path separator as a path, not a reusable name", () => {
    writeFileSync(paths.personaFile("abc"), "# reusable abc");
    const explicit = join(home, "abc.md");
    writeFileSync(explicit, "# explicit");
    expect(resolvePersonaFile({ agent: "claude", explicitPath: explicit }, paths)).toBe(explicit);
  });

  it("throws when an explicit --persona path is missing", () => {
    const missing = join(home, "nope.md");
    expect(() => resolvePersonaFile({ agent: "claude", explicitPath: missing }, paths))
      .toThrow(/Persona file not found/);
  });

  it("returns undefined when disabled, even if generic files exist", () => {
    writeFileSync(paths.personaFile("claude"), "# generic");
    expect(resolvePersonaFile({ agent: "claude", disabled: true }, paths)).toBeUndefined();
  });

  it("disabled wins over an explicit --persona path", () => {
    const explicit = join(home, "my-persona.md");
    writeFileSync(explicit, "# explicit");
    expect(resolvePersonaFile({ agent: "claude", explicitPath: explicit, disabled: true }, paths)).toBeUndefined();
  });
});
