# agentd

Sandboxed AI coding agent sessions. Supports multiple agent backends (Claude Code, OpenAI Codex, aider with local models).

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
  session.ts       ← SessionManager: spawn, attach, cancel, container lifecycle
  store.ts         ← SessionStore: state.json persistence
  docker.ts        ← thin Docker CLI wrappers
  schema.ts        ← zod schemas for session state
  paths.ts         ← ~/.agentd/ path conventions
  agents/
    types.ts       ← AgentBackend interface
    claude.ts      ← Claude Code backend
    codex.ts       ← OpenAI Codex backend
    aider.ts       ← aider backend (local Ollama)
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
completions/
  _agentd          ← zsh completions
~/.agentd/
  state.json       ← active sessions
  secrets/         ← credential files (claude-oauth.json, codex-auth.json, *.env)
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
5. No changes needed in session.ts, store.ts, or cli.ts

The `--myagent` CLI flag is auto-derived from `AGENT_NAMES` in the registry.

For backends that don't need credentials (like aider with local Ollama), set `requiresAuth: false` — this skips secret file lookup and suppresses the no-auth warning. See `src/agents/aider.ts` for the pattern.

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
- `--port`, `--rm`, `--secret`, `--mount`, `--skip-mount`, `--skip-ports` → same pattern

This means `agentd shell <name>` is always a safe way to resume, regardless of how the session was originally created.

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

- **Run `npm run typecheck`, `npm run lint`, and `npm test` after every change.** Verify each step before moving on — don't batch.
- **Run `npm run build` before considering a change complete.**
- **Extract testable logic from side-effecting functions.** Pull decision logic into pure functions and unit test them.
- **Define shared constants once.** When two components must agree on a value, share it or cross-reference with a comment.

## Test strategy

- Red/green TDD
- Unit test schemas and pure functions
- Test auth/credential precedence
- Do not mock the filesystem — use real temp dirs
- Shell logic should have shell-level tests (execute actual bash)
