#!/bin/bash
# Stop hook: this session finished its turn and is now waiting on you.
source "$HOME/.claude/scripts/waiting/lib.sh"
input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input")
[ -z "$sid" ] && exit 0
cwd=$(jq -r '.cwd // empty' <<<"$input")
transcript=$(jq -r '.transcript_path // empty' <<<"$input")
last=$(jq -r '.last_assistant_message // empty' <<<"$input")
if [ -z "$last" ] && [ -f "$transcript" ]; then
  last=$(tail -c 400000 "$transcript" | tail -n 200 | grep '"type":"assistant"' | tail -1 \
    | jq -r '[.message.content[]? | select(.type=="text") | .text] | join(" ")' 2>/dev/null)
fi
last=$(tr '\n' ' ' <<<"$last" | cut -c1-200)
jq -n --arg sid "$sid" --arg cwd "$cwd" --arg title "$(session_title "$transcript" "$cwd")" \
      --arg last "$last" --arg pid "$(find_claude_pid)" --argjson ts "$(date +%s)" \
      '{sid:$sid,cwd:$cwd,title:$title,last:$last,pid:$pid,ts:$ts}' > "$WAIT_DIR/$sid.json"
write_session waiting "$input"
exit 0
