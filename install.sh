#!/bin/bash
# Installs the work board, the "waiting on you" tracker and Studio for Claude Code. Safe to re-run (it also updates).
#   ./install.sh               install / update, and keep the board running in the background (macOS)
#   ./install.sh --no-service  skip the background service
set -e
cd "$(dirname "$0")"
REPO="$PWD"
command -v jq >/dev/null || { echo "Needs jq:  brew install jq"; exit 1; }
command -v python3 >/dev/null || { echo "Needs python3"; exit 1; }
command -v node >/dev/null || { echo "Needs Node 20+ for Studio:  brew install node"; exit 1; }
S="$HOME/.claude/scripts"; mkdir -p "$S/board" "$S/waiting"

# 1. code (your cards, boards, canvases and media are never touched)
rsync -a --exclude 'board.json*' --exclude 'kept.json' --exclude 'permanents.json' --exclude 'projects.json' --exclude history --exclude canvases \
  --exclude media --exclude src --exclude '*.bak' --exclude '*.log' --exclude __pycache__ board/ "$S/board/"
rsync -a --exclude '*.bak' waiting/ "$S/waiting/"
chmod +x "$S/board/card" "$S/board/board" "$S/board/studio_hook.py" "$S/waiting/"*
[ -f "$S/board/board.json" ] || echo '{"brands":[],"cards":[]}' > "$S/board/board.json"
echo "✓ scripts in $S"

# 2. Studio: its packages, and the `studio` command (linked next to `card`, so it is on PATH and the board finds it)
(cd studio && npm install --no-audit --no-fund --loglevel=error)
chmod +x studio/bin/studio
ln -sfn "$REPO/studio/bin/studio" "$S/board/studio"
echo "✓ Studio ready (studio help)"

# 3. hooks + status line in ~/.claude/settings.json
SET="$HOME/.claude/settings.json"; [ -f "$SET" ] || echo '{}' > "$SET"
cp "$SET" "$SET.pre-workbench.bak"
W="$S/waiting"
jq --arg mark "$W/mark.sh" --arg clear "$W/clear.sh" --arg start "$W/start.sh" --arg sl "$W/statusline.sh" --arg sh "$S/board/studio_hook.py" '
  def add(ev; cmd; t; m): .hooks[ev] = ((.hooks[ev] // []) | if any(.[]?; .hooks[]?.command == cmd) then . else . + [{hooks:[{type:"command",command:cmd,timeout:t}]} + (if m then {matcher:m} else {} end)] end);
  add("Stop"; $mark; 10; null) | add("StopFailure"; $mark; 10; null) | add("UserPromptSubmit"; $clear; 5; null)
  | add("SessionEnd"; $clear; 5; null) | add("SessionStart"; $start; 10; "startup|resume")
  | add("PostToolUse"; $sh; 15; "Write|Edit|MultiEdit")
  | if .statusLine == null then .statusLine = {type:"command",command:$sl,padding:0} else . end
' "$SET.pre-workbench.bak" > "$SET"
if [ "$(jq -r '.statusLine.command' "$SET")" != "$W/statusline.sh" ]; then
  echo "! You already have a status line, so it was left alone. To show waiting sessions, point it at $W/statusline.sh"
fi
echo "✓ hooks added (backup: $SET.pre-workbench.bak)"

# 4. rules so Claude uses the board and Studio (replaced in place on updates)
MD="$HOME/.claude/CLAUDE.md"; touch "$MD"
RULES=$(sed "s|__STUDIO__|$REPO/studio|g" claude/CLAUDE.md)
python3 - "$MD" "$RULES" <<'PY'
import re, sys
p, rules = sys.argv[1], sys.argv[2]
s = open(p).read()
pat = re.compile(r"<!-- agent-workbench: start -->.*?<!-- agent-workbench: end -->", re.S)
s = pat.sub(lambda m: rules, s) if pat.search(s) else s.rstrip("\n") + ("\n\n" if s.strip() else "") + rules + "\n"
open(p, "w").write(s)
PY
echo "✓ board rules in $MD"

# 5. commands on PATH: board, card, studio, waiting
RC="$HOME/.zshrc"; [ "${SHELL##*/}" = bash ] && RC="$HOME/.bashrc"
grep -q 'claude/scripts/board' "$RC" 2>/dev/null || printf '\nexport PATH="$HOME/.claude/scripts/waiting:$HOME/.claude/scripts/board:$PATH"\n' >> "$RC"
echo "✓ PATH set in $RC (open a new terminal)"

# 6. Orca (sends messages to sessions and turns them back on from the board and Studio)
if command -v orca >/dev/null || [ -x /usr/local/bin/orca ]; then echo "✓ Orca CLI found"
else echo "! Orca CLI not found. Install Orca (https://github.com/stablyai/orca), then in Orca: Settings → Install CLI. Everything else works without it."; fi

# 7. background service: the board (it starts Studio when needed)
if [ "$1" != "--no-service" ] && [ "$(uname)" = Darwin ]; then
  P="$HOME/Library/LaunchAgents/com.local.workboard.plist"
  BINPATH="$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.workboard</string>
  <key>ProgramArguments</key><array><string>$(command -v python3)</string><string>$S/board/server.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$BINPATH</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$S/board/server.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/com.local.workboard" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$P"
  echo "✓ board runs in the background: http://127.0.0.1:4477"
fi
echo; echo "Done. Restart your Claude sessions, then type:  board"
