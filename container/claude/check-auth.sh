#!/bin/bash
# Check OAuth credential expiry and output a tmux status segment if expired/expiring.
# Called periodically by tmux status-right via #(bash /agentd/check-auth.sh).
#
# Reads: /home/agent/.claude/.credentials.json
# Output: tmux-formatted warning string, or empty if credentials are OK.

CREDS="${AGENTD_CREDS_FILE:-/home/agent/.claude/.credentials.json}"

if [ ! -f "$CREDS" ]; then
  echo "#[fg=white,bg=colour124,bold] NO CREDS #[fg=colour245,bg=colour236] re-export on host "
  exit 0
fi

EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // empty' "$CREDS" 2>/dev/null)

if [ -z "$EXPIRES_AT" ]; then
  # No expiry field — can't check, assume OK
  exit 0
fi

# Parse expiresAt — handle both epoch millis and ISO 8601
if echo "$EXPIRES_AT" | grep -qE '^[0-9]+$'; then
  # Epoch milliseconds
  EXPIRES_EPOCH=$((EXPIRES_AT / 1000))
else
  # ISO 8601
  EXPIRES_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "$EXPIRES_AT" +%s 2>/dev/null || echo 0)
fi

NOW=$(date +%s)
REMAINING=$((EXPIRES_EPOCH - NOW))

if [ "$REMAINING" -le 0 ]; then
  echo "#[fg=white,bg=colour124,bold] AUTH EXPIRED #[fg=colour245,bg=colour236] re-export creds on host "
elif [ "$REMAINING" -le 300 ]; then
  MINS=$(( (REMAINING + 59) / 60 ))
  echo "#[fg=black,bg=colour214,bold] AUTH ${MINS}m #[fg=colour245,bg=colour236] re-export soon "
fi
