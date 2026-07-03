import { describe, it, expect } from "vitest";
import { shellOptionsSchema } from "./shell-options.js";
import { AGENT_NAMES } from "./agents/index.js";

describe("shell options", () => {
  it("declares a boolean flag for every registered backend", () => {
    // Guards the failure where a new backend is added to the registry but its
    // --<name> flag is never declared, making `agentd shell --<name>` fail with
    // "Unknown flag". resolveAgent reads AGENT_NAMES, so the flags must match.
    for (const name of AGENT_NAMES) {
      expect(shellOptionsSchema.shape).toHaveProperty(name);
    }
  });
});
