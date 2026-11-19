# Agent Workbench

A local setup for running lots of Claude Code sessions at once without losing track of them.

- **Work board**: a Notion-style kanban at http://127.0.0.1:4477 (Next · Deep focus · Orchestrating · Done). Claude moves cards itself when it starts and finishes a task, and adds the links you'll need to the card's notes.
- **A Studio board per card**: the **Studio ↗** button on a card opens that task's board in Studio, so you plan and design in one place. Planning tools: step boxes with + buttons to chain the next step, sections, pictures and videos with notes attached, and links. The ad/email HTML frames sit on the same canvas. `studio plan <board>` turns it all into plain language, and Claude reads that before it plans the task.
- **Live session in the card**: each card shows its Claude session's status (working / waiting) and its chat, in the card and in a Claude panel in Studio. You can send a follow-up from there (needs [Orca](https://github.com/stablyai/orca) terminals).
- **"Waiting on you" tracker**: hooks that note when a session finishes and is waiting on you. They show in the status line (`⏳ 2 · fix checkout (4m) …`) and with the `waiting` command.
- **Studio**: a Figma-style canvas over HTML design files (ads, emails, carousels). Agents write HTML and you drag, retype and comment by hand. Your edits are written back into the file, and the `studio` CLI tells agents what you changed.

Everything runs on your machine. No accounts, no cloud.

## Install

Needs macOS (Linux mostly works), `python3`, `jq`, and Node 20+ for Studio.

```bash
git clone <this repo> && cd agent-workbench
./install.sh --service      # --service keeps the board running in the background (macOS)
```

The installer:
- copies `board/` and `waiting/` to `~/.claude/scripts/`
- adds 4 hooks and a status line to `~/.claude/settings.json` (backs it up first, and leaves an existing status line alone)
- appends the board rules to `~/.claude/CLAUDE.md`
- puts `board`, `card` and `waiting` on your PATH

Re-run it any time to update. Your cards, canvases and media are never overwritten. Then restart your Claude sessions and type `board`.

### Studio

```bash
cd studio && npm install
npm start                    # http://127.0.0.1:4517
ln -s "$PWD/bin/studio" /usr/local/bin/studio   # agent CLI: studio help
```

Point Claude at it from a project's `CLAUDE.md`: *"For HTML designs, read `<path>/studio/AUTHORING.md` before writing design HTML, then `README.md`. Run `studio changes` and `studio comments` before editing a file and `studio check` before handing one over."* State lives in `~/Library/Application Support/Studio/` (override with `STUDIO_DIR`).

## Using the board

| | |
|---|---|
| `board` | open it |
| `card list` / `start <id> [focus]` / `new "<title>" <project> [focus]` / `done <id>` / `link <id> "<label>" <url>` / `studio <id> [board]` | what Claude runs (you can too) |
| `waiting` | sessions waiting on you |

- Projects (the colored tags) are whatever names you give cards, e.g. `card new "Launch emails" Acme`.
- Data lives in `~/.claude/scripts/board/` (`board.json`; every save also keeps a snapshot in `history/`). Each card's Studio board folder is `~/Studio/<project>/<card title>/`.
- Studio must be on your PATH as `studio` (see the Studio step above) so the board can start it. Or set `STUDIO_CLI` to the path of `studio/bin/studio`.
- The old per-card Excalidraw canvas is still included (`/canvas/<id>`). It is used on the phone, where Studio can't be reached, and `board/canvas_to_studio.py` moves one onto its Studio board.
- **Phone:** if [Tailscale](https://tailscale.com) is running, the board is also served on your Tailscale IP, so only your own devices can reach it.

## Layout

```
board/       server.py (stdlib only), index.html (board), canvas.html + canvas-assets/ (built canvas),
             card (CLI), canvas_digest.py (canvas -> outline for Claude), src/canvas/ (canvas source)
waiting/     hook scripts + status line + `waiting`
studio/      HTML design canvas (Node/TypeScript)
claude/      the CLAUDE.md rules the installer adds
```

Rebuild the canvas after editing `board/src/canvas/app.jsx`:

```bash
cd board/src/canvas && npm i @excalidraw/excalidraw@0.18.0 react@19 react-dom@19 esbuild@0.24
npx esbuild app.jsx --bundle --minify --format=esm --jsx=automatic --loader:.woff2=file \
  '--define:process.env.NODE_ENV="production"' '--define:process.env.IS_PREACT="false"' \
  --outdir=../../canvas-assets --entry-names=canvas '--chunk-names=chunk-[hash]' --splitting
```
