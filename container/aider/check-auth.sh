#!/bin/bash
# Check Ollama reachability and output a tmux status segment.
# Called periodically by tmux status-right via #(bash /agentd/check-auth.sh).

OLLAMA_URL="${OLLAMA_URL:-http://host.docker.internal:11434}"

if curl -sf --max-time 1 "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
  exit 0
fi

echo "#[fg=white,bg=colour124,bold] NO OLLAMA #[fg=colour245,bg=colour236] start ollama on host "
