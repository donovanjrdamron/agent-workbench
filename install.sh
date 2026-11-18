#!/bin/bash
# Installs the work board + "waiting on you" tracker for Claude Code. Safe to re-run.
#   ./install.sh            install / update
#   ./install.sh --service  also keep the board server running in the background (macOS launchd)
set -e
cd "$(dirname "$0")"
command -v jq >/dev/null || { echo "Needs jq:  brew install jq"; exit 1; }
command -v python3 >/dev/null || { echo "Needs python3"; exit 1; }
S="$HOME/.claude/scripts"; mkdir -p "$S/board" "$S/waiting"

# 1. code (your data in board.json / canvases / media is never touched)
rsync -a --exclude 'board.json*' --exclude history --exclude canvases --exclude media --exclude src board/ "$S/board/"
rsync -a waiting/ "$S/waiting/"
chmod +x "$S/board/card" "$S/board/board" "$S/waiting/"*
[ -f "$S/board/board.json" ] || echo '{"brands":[],"cards":[]}' > "$S/board/board.json"
echo "✓ scripts in $S"

# 2. hooks + status line in ~/.claude/settings.json
SET="$HOME/.claude/settings.json"; [ -f "$SET" ] || echo '{}' > "$SET"
cp "$SET" "$SET.pre-workbench.bak"
W="$S/waiting"
jq --arg mark "$W/mark.sh" --arg clear "$W/clear.sh" --arg sl "$W/statusline.sh" '
  def add(ev; cmd; t): .hooks[ev] = ((.hooks[ev] // []) | if any(.[]?; .hooks[]?.command == cmd) then . else . + [{hooks:[{type:"command",command:cmd,timeout:t}]}] end);
  add("Stop"; $mark; 10) | add("StopFailure"; $mark; 10) | add("UserPromptSubmit"; $clear; 5) | add("SessionEnd"; $clear; 5)
  | if .statusLine == null then .statusLine = {type:"command",command:$sl,padding:0} else . end
' "$SET.pre-workbench.bak" > "$SET"
if [ "$(jq -r '.statusLine.command' "$SET")" != "$W/statusline.sh" ]; then
  echo "! You already have a status line, so it was left alone. To show waiting sessions, point it at $W/statusline.sh"
fi
echo "✓ hooks added (backup: $SET.pre-workbench.bak)"

# 3. rules so Claude uses the board
MD="$HOME/.claude/CLAUDE.md"; touch "$MD"
if ! grep -q "agent-workbench: start" "$MD"; then printf '\n' >> "$MD"; cat claude/CLAUDE.md >> "$MD"; echo "✓ board rules added to $MD"; else echo "✓ board rules already in $MD"; fi

# 4. commands on PATH: board, card, waiting
RC="$HOME/.zshrc"; [ -n "$BASH_VERSION" ] && [ "${SHELL##*/}" = bash ] && RC="$HOME/.bashrc"
grep -q 'claude/scripts/board' "$RC" 2>/dev/null || printf '\nexport PATH="$HOME/.claude/scripts/waiting:$HOME/.claude/scripts/board:$PATH"\n' >> "$RC"
echo "✓ PATH set in $RC (open a new terminal)"

# 5. optional background service
if [ "$1" = "--service" ] && [ "$(uname)" = Darwin ]; then
  P="$HOME/Library/LaunchAgents/com.local.workboard.plist"
  cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.workboard</string>
  <key>ProgramArguments</key><array><string>$(command -v python3)</string><string>$S/board/server.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$S/board/server.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/com.local.workboard" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
  echo "✓ board server runs in the background"
fi
echo; echo "Done. Restart your Claude sessions, then type:  board"
