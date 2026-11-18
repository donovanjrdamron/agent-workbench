#!/bin/bash
# Status line: keep Orca's status line, then add sessions waiting on you.
source "$HOME/.claude/scripts/waiting/lib.sh"
input=$(cat)
ORCA="$HOME/.orca/agent-hooks/claude-statusline.sh"
if [ -x "$ORCA" ]; then
  orca_out=$(printf '%s' "$input" | /bin/sh "$ORCA" 2>/dev/null)
  [ -n "$orca_out" ] && printf '%s\n' "$orca_out"
fi
me=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
prune_dead
now=$(date +%s); items=(); n=0
while IFS=$'\t' read -r sid ts title; do
  [ -z "$sid" ] || [ "$sid" = "$me" ] && continue
  n=$((n+1))
  [ ${#items[@]} -lt 4 ] && items+=("$(cut -c1-28 <<<"$title") ($(human_age $((now-ts))))")
done < <(cat "$WAIT_DIR"/*.json 2>/dev/null | jq -rs 'sort_by(.ts)[] | [.sid,(.ts|tostring),.title] | @tsv')
if [ "$n" -gt 0 ]; then
  line=$(printf ' · %s' "${items[@]}")
  more=""; [ "$n" -gt 4 ] && more=" · +$((n-4)) more"
  printf '\033[33m⏳ %d%s%s\033[0m\n' "$n" "$line" "$more"
fi
