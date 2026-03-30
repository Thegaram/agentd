#!/bin/bash
# Two-line statusline: model/folder/branch + progress bar/cost/duration
# Adapted from trailofbits/claude-code-config

stdin_data=$(cat)

IFS=$'\t' read -r current_dir model_name cost duration_ms ctx_used cache_pct < <(
    echo "$stdin_data" | jq -r '[
        .workspace.current_dir // "unknown",
        .model.display_name // "Unknown",
        (try (.cost.total_cost_usd // 0 | . * 100 | floor / 100) catch 0),
        (.cost.total_duration_ms // 0),
        (try (
            if (.context_window.remaining_percentage // null) != null then
                100 - (.context_window.remaining_percentage | floor)
            elif (.context_window.context_window_size // 0) > 0 then
                (((.context_window.current_usage.input_tokens // 0) +
                  (.context_window.current_usage.cache_creation_input_tokens // 0) +
                  (.context_window.current_usage.cache_read_input_tokens // 0)) * 100 /
                 .context_window.context_window_size) | floor
            else "null" end
        ) catch "null"),
        (try (
            (.context_window.current_usage // {}) |
            if (.input_tokens // 0) + (.cache_read_input_tokens // 0) > 0 then
                ((.cache_read_input_tokens // 0) * 100 /
                 ((.input_tokens // 0) + (.cache_read_input_tokens // 0))) | floor
            else 0 end
        ) catch 0)
    ] | @tsv'
)

rl_5h=$(echo "$stdin_data" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null | cut -d. -f1)
rl_7d=$(echo "$stdin_data" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null | cut -d. -f1)
rl_5h_resets=$(echo "$stdin_data" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
rl_7d_resets=$(echo "$stdin_data" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)

if [ -z "$current_dir" ] && [ -z "$model_name" ]; then
    current_dir=$(echo "$stdin_data" | jq -r '.workspace.current_dir // "unknown"' 2>/dev/null)
    model_name=$(echo "$stdin_data" | jq -r '.model.display_name // "Unknown"' 2>/dev/null)
    cost=$(echo "$stdin_data" | jq -r '(.cost.total_cost_usd // 0)' 2>/dev/null)
    duration_ms=$(echo "$stdin_data" | jq -r '(.cost.total_duration_ms // 0)' 2>/dev/null)
    ctx_used=""
    cache_pct="0"
fi

if cd "$current_dir" 2>/dev/null; then
    git_branch=$(git -c core.useBuiltinFSMonitor=false branch --show-current 2>/dev/null)
    git_root=$(git -c core.useBuiltinFSMonitor=false rev-parse --show-toplevel 2>/dev/null)
fi

if [ -n "$git_root" ]; then
    folder_name=$(basename "$git_root")
else
    folder_name=$(basename "$current_dir")
fi

# fmt_countdown <epoch_timestamp>
# Outputs human-readable time until reset (e.g. "2h13m", "45m", "3d2h")
fmt_countdown() {
    local resets_at=$1
    [ -z "$resets_at" ] && return
    local now
    now=$(date +%s)
    local diff=$((resets_at - now))
    [ "$diff" -le 0 ] && { printf 'now'; return; }
    local days=$((diff / 86400))
    local hours=$(( (diff % 86400) / 3600 ))
    local mins=$(( (diff % 3600) / 60 ))
    if [ "$days" -gt 0 ]; then
        printf '%dd%dh' "$days" "$hours"
    elif [ "$hours" -gt 0 ]; then
        printf '%dh%02dm' "$hours" "$mins"
    else
        printf '%dm' "$mins"
    fi
}

# make_bar <label> <percentage> [<bar_width> [<resets_at>]]
# Outputs: "label [████⣿⣿⣿⣿] xx% ↻2h13m" with color based on percentage
make_bar() {
    local label=$1 pct=$2 width=${3:-8} resets_at=${4:-}
    local filled=$((pct * width / 100))
    local empty_=$((width - filled))
    local color
    if [ "$pct" -lt 50 ]; then color='\033[32m'
    elif [ "$pct" -lt 80 ]; then color='\033[33m'
    else color='\033[31m'; fi
    local bar="${color}"
    for ((i=0; i<filled; i++)); do bar="${bar}█"; done
    bar="${bar}\033[2m"
    for ((i=0; i<empty_; i++)); do bar="${bar}⣿"; done
    bar="${bar}\033[0m"
    local reset_str=""
    if [ -n "$resets_at" ]; then
        reset_str=$(printf ' \033[2m↻%s\033[0m' "$(fmt_countdown "$resets_at")")
    fi
    printf '\033[2m%s\033[0m %b \033[37m%s%%\033[0m%b' "$label" "$bar" "$pct" "$reset_str"
}

if [ "$duration_ms" -gt 0 ] 2>/dev/null; then
    total_sec=$((duration_ms / 1000))
    hours=$((total_sec / 3600))
    minutes=$(((total_sec % 3600) / 60))
    seconds=$((total_sec % 60))
    if [ "$hours" -gt 0 ]; then
        session_time="${hours}h ${minutes}m"
    elif [ "$minutes" -gt 0 ]; then
        session_time="${minutes}m ${seconds}s"
    else
        session_time="${seconds}s"
    fi
else
    session_time=""
fi

SEP='\033[2m|\033[0m'
short_model=$(echo "$model_name" | sed -E 's/Claude [0-9.]+ //; s/^Claude //')

line1=$(printf '\033[37m[%s]\033[0m \033[94m%s\033[0m' "$short_model" "$folder_name")
if [ -n "$git_branch" ]; then
    line1="$line1 $(printf '%b \033[96m%s\033[0m' "$SEP" "$git_branch")"
fi

line2=""
if [ -n "$ctx_used" ] && [ "$ctx_used" != "null" ]; then
    line2="$(make_bar ctx "$ctx_used")"
fi
if [ -n "$rl_5h" ]; then
    [ -n "$line2" ] && line2="$line2 $(printf '%b ' "$SEP")"
    line2="${line2}$(make_bar 5h "$rl_5h" 8 "$rl_5h_resets")"
fi
if [ -n "$rl_7d" ]; then
    [ -n "$line2" ] && line2="$line2 $(printf '%b ' "$SEP")"
    line2="${line2}$(make_bar 7d "$rl_7d" 8 "$rl_7d_resets")"
fi
if [ -n "$line2" ]; then
    line2="$line2 $(printf '%b \033[33m$%s\033[0m' "$SEP" "$cost")"
else
    line2=$(printf '\033[33m$%s\033[0m' "$cost")
fi
if [ -n "$session_time" ]; then
    line2="$line2 $(printf '%b \033[36m%s\033[0m' "$SEP" "$session_time")"
fi
if [ "$cache_pct" -gt 0 ] 2>/dev/null; then
    line2="$line2 $(printf ' \033[2m↻%s%%\033[0m' "$cache_pct")"
fi

printf '%b\n\n%b' "$line1" "$line2"
