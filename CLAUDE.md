# agentd

Sandboxed AI coding agent sessions. Supports multiple agent backends (Claude Code, OpenAI Codex, aider with local models, pi).

## Architecture

```
agentd CLI (TypeScript, runs on host)
  └── manages ~/.agentd/state.json (active sessions)
  └── spawns Docker containers (one per session, one image per agent)
  └── each container runs the selected agent in a tmux session
```

```
src/
  cli.ts           ← CLI entry point (incur framework)
  shell-options.ts ← `agentd shell` option schema (side-effect-free; --<agent> flags)
  session.ts       ← SessionManager: spawn, attach, cancel, container lifecycle
  store.ts         ← SessionStore: state.json persistence
  docker.ts        ← thin Docker CLI wrappers
  schema.ts        ← zod schemas for session state
  paths.ts         ← ~/.agentd/ path conventions
  format.ts        ← shared formatting helpers (formatAge)
  dashboard.ts     ← read-only web dashboard: HTTP server, view-model, inline page
  agents/
    types.ts       ← AgentBackend interface
    claude.ts      ← Claude Code backend
    codex.ts       ← OpenAI Codex backend
    aider.ts       ← aider backend (local Ollama)
    pi.ts          ← pi backend (pi.dev, BYOK multi-provider)
    index.ts       ← backend registry, getBackend()
container/
  Dockerfile.base  ← shared dev tools, languages, tmux
  set-statusbar.sh ← shared tmux status bar setup
  claude/
    Dockerfile     ← FROM agentd-base, Claude Code install + config
    settings.json  ← permissions, hooks, deny rules, statusline
    statusline.sh  ← Claude Code statusline script
    check-auth.sh  ← OAuth credential expiry check
    notify.sh      ← terminal bell on blocking prompts
  codex/
    Dockerfile     ← FROM agentd-base, Codex install + config
    config.toml    ← Codex configuration (full-auto, sandbox)
    check-auth.sh  ← Codex credential check
  aider/
    Dockerfile     ← FROM agentd-base, aider install
    check-auth.sh  ← Ollama reachability check
  pi/
    Dockerfile     ← FROM agentd-base, pi install (npm, pinned)
    settings.json  ← baked pi defaults (telemetry off, no compaction, project-trust "ask")
    check-auth.sh  ← auth.json / provider-key check
completions/
  _agentd          ← zsh completions
~/.agentd/
  state.json       ← active sessions
  secrets/         ← credential files (claude-oauth.json, codex-auth.json, *.env)
  persona/         ← optional global instruction files (claude.md, codex.md, default.md)
```

## Key decisions

- **TypeScript** for CLI and session manager
- **AgentBackend interface** abstracts credentials, commands, Docker images, and theme handling per agent
- **tmux** inside containers for attach/detach
- **Base image + agent layers**: `agentd-base` has dev tools, each agent image adds its runtime and config
- **Docker operations in `docker.ts`** — session.ts does orchestration only
- **`SessionStore` owns state.json** — not inlined in SessionManager
- **Host theme forwarded via `AGENTD_THEME` env var** — Claude reads `~/.claude.json` `"theme"`, Codex reads `~/.codex/config.toml` `[tui].theme`; if unset, Codex falls back to host light/dark detection (`COLORFGBG`, macOS appearance under tmux, then OSC 11)

## Adding a new agent backend

1. Create `src/agents/myagent.ts` implementing `AgentBackend`
2. Register it in `src/agents/index.ts`
3. Create `container/myagent/Dockerfile` (FROM agentd-base) + config files
4. Add `build-myagent` target to Makefile
5. Add a `--myagent` boolean flag to `shellOptionsSchema` in `src/shell-options.ts`
6. Add the `--myagent` flag to the zsh completions in `completions/_agentd`
7. No changes needed in session.ts or store.ts

`resolveAgent` derives the selected backend from `AGENT_NAMES`, but the mutually-exclusive `--<name>` flags must be **declared** in `shellOptionsSchema` — an undeclared flag fails with "Unknown flag". `shell-options.test.ts` asserts every `AGENT_NAMES` entry has a flag, so a missing one fails CI.

For backends that don't need credentials (like aider with local Ollama), set `requiresAuth: false` — this skips secret file lookup and suppresses the no-auth warning. See `src/agents/aider.ts` for the pattern.

**Credential-file mount is optional.** Omit `credentialHostPath`/`credentialContainerPath` when the agent owns its credential file. pi rewrites `~/.pi/agent/auth.json` via atomic rename (`/login`, OAuth refresh), which a read-only mount blocks — so agentd mounts nothing there and the in-container login persists in the writable layer across resume. An API key can still go through `--secret pi`. See `src/agents/pi.ts`.

## Persona / global instructions

An optional "persona" file is bind-mounted read-only into the agent's global-instructions path so it applies to every new session: Claude's `~/.claude/CLAUDE.md`, Codex's `~/.codex/AGENTS.md`. A backend opts in via `personaContainerPath` (aider has none). It never touches `/workspace`, and merges with — doesn't replace — any project-level CLAUDE.md/AGENTS.md.

- **agentd ships no defaults.** Nothing is mounted unless the user supplies a file. Resolution order is the pure `resolvePersonaFile` (`src/persona.ts`, unit-tested in `persona.test.ts`): `--no-persona` → `--persona <name>` (reusable persona, see below) → `--persona <path>` → `~/.agentd/persona/<agent>.md` → `~/.agentd/persona/default.md` → none.
- **Reusable personas by name.** `~/.agentd/persona/` holds reusable persona files: the per-agent `<agent>.md`, the shared `default.md`, or any named `<name>.md`. A bare `--persona <name>` (no path separator, no leading `~`; a `.md` suffix is optional) resolves to `~/.agentd/persona/<name>.md` if it exists, else falls back to being treated as a file path. A value with path information (`./x.md`, `dir/x`, `/abs/x.md`, `~/x.md`) is always a path.
- **Generic override = file, session override = flag.** Drop a file in `~/.agentd/persona/` to affect all new sessions with no flag; `--persona <name|path>` overrides it for one session; `--no-persona` suppresses it for one session.
- The resolved host path is stored on the session (`persona` in `schema.ts`) for opt-in resume conflict detection. The mount is part of the container config, so resume needs no re-mount.

## Session transcripts

Every backend persists its session logs to the host so they survive container removal and are available to future tooling (memory, continuous improvement). A backend opts in via `transcriptsDir` (`agents/types.ts`) — the container path where the agent writes its logs: Claude `~/.claude/projects/-workspace`, Codex `~/.codex/sessions`, pi `~/.pi/agent/sessions`, aider `~/.aider/sessions` (aider's chat/input history is redirected there via `--chat-history-file`/`--input-history-file`, out of the repo; its repo-map tags cache `.aider.tags.cache.v4` is a per-repo performance cache, not a session log, so it stays in `/workspace` — aider git-ignores it by default).

- **Mechanism.** On spawn, agentd generates a `transcriptsKey` (UUID), mkdirs `~/.agentd/transcripts/<key>/`, and bind-mounts it over the backend's `transcriptsDir` (`transcriptsMountArg`). The key is stored on the session (`transcriptsKey` in `schema.ts`); the mount is part of the container config, so resume needs no re-mount.
- **No host-config symlink.** agentd deliberately does *not* link the bucket into the host's own agent dir (e.g. `~/.claude/projects/`). The sandbox's transcripts stay under `~/.agentd/` and never merge into the host user's personal history — keeping the container→host boundary intact.
- **Opt out** with `AGENTD_NO_TRANSCRIPTS=1` (no key generated, no mount). Data is kept on `agentd cancel`/`--rm`; remove by hand to delete it.
- **pi caveat.** `transcriptsDir` must be a subdir of the agent's config dir that the agent doesn't rewrite in place — pi's `~/.pi/agent/sessions` is safe, but mounting `~/.pi/agent` itself would block the atomic auth.json rewrite (see `agents/pi.ts`).

## Session fork (`agentd shell --fork <label>`)

Fork spawns a **normal fresh session** in the current dir, seeded with a **copy** of another session's transcript, then resumes it — so the agent continues the conversation while operating on the new directory. The source session stays running, untouched; the two diverge from the copy point. This sidesteps the "migrate a running session to a new dir" trap: Docker bind mounts are fixed at `docker create`, so re-pointing `/workspace` would mean recreating the container and losing its writable layer. Forking recreates nothing.

- **Why it works in the new dir.** The container path is `/workspace` in *both* sessions, so each backend's resume reads the copied transcript from the same place it would its own: Claude `--continue` (project dir encodes to `-workspace`), Codex `resume --last`, pi `-c` (cwd-keyed, and cwd is `/workspace` in both). The conversation's `/workspace` file references transparently resolve to the new dir's files.
- **Gated by `supportsFork`** (`agents/types.ts`), set on claude/codex/pi — backends whose `resumeCommand` reads `transcriptsDir`. aider has no resume, so it's excluded and `--fork` errors for it.
- **Copy, never share.** The fork mints its own `transcriptsKey` and gets an independent copy (`seedTranscriptDir` in `session.ts`, tested with real temp dirs). Bind-mounting one transcript dir into two containers would have both agents appending to the same JSONL and corrupt it.
- **Mechanism.** `cli.ts` resolves the source, forces the new session's agent to the source's (a fork is transcript-level — `--fork` + a conflicting `--codex` errors), forbids an existing target label, and threads `seedTranscriptsFromKey` into spawn. `spawnInteractive` copies the source bucket into the fresh key's dir before `docker create` (best-effort `chown` to the container uid so `--continue` can append on UID-mismatched hosts) and selects `resumeCommand` over `startCommand`. No `schema.ts` change — a fork is just a normal session with a pre-seeded transcript.
- **Config isolation.** A fork inherits only the source's *agent*; ports/mounts/secrets/model/persona come from the fork command's own flags/defaults, never the source.
- **pi auth doesn't carry into a fork.** Claude/Codex forks stay authenticated because their credentials are host files under `~/.agentd/secrets/` that every session mounts. pi is the exception: agentd mounts nothing at pi's credential path (pi rewrites `auth.json` via atomic rename — see `agents/pi.ts`), so its login lives only in the *source container's writable layer* and isn't part of the transcript. A fork is a fresh container, so it starts unauthenticated → pi shows "No API key found for the selected model". Fixes: run `/login` inside the fork, or pass `--secret pi` (an API-key env) to the fork command (a fork doesn't inherit the source's secrets either, by the isolation rule above). This is inherent to pi's auth-in-writable-layer model, not fork-specific — a plain fresh `agentd shell --pi` needs the same.

Note: `claude --continue` continues the copied session under its existing id, so the fork bucket and source bucket hold a file with the same session id that then diverges. Harmless today (buckets aren't cross-referenced — no host symlink). Claude Code's native `--fork-session` flag instead assigns a new id; agentd could adopt it per-backend if future cross-bucket tooling needs globally-unique ids.

## Dashboard (`agentd serve`)

A **read-only** web dashboard for all sessions, in `src/dashboard.ts`. It never starts, stops, or mutates sessions — only `GET` routes, no state changes.

- **Security**: binds `127.0.0.1` only; every request is rejected unless its `Host` header is loopback (`isLoopbackHost`, defeats DNS-rebinding); no CORS headers (browsers block cross-origin reads); the inline page renders all session-derived strings via `textContent`/DOM (never `innerHTML` for data) so labels/paths can't inject markup. **No auth** — assumes a single-user host.
- **Data flow**: `buildStaticViews` is the instant, state.json-only view (served at `?quick=1` for first paint); `collectSessionViews` is the enriched view — status/CPU/mem from two batched Docker calls (`dockerListStates` + `dockerStats`, not per-session inspect), plus per-session transcript reads. Keep pure helpers (`parsePorts`, the transcript parsers, pricing/cost) extracted and unit-tested in `dashboard.test.ts`.
- **Transcript-derived fields are Claude-only** (idle status, last activity, context %, cost, peek) — they parse the Claude Code JSONL; pricing and context-window size are heuristics keyed off the model name. All backends now persist their session logs (see "Session transcripts" above), but the dashboard only parses Claude's format, so those fields stay blank for Codex/aider/pi (gated on `agent === "claude"` in `collectSessionViews`).
- **Idle detection**: `isAwaitingUser` reads the last conversational turn; a staleness fallback (`IDLE_STALE_MS`) marks a running-but-quiet container idle (covers `/clear` and similar, where the transcript shape isn't conclusive).
- **The page** (HTML/CSS/client-JS) is one inline template-literal string, `PAGE`. The client JS deliberately avoids backticks and `${...}` so the whole literal stays a plain string — keep it that way when editing.

## Conventions

- Labels are slugs: `my-project`, `obsidian`, `refactor-auth`
- The default label is the current folder name (e.g. running from `~/code/my-project` → label `my-project`)
- Session status: `running` or `suspended` (stopped container)
- Zod schemas are the source of truth for file formats
- Never log or write secret values — log scope names only
- The container's `agent` user is uid 1000; on hosts where the user UID differs, files written by the container (including persisted transcripts under `~/.agentd/transcripts/`) won't be readable by the host user without a chown.

## Session resume rules

`agentd shell` reuses an existing session if one matches the label. Conflict detection is **opt-in per flag**: only explicitly provided flags are checked against the stored session. Omitted flags accept whatever the session already has.

- No flags → always resumes (no conflict possible)
- `--model opus` → conflicts only if stored model differs
- `--codex` → conflicts only if stored agent differs
- `--port`, `--rm`, `--secret`, `--mount`, `--skip-mount`, `--skip-ports`, `--persona`, `--no-persona` → same pattern

This means `agentd shell <name>` is always a safe way to resume, regardless of how the session was originally created.

`--fork <label>` is the exception: it never resumes. It always creates a new session and **errors if the target label already exists** (pass a new label), so it can't collide with resume.

## Running locally

```bash
make install              # npm install + build + docker build + npm link
agentd shell              # start session (label = folder name, re-run to resume)
agentd shell --codex      # start Codex session instead
agentd shell --model opus # use specific model
agentd ls                 # list sessions
agentd cancel <name>      # remove
```

## Making changes

- **Run `npm run typecheck`, `npm run lint`, and `npm test` after every change.** Verify each step before moving on — don't batch. If any fail with a missing native binding (`MODULE_NOT_FOUND` for oxlint/rolldown), run `npm i` and try again.
- **Run `npm run build` before considering a change complete.**
- **Extract testable logic from side-effecting functions.** Pull decision logic into pure functions and unit test them.
- **Define shared constants once.** When two components must agree on a value, share it or cross-reference with a comment.
- **Keep user-facing surfaces in sync.** When you add or change a CLI command/flag (or its behavior), update all of: this `CLAUDE.md`, `README.md`, and the zsh completions in `completions/_agentd`.

## Test strategy

- Red/green TDD
- Unit test schemas and pure functions
- Test auth/credential precedence
- Do not mock the filesystem — use real temp dirs
- Shell logic should have shell-level tests (execute actual bash)
