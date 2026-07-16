import { z } from "incur";

// Shell command options, kept in a side-effect-free module so tests can import
// the schema without triggering cli.ts's top-level cli.serve().
//
// The mutually-exclusive backend flags (--claude, --pi, …) must include every
// AGENT_NAMES entry — resolveAgent reads the same registry, so a missing flag
// makes that backend unselectable. shell-options.test.ts guards this invariant.
export const shellOptionsSchema = z.object({
  claude: z
    .boolean()
    .optional()
    .describe("Use Claude Code backend (default)"),
  codex: z
    .boolean()
    .optional()
    .describe("Use OpenAI Codex backend"),
  aider: z
    .boolean()
    .optional()
    .describe("Use aider backend (local Ollama)"),
  pi: z
    .boolean()
    .optional()
    .describe("Use pi coding agent backend (pi.dev)"),
  model: z
    .string()
    .optional()
    .describe("Model override (agent-specific, e.g. opus, gpt-5.4)"),
  rm: z
    .boolean()
    .optional()
    .describe("Remove container when session ends"),
  mount: z
    .array(z.string())
    .optional()
    .describe("Mount paths, replaces default cwd mount (host:container)"),
  "skip-mount": z
    .boolean()
    .optional()
    .describe("Don't mount current directory"),
  secret: z
    .array(z.string())
    .optional()
    .describe("Secret scopes to pass (defaults to agent-specific scope)"),
  port: z
    .array(z.string())
    .optional()
    .describe("Port mappings [host:]container (replaces default 3000)"),
  "skip-ports": z
    .boolean()
    .optional()
    .describe("Don't publish any ports"),
  persona: z
    .string()
    .optional()
    .describe("Reusable persona name (~/.agentd/persona/<name>.md) or path to a persona/instructions file, for this session"),
  "no-persona": z
    .boolean()
    .optional()
    .describe("Don't mount any persona/instructions file"),
  "dry-run": z
    .boolean()
    .optional()
    .describe("Print the Docker command without executing"),
  fork: z
    .string()
    .optional()
    .describe("Fork an existing session (by label) into the current dir, copying its transcript"),
});
