# Studio

A Figma-style canvas over the agent's own HTML files. **The HTML file is the design.** Nothing is converted.

- **Editor:** http://127.0.0.1:4517 (`npm run dev` here, or `bin/studio open` starts it in the background)
- **A board** is any folder of HTML designs (a static ad batch, an email set, a carousel). Each HTML file is one frame on the canvas.
- **Editor state** (board list, layouts, baselines, version history): `~/Library/Application Support/Studio/`. Local disk on purpose, never a cloud-synced folder.
- **Exports:** `~/Library/Application Support/Studio/exports/<board>/` unless `--out` says otherwise.
- **How to build designs that stay editable:** [`AUTHORING.md`](AUTHORING.md). Run `studio check <board> <design>` before handing a design over.

## Why it works this way

Agents design in HTML and CSS: masks, transforms, flexbox, mixed type in one line, inline SVG. An audit of ~340 recent files showed any other format loses some of that. So the editor renders each file live in the browser and writes the user's hand edits back into that same file as the smallest possible change.

- **Agent:** writes and edits HTML files exactly as before. Saving a file updates the canvas within 2 seconds.
- **You:** clicks any element to move, resize, restyle or retype it. Each edit lands as an inline style or text change on that one element. Every other byte of the file stays the same.
- **Export** renders the real file in headless Chromium. Output is pixel-identical to the canvas.

## Agent workflow

`apps/studio/bin/studio help` lists every command.

```bash
S=apps/studio/bin/studio

$S boards                                   # boards and their folders
$S board add "Batch 06" "<folder>"          # put a folder of HTML designs on the canvas

# before editing a design the user has touched
$S changes "Batch 06"                       # what they changed since your last write, element by element
$S diff "Batch 06" E-us-vs-them             # the same as a diff of your file
$S comments "Batch 06"                      # notes they pinned on the canvas, with the element under each
$S selection                                # the element they have selected right now, with file and line

# work: just edit the HTML files. These help.
$S tree "Batch 06" E-us-vs-them             # outline: line, element, text, inline style
$S new "Batch 06" F-new-angle --size 4x5    # scaffold a blank ad, or write the file yourself
$S copy "Batch 06" F-new-angle ads/F-new-angle/index-9x16.html
$S shot "Batch 06" F-new-angle              # half-size PNG to look at
$S reply "Batch 06" c_ab12cd "Made the 99% bigger and red" --resolve

# ship
$S export "Batch 06" F-new-angle --scale 2 --out "<Board Picks folder>"
$S export-all "Batch 06" --scale 2 --out "<folder>" --match "F-"
$S export "Emails" restock-A --width 600 --format png     # emails render full length
```

Rules for agents:

- **Build to `AUTHORING.md`.** One real element per piece, directly in `.ad`, placed with `left`/`top`. `studio check` must come back clean.
- **Read before you write.** Run `studio changes` and `studio comments` first. Their tweaks and notes are the brief.
- **Keep their tweaks.** They are inline styles on the element (`style="translate:0px 71px;font-size:64px"`). When you rewrite a file, carry them over or fold them into your CSS. Do not regenerate the file from scratch and drop them.
- `translate` on an element means they dragged it. Fold it into `left`/`top` if you like.
- Reply to each comment you act on and resolve it.
- Look at your work with `studio shot` before saying it is ready.
- An ad's artboard is its `.ad` element (or any element with `data-artboard`). Files without one are treated as pages and render full length.

## Planning on the board

A board is also where the task is planned. Next to the design frames, you lay out **planning objects**. They are stored in the board's `state.json` and never touch an HTML file:
- **Step boxes** (B): the + on each side adds the next step, joined by an arrow. Typing goes straight into a new box.
- **Sections** (S): named areas. Dragging a section moves everything in it, design frames included.
- **Pictures and videos**: drop them on the bare board, or use the media button. **+ Note** ties a note to one, and the note moves with it. A picture dragged onto an ad goes into its HTML, and its notes become comments on that ad.
- **Links**: paste a URL on the board.

`studio plan <board>` prints all of it in plain language: sections, steps in arrow order (with branches), notes and the file path of every picture, video and design, plus open comments. The same text is kept in `<state dir>/boards/<board>/plan.md`. **Read it before planning a task that has a board.** Agents add objects with `POST /api/items {board, put, remove, by: "agent"}`, though the plan normally belongs to the user.

When the board belongs to a card on the work board, a **Claude** panel at top right shows that card's live session and can send it a follow-up. It uses the work board server, set with `WORKBOARD_URL` (default `http://127.0.0.1:4477`).

## What you can do in the editor

- **Draw a frame anywhere (F).** Drag on the board for any size, or click for a 4:5 ad. It is a new HTML file with an empty `.ad`. Double-click a frame's label to call it anything: that is its title on the board, the file keeps its own name. Drag the right or bottom edge of a selected frame to resize it.
- **Pieces can sit on the bare board.** Drop or paste a picture outside the frames, or use the text and box tools there. Each one is a small file of its own under `loose/`.
- **Drag pieces between frames and the board.** Drag a piece past the edge of its frame and let go on another frame or on the board: it moves there with its look written inline. Drag a loose piece onto a frame to put it in. One ⌘Z takes the whole move back.
- **Click a frame to select it, drag to move it.** Click again to reach inside. ⌫ on a selected frame deletes the design file (confirmed first, ⌘Z restores it).
- Select any element (⌘-click for the exact one, Esc for its parent), drag it with snapping, resize it, nudge with arrows.
- A hairline (a rule, a divider, a dotted line) takes the click from a few pixels away, so it does not have to be hit exactly. Whatever sits in front of it still wins.
- **A press on what is selected moves it**, also inside a selected group or on a see-through spot of a selected cut-out; a plain click there still reaches inside. Shift-drag keeps the move level or plumb.
- Frames stay where they put them. Only the Tidy button re-sorts the board; a new design that lands on top of another is placed below the rest.
- **Pictures behave like what you see.** Cut-outs, CSS masks and rotation are read from the rendered image: you click the visible picture, transparent parts let the click through, and the box and handles hug the visible part. Pictures always scale as a whole.
- Double-click copy to retype it: the word under the pointer is selected. Inline styling like `<em>` is kept, and decorative bits inside a line (a toggle graphic) cannot take typed text. Pasted text comes in plain, line by line. Deleting every word deletes the text block.
- ⌘Z covers everything, including moving a frame on the canvas, and says what it undid. What was selected stays selected, also when the step being undone retyped or restyled copy.
- Change font, size, weight, tracking, line height, alignment, colour, background, radius, opacity, rotation.
- **Layers:** the left list shows each design's pieces front first; drag a row up or down to change what sits in front. `]` / `[` send to front / back, `⌘]` / `⌘[` step one layer, and the same four are buttons in the right panel. A reorder writes a `z-index` on every sibling (1, 2, 3…), so the order is explicit in the file. "To back" stops just above a full-bleed background.
- **Style part of a line:** double-click copy, select the words, then use the Text controls (font, size, weight, tracking, italic, caps, colour). Only the selection changes: each selected stretch is wrapped in a `<font style>` run inside that text block (a `<font>` so the file's own CSS, like `.sale span`, cannot restyle it). ⌘B / ⌘I / ⌘U do the same, and ⌘Z takes the last restyle back. Esc or a click elsewhere finishes.
- **Fonts and colour dots come from the file**: the font list is the families the design uses (plus system fonts), the dots are the colours it declares as custom properties on `:root`.
- **Copy and paste between designs** keeps the look: the piece's real font, size, colour and spacing are written inline, because the other file's CSS does not know its classes. That goes for the tags inside it too (the label a `.sale span` rule styles).
- Edit any element's inline CSS directly for everything else.
- Add text, boxes, circles and images. Duplicate, delete, hide.
- Replace an image. Preview emails at phone, email or desktop width.
- Pin comments for the agent (`C`). Undo and redo.
- Export PNG, JPG or PDF.

Safety net:

- A plain click never selects a whole-design container (a full-bleed background, an email's outer cell). ⌘-click does.
- Deleting anything with content inside it asks first.
- Emails and other pages are flow layouts: text, colour and image edits only. Nothing inside can be dragged or resized, and a drag moves the frame.
- Every version of a design the server sees is kept: `studio versions <board> <design>`, `studio restore <board> <design> <n>`.
- "Revert my edits" on a design drops all hand edits and returns to the agent's last version.
- Files are written atomically, and a file that is empty or still being written is never taken as a new version.
- A hand edit never lands on top of an agent save: if the file changed on disk a moment earlier, the edit is refused, they are told, and the design reloads with the agent's version.
- If the server stops answering, a red banner says so and each change that could not be saved is called out. Those designs reload from the files when it is back.
- If the agent saves a design while they are typing in it, the typing is dropped (and they are told) instead of being written into whatever element now sits at that place.

Known limits:

- Edits are per element, inline. Changing a shared class for every ad at once is an agent job.
- Elements created by a design's own `<script>` cannot be edited by hand.
- Selection boxes are axis-aligned, so a rotated element shows its bounding box.
- Layer order is set with z-index; elements are never moved in the file itself.
- Line height and alignment always apply to the whole text block, not to selected words.
- The canvas runs at most 28 designs live at once. The rest show a placeholder until you move near them.

## Code

- `server/html.ts`: edits an HTML file's source by exact offsets, and the authoring check (tested in `test/html.test.ts`)
- `src/alpha.ts`: reads how each picture really renders, so clicks and boxes follow the visible part
- `server/index.ts`: boards, file watching, edits, undo, change log, comments, export
- `src/`: the canvas (`canvas/`), live-document helpers (`dom.ts`), editing commands (`commands.ts`), panels
- `npm test`, `npm run typecheck`
