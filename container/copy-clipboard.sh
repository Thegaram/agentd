#!/bin/bash
set -euo pipefail

client_tty="$(tmux display-message -p '#{client_tty}' 2>/dev/null || true)"
[ -n "$client_tty" ] && [ -w "$client_tty" ] || exit 0

payload="$(base64 | tr -d '\r\n')"
[ -n "$payload" ] || exit 0

osc52="$(printf '\033]52;c;%s\a' "$payload")"

# Try the direct OSC 52 path first. This works for normal terminals and for
# outer tmux instances configured with `set-clipboard on`.
printf '%s' "$osc52" > "$client_tty"

client_term="$(tmux display-message -p '#{client_termname}' 2>/dev/null || true)"
case "$client_term" in
  tmux*|screen*)
    # When the client is another tmux/screen-like terminal, send the same OSC 52
    # through tmux passthrough so the outer layer can forward it unchanged.
    escaped="${osc52//$'\033'/$'\033\033'}"
    printf '%b' "\033Ptmux;${escaped}\033\\" > "$client_tty"
    ;;
esac
