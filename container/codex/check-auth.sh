#!/bin/bash
# Check Codex credential status and output a tmux status segment.
# Called periodically by tmux status-right via #(bash /agentd/check-auth.sh).
#
# Reads: /home/agent/.codex/auth.json (file-based credentials)
# Falls back to checking CODEX_API_KEY / OPENAI_API_KEY env vars.

CREDS="${AGENTD_CREDS_FILE:-/home/agent/.codex/auth.json}"

if [ -f "$CREDS" ]; then
  # File-based credentials exist — assume OK (Codex auth.json doesn't have expiry)
  exit 0
fi

# No credential file — check for env var auth
if [ -n "$CODEX_API_KEY" ] || [ -n "$OPENAI_API_KEY" ]; then
  exit 0
fi

echo "#[fg=white,bg=colour124,bold] NO CREDS #[fg=colour245,bg=colour236] set CODEX_API_KEY "
