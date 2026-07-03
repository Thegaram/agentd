#!/bin/bash
set -euo pipefail

# Check Codex credential status and output a tmux status segment.
# Called periodically by tmux status-right via #(bash /agentd/check-auth.sh).
#
# Reads: /home/agent/.codex/auth.json (file-based credentials, primary)
#        /run/secrets/codex.env (env-var fallback: CODEX_API_KEY / OPENAI_API_KEY)
#
# Note: this runs under tmux's server environment (not the pane's), so the
# --secret codex.env vars are NOT in scope here — inspect the secret file
# directly rather than checking $CODEX_API_KEY / $OPENAI_API_KEY.

CREDS="${AGENTD_CREDS_FILE:-/home/agent/.codex/auth.json}"
ENV_FILE="${AGENTD_CODEX_ENV_FILE:-/run/secrets/codex.env}"

# File-based credentials exist — assume OK (Codex auth.json doesn't have expiry).
if [ -f "$CREDS" ]; then
  exit 0
fi

# API-key fallback: key present in the mounted secret file.
if [ -f "$ENV_FILE" ] &&
  grep -qE '^[[:space:]]*(export[[:space:]]+)?(CODEX_API_KEY|OPENAI_API_KEY)=' "$ENV_FILE"; then
  exit 0
fi

echo "#[fg=white,bg=colour124,bold] NO CREDS #[fg=colour245,bg=colour236] set CODEX_API_KEY "
