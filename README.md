# agentd

[![CI](https://github.com/Thegaram/agentd/actions/workflows/ci.yml/badge.svg)](https://github.com/Thegaram/agentd/actions/workflows/ci.yml)

Sandboxed AI coding agent sessions. Run coding agents (Claude Code, OpenAI Codex, aider with local models) in secure Docker containers with all dev tools pre-installed, sensible defaults, and remote control support.

## How it works

Each `agentd shell` session runs inside a Docker container with a tmux session. The agent (Claude Code or Codex) runs inside tmux, so you can detach and re-attach without losing state.

- **Start**: `agentd shell` creates a container, mounts your current directory at `/workspace`, and attaches to the tmux session.
- **Detach**: Press `Ctrl-B D` to detach. The container and agent keep running in the background.
- **Resume**: Run `agentd shell` again in the same directory to re-attach. The agent picks up where it left off.
- **Cancel**: `agentd cancel <name>` stops and removes the container.

If your host terminal is also running tmux, use `Ctrl-B Ctrl-B D` to detach (first prefix passes through to the container's tmux).

## Setup

Requires Docker and Node.js 22+.

```bash
make install    # npm install + build + docker build + npm link
```

### Authentication

```bash
mkdir -p ~/.agentd/secrets && chmod 700 ~/.agentd/secrets
```

#### Claude Code

```bash
# Option 1: OAuth credentials (recommended — enables Max features)
security find-generic-password -a "$USER" -s "Claude Code-credentials" -w 2>/dev/null \
  > ~/.agentd/secrets/claude-oauth.json && chmod 600 ~/.agentd/secrets/claude-oauth.json

# Option 2: API key or setup-token (uses API balance, no Max features)
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.agentd/secrets/claude.env && chmod 600 ~/.agentd/secrets/claude.env
# Or use a token from `claude setup-token`:
# echo "CLAUDE_CODE_OAUTH_TOKEN=..." > ~/.agentd/secrets/claude.env
# Then pass --secret claude when starting a session
```

#### OpenAI Codex

```bash
# Option 1: Copy auth.json from Codex CLI (recommended — uses existing login)
cp ~/.codex/auth.json ~/.agentd/secrets/codex-auth.json && chmod 600 ~/.agentd/secrets/codex-auth.json

# Option 2: API key
echo "CODEX_API_KEY=sk-..." > ~/.agentd/secrets/codex.env && chmod 600 ~/.agentd/secrets/codex.env
# Then pass --secret codex when starting a session
```

#### aider (local models)

No credentials needed. Just have [Ollama](https://ollama.ai) running on the host:

```bash
ollama serve                          # start Ollama (if not already running)
ollama pull qwen2.5-coder:7b          # download a model
```

## Usage

```bash
agentd shell [name] [options]   # start or resume a sandboxed session (mounts cwd by default)
agentd ls --format md           # list active sessions
agentd cancel <label>           # remove container and session
agentd code [label]             # open session in VS Code via Dev Containers
```

The current directory is mounted read-write at `/workspace` by default. Use `--skip-mount` to disable, or `--mount` to specify custom mounts (replaces the default). Port 3000 is published to a random host port by default; use `--port` to override or `--skip-ports` to disable.

### Options

```
--claude                 use Claude Code backend (default)
--codex                  use OpenAI Codex backend
--aider                  use aider backend (local Ollama)
--mount host:container   mount paths (replaces default cwd mount)
--secret scope           secret env files to pass
--model name             model override (agent-specific, e.g. opus, gpt-5.4)
--rm                     auto-remove container on exit
--skip-mount             don't mount current directory
--port [host:]container  port mappings (replaces default 3000)
--skip-ports             don't publish any ports
--dry-run                print the Docker command without executing
```

### Examples

```bash
# Claude session (default — mounts cwd, resumes if session exists)
agentd shell
agentd shell --claude  # explicit

# Custom session label
agentd shell temp

# Codex session
agentd shell --codex

# aider with local Ollama (default model: qwen2.5-coder:7b)
agentd shell --aider

# aider with a different model
agentd shell --aider --model qwen2.5-coder:32b

# Read-only mount (agent can read but not modify host files)
agentd shell --mount .:/workspace:ro

# Multiple secret scopes
agentd shell my-task --secret postgres --secret aws

# Mount ~/.pgpass alongside the local repo
agentd shell my-db --mount .:/workspace --mount ~/.pgpass:/home/agent/.pgpass:ro

# No host mounts at all
agentd shell --skip-mount

# Expose container port 8080 instead of the default 3000
agentd shell --port 8080

# Map specific host port to container port
agentd shell --port 4000:3000

# Multiple ports
agentd shell --port 3000 --port 8080

# No port publishing
agentd shell --skip-ports

# Throwaway session, auto-cleanup on exit
agentd shell --rm

# Preview the Docker command without starting anything
agentd shell --dry-run
agentd shell my-task --mount .:/workspace:ro --secret aws --dry-run
```

## Security

Containers are hardened by default:

- **Capability drop**: `--cap-drop ALL --security-opt no-new-privileges`
- **Cloud metadata blocked**: IMDS endpoints (169.254.169.254, metadata.google.internal) resolve to localhost
- **Credentials read-only**: secret files mounted `:ro`, agents cannot write back to host
- **Non-root**: sessions run as `agent` user (UID 1000)

**Be aware of what you mount.** The agent has full read access to anything mounted into `/workspace`, including git history, config files, and embedded secrets. Mounted content may be sent to Anthropic or OpenAI servers as part of the agent's conversation context. If the agent is compromised or tricked via prompt injection, mounted data could also be exfiltrated over the network. Avoid mounting directories containing credentials or sensitive data you don't want exposed.

## Dev tools in the container

Node.js 22 (npm, pnpm, yarn), Python 3 + uv, Go, Rust, Foundry + solc, GitHub CLI, ripgrep, fd, jq, yq, sqlite3, postgresql-client, build-essential, LSP servers (typescript-language-server, pyright, gopls, rust-analyzer), and more.
