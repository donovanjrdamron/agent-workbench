<!-- agent-workbench: start -->
## Work board

The user tracks their work on a local board (http://127.0.0.1:4477). Touch it at exactly two moments, and never otherwise:

1. **When the user starts a real task** (not a quick question): run `~/.claude/scripts/board/card list`. If a card matches, `card start <id>`. If none does, `card new "<short title>" <Project>` (use one of the project or brand names already on the board when it fits). Only once per task.
2. **When you think that task is finished:** `card done <id>`. This only marks the card "Ready for review": it stays in its column and your session stays open. Never move a card to Done any other way (only the user does that, and doing so closes its sessions).

Full path: `~/.claude/scripts/board/card`. Don't mention the board in replies unless asked. If the user asks what they're working on, run `card list` and answer from it.

In-progress work has two columns: **Orchestrating** (agent-heavy work the user runs several of at once; the default for `card start`/`card new`) and **Deep focus** (one task getting the user's full attention; add `focus`, e.g. `card start <id> focus`, only when the user says it's a deep-focus task). Never move a card *out* of Deep focus yourself.

**Links:** while working on a card's task, whenever a URL comes up that the user will need to get back to for that task (an admin page, a doc, a deploy/preview URL, a design file, a PR, a dashboard, a video), add it to the card's notes: `card link <id> "<short label>" <url>`. Only links the user will actually reopen, not every URL you looked at. It skips duplicates. Don't announce it.

**Studio board (plan + designs):** a card may have a Studio board (`card list` shows `studio: <name>`): the user's plan for the task (sections, step boxes chained by arrows in order, notes attached to pictures/videos, links) on the same canvas as the HTML designs. When you start work on such a card, run `studio plan "<name>"` and read it before planning: it lists file paths for every picture, video and design. Before writing any design HTML for a Studio board (ads, emails, pages), read `__STUDIO__/AUTHORING.md` and follow it (an email declares its width with `<meta name="studio:width" content="600">`), and run `studio check` before handing it over. When the user sends you their comments from Studio, handle each one and answer it with `studio reply "<board>" <id> "what you changed" --resolve`.

**Permanent boards:** every project/brand has one permanent Studio board per kind of design work: `<Brand> Static Ads`, `<Brand> Emails`, `<Brand> Web`. They are created the first time they are needed. All static ads, email designs and web/page designs for that brand go there, never on a new board. `card studio <id>` picks the right one from the card's title (say `card studio <id> ads|email|web` if it guesses wrong) and prints the task's own folder on it: put that task's design files **only in that folder**. Each folder shows as its own section on the board, so never move, rename or touch other tasks' folders or sections. Other work (video planning, brainstorming...) gets a board of its own; if the designs already live on another Studio board, link it with `card studio <id> "<board>"`. Never move or delete the user's planning boxes.
<!-- agent-workbench: end -->
