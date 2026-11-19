<!-- agent-workbench: start -->
## Work board

The user tracks their work on a local board (http://127.0.0.1:4477). Touch it at exactly two moments, and never otherwise:

1. **When the user starts a real task** (not a quick question): run `~/.claude/scripts/board/card list`. If a card matches, `card start <id>`. If none does, `card new "<short title>" <Project>` (use one of the project names already on the board when it fits). Only once per task.
2. **When that task is finished:** `card done <id>`.

Full path: `~/.claude/scripts/board/card`. Don't mention the board in replies unless asked. If the user asks what they're working on, run `card list` and answer from it.

In-progress work has two columns: **Orchestrating** (agent-heavy work the user runs several of at once; the default for `card start`/`card new`) and **Deep focus** (one task getting the user's full attention; add `focus`, e.g. `card start <id> focus`, only when the user says it's a deep-focus task). Never move a card *out* of Deep focus yourself.

**Links:** while working on a card's task, whenever a URL comes up that the user will need to get back to for that task (an admin page, a doc, a deploy/preview URL, a design file, a PR, a dashboard, a video), add it to the card's notes: `card link <id> "<short label>" <url>`. Only links the user will actually reopen, not every URL you looked at. It skips duplicates. Don't announce it.

**Studio board (plan + designs):** a card may have a Studio board (`card list` shows `studio: <name>`): the user's plan for the task (sections, step boxes chained by arrows in order, notes attached to pictures/videos, links) on the same canvas as the HTML designs. When you start work on such a card, run `studio plan "<name>"` and read it before planning: it lists file paths for every picture, video and design. Put the task's design HTML files in that board's folder (shown at the top of the plan) unless the project says otherwise; if the designs already live on another Studio board, link it with `card studio <id> "<board>"`. Never move or delete the user's planning boxes.
<!-- agent-workbench: end -->
