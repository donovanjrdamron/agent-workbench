#!/usr/bin/env python3
"""PostToolUse hook (Write/Edit/MultiEdit). When a session saves an HTML file inside a Studio board folder, tell it how
designs must be built so the user can edit them like Figma (once per session), and what Studio's check found in that
file. Sessions that never touch a Studio board never hear from this."""
import json, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.environ.get("STUDIO_URL", "http://127.0.0.1:4517")
SEEN = os.path.join(os.environ.get("TMPDIR", "/tmp"), "studio-hook-sessions")

def authoring():
    for c in (os.environ.get("STUDIO_CLI"), os.path.join(HERE, "studio")):
        if c and os.path.exists(c): return os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(c))), "AUTHORING.md")
    return "AUTHORING.md (next to the studio command)"

RULES = """This file is on a Studio board: the user edits it by hand like Figma (drags, drops, scales and retypes any piece anywhere). Build it so every piece is easy to grab:
- One artboard: <div class="ad" style="width:…px;height:…px">. Every piece sits directly in it, position:absolute with inline left/top. Ads AND emails: an email is a 600px artboard with one absolute band per section (left:0;top:…;width:600px;height:…), its pieces placed by left/top inside. No tables, flow layout or margin stacking while designing; make sendable email HTML only when asked.
- Each thing the user might touch is its own element with a clear class name (it is their layer name): one text block per element (only inline tags inside), every picture an <img> (never a CSS background).
- Never: ::before/::after with visible content, !important, pointer-events:none, scripts that build content, scale()/rotate() on containers.
- Load every font used; put the palette on :root as custom properties.
- If the user has already touched the design: run `studio changes` and `studio comments` first, edit in place and keep their inline styles and positions.
- Run `studio check <board> <design>` before handing it over. Full guide: {guide}"""

def main():
    try: d = json.load(sys.stdin)
    except Exception: return
    path = (d.get("tool_input") or {}).get("file_path") or ""
    if not path.lower().endswith((".html", ".htm")): return
    try: boards = json.load(urllib.request.urlopen(STUDIO + "/api/boards", timeout=2)).get("boards", [])
    except Exception: return   # Studio isn't running: nothing to check against
    real = os.path.realpath(path)
    hit = None
    for b in boards:
        root = os.path.realpath(b.get("root") or "")
        if root and real.startswith(root + os.sep) and (not hit or len(root) > len(hit[1])): hit = (b["name"], root)
    if not hit: return
    board, root = hit
    design = os.path.relpath(real, root)
    if design.split(os.sep)[0] in ("loose", "studio-assets"): return
    out = []
    os.makedirs(SEEN, exist_ok=True)
    mark = os.path.join(SEEN, (d.get("session_id") or "x").replace("/", "_"))
    if not os.path.exists(mark):
        open(mark, "w").close()
        out.append(RULES.replace("{guide}", authoring()))
    fixes = []
    try:
        url = f"{STUDIO}/api/check?board={urllib.parse.quote(board)}&design={urllib.parse.quote(design)}"
        r = json.load(urllib.request.urlopen(url, timeout=8))
        for res in r.get("results", []):
            fixes += [f["msg"] for f in res.get("findings", []) if f.get("level") == "fix"]
    except Exception: pass
    if fixes: out.append(f"Studio check on {design} (board \"{board}\") found what makes it hard for the user to edit. Fix it now:\n" + "\n".join(f"- {m}" for m in fixes))
    if not out: return
    msg = "\n\n".join(out)
    if fixes: print(json.dumps({"decision": "block", "reason": msg}))
    else: print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))

import urllib.parse
main()
