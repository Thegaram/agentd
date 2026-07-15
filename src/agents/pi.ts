import type { AgentBackend } from "./types.js";

// pi is a BYOK, multi-provider agent that picks its own default model based on
// the authenticated provider. agentd therefore leaves the model unset unless the
// user passes --model, letting pi decide. defaultModel is empty for the same
// reason — session.ts feeds it into startCommand, and an empty value emits no
// --model flag.
const DEFAULT_MODEL = "";

function modelArg(model?: string): string {
  return model ? ` --model "${model}"` : "";
}

export const pi: AgentBackend = {
  name: "pi",
  dockerImage: "agentd-pi:latest",
  defaultModel: DEFAULT_MODEL,

  // The image pins a specific pi version, so skip the startup version-check
  // network call. Telemetry/analytics are disabled in the baked settings.json.
  containerEnv: { PI_SKIP_VERSION_CHECK: "1" },

  // pi loads ~/.pi/agent/AGENTS.md as global guidance; it merges with any
  // project-level AGENTS.md/CLAUDE.md.
  personaContainerPath: "/home/agent/.pi/agent/AGENTS.md",

  // pi auto-saves sessions as JSONL under ~/.pi/agent/sessions/. This is a
  // subdir, so mounting it doesn't touch the auth.json/settings.json that pi
  // rewrites in place (which a mount would block — see the credential note).
  transcriptsDir: "/home/agent/.pi/agent/sessions",

  // No mounted credential file. pi owns ~/.pi/agent/auth.json and rewrites it via
  // atomic rename (on /login and on OAuth refresh); a read-only single-file bind
  // mount blocks that write (EROFS/EBUSY), so the login would appear to succeed
  // but never persist — and vanish on resume. Instead agentd mounts nothing at
  // that path: the user runs /login once inside the container, and the resulting
  // auth.json lives in the container's writable layer, which survives stop/resume
  // (same container is restarted). For an API-key provider, pass `--secret pi`
  // with a pi.env instead (that goes through the secret-env path, not auth.json).
  credentialShadowVars: [],

  startCommand(model?: string): string {
    // Fall back to a shell if pi fails to launch (e.g. missing auth) so the
    // container stays usable.
    return `pi${modelArg(model)} || exec bash`;
  },

  resumeCommand(model?: string): string {
    // Continue the most recent session; fall back to a fresh session, then a
    // shell. `pi -c` exits non-zero when there is no session to resume.
    const args = modelArg(model);
    return `pi -c${args} || pi${args} || exec bash`;
  },

  // Auth is provided interactively (/login) or via an optional --secret pi.env,
  // so agentd should not require a secret up front or warn when none is given.
  requiresAuth: false,

  defaultSecretScope: "pi",

  secretMissingHint(path: string): string {
    return `For an API-key provider create it with: echo "OPENAI_API_KEY=sk-..." > ${path}.`
      + ` For a subscription, omit --secret and run /login inside the session instead.`;
  },

  noAuthWarning: "",
};
