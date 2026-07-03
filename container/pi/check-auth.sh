#!/bin/bash
set -euo pipefail

# Check pi credential status and output a tmux status segment.
# Called periodically by tmux status-right via #(bash /agentd/check-auth.sh).
#
# Reads: /home/agent/.pi/agent/auth.json (subscription/OAuth or stored creds)
#        /run/secrets/pi.env (env-var fallback: provider API keys)
#
# Note: this runs under tmux's server environment (not the pane's), so the
# --secret pi.env vars are NOT in scope here — inspect the secret file directly
# rather than checking $OPENAI_API_KEY etc.

CREDS="${AGENTD_CREDS_FILE:-/home/agent/.pi/agent/auth.json}"
ENV_FILE="${AGENTD_PI_ENV_FILE:-/run/secrets/pi.env}"

# Login/subscription credentials (written by /login, persisted in the layer).
if [ -f "$CREDS" ]; then
  exit 0
fi

# API-key fallback: any provider *_API_KEY in the mounted secret file.
if [ -f "$ENV_FILE" ] &&
  grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*_API_KEY=' "$ENV_FILE"; then
  exit 0
fi

echo "#[fg=white,bg=colour124,bold] NO CREDS #[fg=colour245,bg=colour236] set a provider API key or /login "
