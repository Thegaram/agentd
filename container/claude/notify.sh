#!/bin/bash
set -euo pipefail

# Claude Code Notification hook: ring terminal bell on blocking prompts.
# Most terminals (iTerm2, Terminal.app) surface this as a dock bounce
# or tab notification when the window is not focused.

TYPE=$(jq -r '.notification_type // "unknown"' 2>/dev/null || echo "unknown")

case "$TYPE" in
  permission_prompt|idle_prompt)
    TTY=$(tmux display-message -p -t agent '#{pane_tty}' 2>/dev/null) \
      && printf '\a' > "$TTY" \
      || true
    ;;
esac
