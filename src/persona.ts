import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Paths } from "./paths.js";

/** Persona scope that applies to every agent when no per-agent file exists. */
export const PERSONA_DEFAULT_SCOPE = "default";

/**
 * A `--persona <value>` arg is a reusable-persona *name* (looked up under
 * ~/.agentd/persona/) only when it carries no path information: no path
 * separator (`/`) and no leading `~`. `abc` and `abc.md` are names; `./abc.md`,
 * `dir/abc`, `/abs/abc.md`, `~/abc.md` are paths.
 */
function isPersonaName(value: string): boolean {
  return !value.includes("/") && !value.startsWith("~");
}

export interface PersonaOptions {
  /** Agent name, used to look up a per-agent override file. */
  agent: string;
  /** Explicit host path from `--persona` (session-specific override). */
  explicitPath?: string | undefined;
  /** `--no-persona`: suppress any persona file for this session. */
  disabled?: boolean | undefined;
}

/**
 * Resolve the host path of the global persona/instructions file to bind-mount
 * into a session, or `undefined` when nothing should be mounted.
 *
 * Precedence (first match wins):
 *   1. `--no-persona`                 → none (disabled)
 *   2. `--persona <name>`             → ~/.agentd/persona/<name>.md if it exists
 *   3. `--persona <value>`            → that file path (throws if missing)
 *   4. ~/.agentd/persona/<agent>.md   (generic, per-agent)
 *   5. ~/.agentd/persona/default.md   (generic, all agents)
 *   6. otherwise                      → none (no persona — the default)
 *
 * A bare `--persona <name>` (no path separator) is first looked up as a
 * reusable persona under ~/.agentd/persona/; if no such file exists it falls
 * back to being treated as a file path. A value with path information is always
 * a path.
 *
 * agentd ships no defaults: a persona only applies if the user provides one.
 */
export function resolvePersonaFile(opts: PersonaOptions, paths: Paths): string | undefined {
  if (opts.disabled) return undefined;

  if (opts.explicitPath != null) {
    const value = opts.explicitPath;
    if (isPersonaName(value)) {
      const name = value.endsWith(".md") ? value.slice(0, -3) : value;
      const named = paths.personaFile(name);
      if (existsSync(named)) return named;
    }
    const abs = resolve(value);
    if (!existsSync(abs)) {
      throw new Error(`Persona file not found: ${abs}`);
    }
    return abs;
  }

  const perAgent = paths.personaFile(opts.agent);
  if (existsSync(perAgent)) return perAgent;

  const generic = paths.personaFile(PERSONA_DEFAULT_SCOPE);
  if (existsSync(generic)) return generic;

  return undefined;
}
