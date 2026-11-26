# Agent Workbench

A local setup for running lots of Claude Code sessions at once without losing track of them, and for designing ads, emails and pages with them on a Figma-style canvas.

- **Work board** (http://127.0.0.1:4477): a kanban with Next · Deep focus · Orchestrating · Done columns. Claude puts a card on it when it starts a task and marks it **Ready for review** when it thinks it's finished. Only you move cards to Done. Marking a card Done closes the Orca tabs of the sessions that were started for it. A long-running session that only picked the task up partway through (say a standing agent you sent on a side quest) stays open. It also saves the links you'll need into the card's notes.
- **Start an agent from a card:** open a card and press **Start**. A new Orca tab opens with Claude in the brand's project folder, on the model you pick (Fable, Opus, Sonnet, Haiku or your default), with the task as its first message. The session links itself to the card. **+ New** adds another session to a card that already has one.
- **Wider card panel:** drag the card panel's left edge to make it wider. Every card opens at that width; double-click the edge to reset.
- **Automations:** tell any agent "hit me back in 30 minutes" or "every weekday at 9, check …" and it sets it up itself (`card remind`). When it's due, the board resumes that agent's conversation in the background, so it keeps its context, even after the card is Done or the session is closed. Results land in the **Automations** tab and as a Mac notification; cards with something pending show a small clock. Pause, change the time, run now or delete from the tab.
- **Notes:** a small button floating on the board; drag it anywhere. Click it for a notes workspace with tabs of pages you write in like Notion (markdown, `/` for headings, to-dos and more). Pages can sit inside other pages: type `/page`, use **+ Add a page inside**, or drag one onto another in the page list. Close tabs and the workspace whenever you like; your pages stay. Saved with the board (`notes.json`), so they're on your phone too.
- **Today's goal:** a line in the Next column. Cards above it are for today, cards below are for later.
- **Search Done:** a search bar on the Done column. It finds titles, notes, links, steps, Studio boards and what you asked each session, and it tolerates typos.
- **Live sessions on every card:**
  - Each Claude session on a card shows its chat, with a shimmering "Thinking" line while it works. Grey means offline.
  - You can send it messages and `/commands` (with suggestions as you type), attach files, stop it, rename it with a double-click, or change its permission mode (Shift+Tab or the mode pill, as in the terminal).
  - Click an offline session to turn it back on.
  - **⑂ Fork** splits a session: a new one in Orca with its whole conversation (`claude --resume <id> --fork-session`), told what to do next, and it joins the same task.
  - When Claude asks you a multiple-choice question, it shows in the chat: click an answer or type your own. Anything you send while it's asking goes in as your answer, so a message can never pick an option by accident.
  - When a session leaves commands running in the background, the chat says so; click it to see each one's latest output.
  - Needs [Orca](https://github.com/stablyai/orca) terminals.
- **Studio** (http://127.0.0.1:4517): a canvas over plain HTML design files.
  - Agents write the HTML. You edit it like Figma: click anything, drag it anywhere (between frames, onto the board, into an email), resize, rotate, retype and restyle. Your edits are written back into the file, and the `studio` CLI tells agents exactly what you changed.
  - Agents learn how to build editable designs when they save one on a board: a hook runs Studio's check and hands them the rules and anything to fix. Sessions that never touch Studio never see it.
  - The side panels open and close (corner buttons, ⌘\ for both).
  - The Claude panel can be dragged anywhere and resized from any edge; ⇥ docks it again.
  - Plan on the same canvas: step boxes chained with arrows, sections, pictures and videos with notes, links, and any file you drop (spreadsheets, PDFs, docs; CSV and Excel files show their first rows, Excel needs Python's openpyxl; double-click opens one in its app). `studio plan` turns the plan into text Claude reads before it starts.
  - Pin comments on any element, then press **Send comments to agent** to hand them all to a session in one go. If the board has several sessions, you pick which one.
  - **Slice** an email into pieces and export them for your email tool, or export any design as PNG/JPG.
  - **Brand grade** any picture (right-click, or Grade on the picture's toolbar): pick a preset, adjust strength, contrast, grain, vignette, saturation and shadow/mid/highlight colour, and see it live on the board. Apply saves a full-size copy with no metadata as one undo step. Save your own presets (kept in Studio's state folder). Needs Python with numpy and Pillow.
  - **Copy image** (right-click or ⌘C) puts any picture on the clipboard to paste anywhere; **Reveal in Finder** shows its file.
  - **AI edits** on pictures (Edit, Erase, Expand, Upscale) run on [Higgsfield](https://higgsfield.ai). The first time you use one, Studio opens Higgsfield's sign-in and then works on your own plan's credits. Everything else works without it.
- **Permanent boards:** every brand/project gets one board per kind of design work (`<Brand> Static Ads`, `<Brand> Emails`, `<Brand> Web`). They are created the first time a task needs one. Each task gets its own folder there, which shows as its own section. Other work (video plans, brainstorms) gets its own board. The board's **Studio** tab lists them, starred ones first.
- **"Waiting on you" tracker:** hooks note when a session finishes its turn. Those sessions show in the status line (`⏳ 2 · fix checkout (4m) …`) and with the `waiting` command.

Everything runs on your machine. No accounts, no cloud (except Higgsfield, if you use its AI edits).

## Install

Needs macOS, [Claude Code](https://claude.com/claude-code), `python3`, `jq` and Node 20+ (`brew install jq node`). [Orca](https://github.com/stablyai/orca) is recommended: install it, then in Orca go to **Settings → Install CLI**.

```bash
git clone https://github.com/donovanjrdamron/agent-workbench.git ~/agent-workbench
cd ~/agent-workbench && ./install.sh
```

Then open a new terminal, restart your Claude sessions, and type `board`.

The installer:
- copies `board/` and `waiting/` to `~/.claude/scripts/`
- installs Studio's packages and puts `board`, `card`, `studio` and `waiting` on your PATH
- adds 6 hooks and a status line to `~/.claude/settings.json`. It backs the file up first and leaves an existing status line alone.
- adds the rules that tell Claude how to use the board and Studio to `~/.claude/CLAUDE.md`, inside `agent-workbench` markers
- keeps the board running in the background with launchd. The board starts Studio when it's needed. Use `--no-service` to skip this.

**To update:** run `git pull && ./install.sh`. Your cards, boards and designs are never overwritten. Keep the repo where you cloned it, because the `studio` command runs from there.

## Using it

| | |
|---|---|
| `board` | open the work board |
| `studio open [board]` | open Studio |
| `card list` / `start <id> [focus]` / `new "<title>" <brand> [focus]` / `done <id>` / `link <id> "<label>" <url>` / `studio <id> [ads\|email\|web\|board]` | what Claude runs (you can too) |
| `studio help` | everything agents can do with Studio |
| `waiting` | sessions waiting on you |

- **Brands:** the colored tags on cards are whatever names you give them, e.g. `card new "Launch emails" Acme`. A card's brand decides which permanent boards its designs go on.
- **Board data** lives in `~/.claude/scripts/board/` (`board.json`). Every save also keeps a snapshot in `history/`.
- **Studio state** lives in `~/Library/Application Support/Studio/`. Board folders (your HTML files) live in `~/Studio/<brand>/…`. Set `STUDIO_HOME` to put them somewhere else.
- **Phone:** if [Tailscale](https://tailscale.com) is running, the board and a review-only Studio are also served on your Tailscale address, so only your own devices can reach them.

## Layout

```
board/       server.py (stdlib only), index.html (board), card (CLI), canvas.html + canvas-assets/ (old per-card canvas)
waiting/     hook scripts + status line + `waiting`
studio/      HTML design canvas (Node/TypeScript): AUTHORING.md is the guide agents read before writing designs
claude/      the CLAUDE.md rules the installer adds
```
