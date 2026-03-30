#!/bin/bash
# Apply the agentd tmux status bar from environment variables.
#
# Environment:
#   AGENTD_AGENT   - agent backend name (claude, codex, …)
#   AGENTD_LABEL   - session name
#   AGENTD_RM      - "1" if session auto-removes on exit
#   AGENTD_MOUNTS  - display string for mounted host paths (optional)

AGENT=${AGENTD_AGENT:-claude}
LABEL=${AGENTD_LABEL:-session}
RM=${AGENTD_RM:-}
MOUNTS=${AGENTD_MOUNTS:-}

MOUNT_LABEL=""
if [ -n "$MOUNTS" ]; then
  MOUNT_LABEL="#[fg=white,bg=colour88] MOUNTS: ${MOUNTS} "
fi

# Read actual port mappings written by agentd after container start
PORTS_FILE="/tmp/agentd-ports"
PORT_LABEL=""
if [ -f "$PORTS_FILE" ]; then
  PORTS=$(cat "$PORTS_FILE")
  if [ -n "$PORTS" ]; then
    PORT_LABEL="#[fg=white,bg=colour24] PORTS: ${PORTS} "
  fi
fi

VERSION=$(cat /agentd/version 2>/dev/null || echo "dev")
AGENT_UPPER="${AGENT^^}"
RM_LABEL=""
if [ "$RM" = "1" ]; then
  RM_LABEL=" #[fg=colour167,bg=colour236]rm"
fi
STATUS_LEFT="#[fg=black,bg=colour208,bold] SANDBOXED #[fg=colour208,bg=colour236] ${AGENT_UPPER} #[fg=white,bg=colour236,bold] ${LABEL}${RM_LABEL} "

tmux set -g status-left "$STATUS_LEFT" 2>/dev/null
tmux set -g status-left-length 70 2>/dev/null
AUTH_CHECK="#(bash /agentd/check-auth.sh)"
VERSION_LABEL="#[fg=colour245,bg=colour236] ${VERSION} "
tmux set -g status-right "${AUTH_CHECK}${PORT_LABEL}${MOUNT_LABEL}${VERSION_LABEL}" 2>/dev/null
tmux set -g status-right-length 120 2>/dev/null
tmux set -g status-interval 5 2>/dev/null
tmux set -g status-style 'bg=colour236' 2>/dev/null
tmux set -g window-status-format '' 2>/dev/null
tmux set -g window-status-current-format '' 2>/dev/null
