import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Paths } from "./paths.js";

/** Persona scope that applies to every agent when no per-agent file exists. */
export const PERSONA_DEFAULT_SCOPE = "default";

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
 *   1. `--no-persona`            → none (disabled)
 *   2. `--persona <path>`        → that path (throws if missing)
 *   3. ~/.agentd/persona/<agent>.md   (generic, per-agent)
 *   4. ~/.agentd/persona/default.md   (generic, all agents)
 *   5. otherwise                 → none (no persona — the default)
 *
 * agentd ships no defaults: a persona only applies if the user provides one.
 */
export function resolvePersonaFile(opts: PersonaOptions, paths: Paths): string | undefined {
  if (opts.disabled) return undefined;

  if (opts.explicitPath != null) {
    const abs = resolve(opts.explicitPath);
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
