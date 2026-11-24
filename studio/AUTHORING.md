# Building designs that stay editable on the board

For agents. Studio shows your HTML files live on a canvas where the user clicks, drags, resizes and retypes things by hand. Their edits are written back into your file. How you structure the HTML decides whether that works well.

**Check your file before you hand it over:** `studio check <board> <design>`. It flags everything below marked **(checked)**.

## The one idea

**Every thing the user might want to touch is its own real element, sitting directly in the artboard, placed with `left` and `top`.**

If you can point at it in the ad and say "that", it should be one element with a clear class name.

## Skeleton

```html
<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../shared/base.css">
<style>
body{margin:0}
.ad{position:relative;width:1080px;height:1350px;overflow:hidden;background:#f4ece3;color:#141414;font-family:Inter,sans-serif}
.ad>*{position:absolute}

/* look lives in classes */
.headline{font-size:96px;font-weight:700;line-height:1.02;letter-spacing:-.045em;width:920px}
.headline em{font-family:'Instrument Serif',Georgia,serif;font-weight:400}
.sub{font-size:34px;line-height:1.25;width:760px}
.badge{display:flex;align-items:center;gap:12px;padding:18px 34px;border-radius:50px;background:#c11c0f;color:#f7f2e9;font-size:30px;font-weight:700}
</style>
<div class="ad">
  <img class="hero" src="../../shared/img/aero-dusk-cut.png" style="left:140px;top:520px;width:800px">
  <div class="headline" style="left:80px;top:110px">Fall asleep <em>faster.</em><br>Wake up clear.</div>
  <div class="sub" style="left:80px;top:340px">Dusk lenses block the light that keeps your brain awake.</div>
  <div class="badge" style="left:80px;top:1190px">Free shipping</div>
  <img class="logo" src="../../shared/img/logo-ink.png" style="left:860px;top:1230px;width:140px">
</div>
```

`studio new <board> <name> --size 4x5` writes the empty version of this.

## Rules

### Artboard

- **One `.ad` element per file**, fixed pixel size, `position:relative; overflow:hidden`. 4:5 is 1080×1350, 9:16 is 1080×1920. The board treats `.ad` (or any element with `data-artboard`) as the frame.
- `body{margin:0}`. No wrapper between `body` and `.ad`.
- 4:5 and 9:16 are **separate files** in the same folder: `index.html` and `index-9x16.html`. Re-lay out the 9:16 by hand to use the whole canvas (no story safe-zone layouts, and the safe-zone overlay is gone from the board).

### One piece, one element

- **Each piece is a direct child of `.ad`.** Headline, subhead, each photo, each badge, logo, proof line, CTA.
- **`.ad>*{position:absolute}`** so every piece moves on its own. **(checked)**
- **Place with `left` and `top` in px, inline on the element.** The user's drag then saves as a clean `left`/`top` change. With `right`, `bottom`, or `left:0;right:0` the board has to fall back to `translate:`, which works but is messier for you to read. **(checked)**
- To centre something, give it a width and a `left` (`left:80px;width:920px;text-align:center`), not `left:0;right:0`.
- **Keep position inline and look in classes.** Position is what the user changes most, and inline values are what the board edits.
- **Class names are the user's layer names.** The user sees `div.headline`, `img.hero`, `div.badge` in the Elements list. Name pieces for what they are, not `.c`, `.h2`, `.x1`. **(checked: unnamed top-level elements)**
- **Declare the palette on `:root`** as custom properties (`:root{--oxblood:#812221;--cream:#FCFCF7}`). Those become the colour dots in their panel, named after the variable. A file that declares none gets a few default dots.
- **Load every font the design may use.** The user's font list is the families the file's elements use, plus system fonts. A font the file does not load is not offered.

### Text

- **One text block is one element holding only text and inline tags** (`em`, `b`, `strong`, `span`, `br`). The user double-clicks it to retype, and your `<em>` survives.
- **Never mix loose text with blocks or images in the same element.** `<div class="foot"><img …>Rated 4.9</div>` cannot be retyped or selected cleanly. Make it `<img class="logo">` and `<div class="rating">Rated 4.9</div>`. **(checked)**
- A row of icon + label is fine as one element if the icon is an empty inline tag: `<div class="row"><i class="dot"></i>Falling asleep fast</div>`. The board locks the empty tag so typing can't land in it.
- Give wrapping text an explicit `width`. Use `white-space:nowrap` for single lines.
- No `text-wrap: balance` tricks that change line breaks when the user edits a word, unless the layout tolerates it.

### Pictures

- **Use `<img>` for every picture the user might move, resize or swap.** A CSS `background-image` cannot be grabbed or replaced. **(checked)**
- A full-bleed backdrop can be `background` on `.ad` itself, or an `<img>` that covers the whole ad. Either way the board treats it as background (the user needs ⌘-click to select it), which is what you want.
- Set `width` only and let height follow, or set both. The user resizes pictures as a whole.
- Cut-out PNGs, `mask-image` gradients, `rotate`, and `transform:rotate()` are all fine. The board reads the rendered picture, so the user's click and the selection box follow the visible part.
- Keep image files **inside the board folder** (`shared/img/…`) with relative paths. Remote images still show, but the board cannot read their shape, so they fall back to their full box.
- Don't use `mask-image:url(…)`. Gradient masks only.

### Groups

- If several pieces must travel together (a badge with an icon and label, a comparison card), wrap them in **one** absolutely positioned container and lay out the inside with flexbox. The user clicks a child, presses Esc to get the group, and drags the group.
- **Keep a group to 20 elements or fewer.** Bigger containers are treated as background and cannot be clicked as a unit. **(checked)**
- Don't nest groups more than two deep. Flat beats clever.

### Things that break editing

- **No `<script>` that builds content.** Elements created by script cannot be selected or edited. Write the final HTML. **(checked)**
- **No `::before` / `::after` for anything visible the user might want to change.** Pseudo-elements cannot be selected. Decorative empty ones are fine. **(checked)**
- **No `!important`.** Their edits are inline styles and lose to it. **(checked)**
- **No `pointer-events:none`** on real content. The user can't click it. **(checked)**
- **No `scale()` or `rotate()` on containers.** The user's drag distances inside come out wrong. Rotating a single picture or label is fine.
- No CSS animations or transitions in static ads.

### Emails and other pages

- **Design an email exactly like an ad: a fixed artboard with every piece placed by hand.** The user edits it like Figma: drags, drops and scales any piece anywhere. Build it as `<div class="ad" style="width:600px;height:<total>px">`, and inside it one absolutely positioned `<div class="section-…">` per band of the email (`left:0;top:…;width:600px;height:…`) holding that band's pieces, each with its own `left`/`top`. No tables, no flow layout, no `margin` stacking while the user is designing it. "Slice by section" cuts at those bands. Only when the user asks for the email as sendable HTML (not as sliced images) do you rebuild it into email tables, keeping the user's final positions.
- A page without `.ad` (an old email, a web page) still works: the user can drag anything in it, and the user's moves land as `translate` (see below). It edits far worse than an artboard, so never start a new design that way.
- **Declare the page's width** in `<head>`: `<meta name="studio:width" content="600">` for an email (the width of the email table itself, normally 600). The board frame and every export use it, so the frame is exactly the email with no grey margin either side. **(checked)**
- The email table's own width is that same number, and `body` has no margin, so nothing sits outside it.
- Same text rule: one block of copy per element (`<p>`, `<td>` with only text). Same picture rule: `<img>`.
- Their edits come first. After the user's pass, tidy what the user moved into clean positions if it needs it, never back to where it was.

## Working with their edits

1. **Before touching a file:** `studio changes <board> <design>` and `studio comments <board> <design>`. `studio diff` shows the same thing as a diff of your file.
2. **What their edits look like in your file:**
   - `style="left:96px;top:140px"` changed values: the user moved it.
   - `translate:12px -30px`: the user moved something that had no clean `left`/`top`. Fold it into the position when you next edit.
   - `width` / `height` / `font-size` / `color` / `letter-spacing` inline: the user restyled it.
   - Changed text inside an element: the user retyped it. The user's wording wins.
   - `z-index` on every piece of a design: the user reordered the layers. Keep the order. A piece the user adds after that carries the next `z-index`.
   - A `<font style="…">` around some words in a text block: the user restyled just those words. Keep it (you may turn it into a classed span if the look stays identical).
   - An element with a long inline style (`font-family`, `font-size`, `color`, `letter-spacing`…) and a class this file has no rule for: the user pasted it from another design, and the board wrote its look inline. Fold that into a class if you like; the result must look the same.
   - A piece that vanished from your file: the user dragged it into another frame or onto the bare board. `studio changes` says where it went ("moved to …"). Do not put it back.
   - A piece with a long inline style that appeared in your file: the user dragged it in from another frame or from the board. Its image links were rewritten to work from your file.
   - `width` / `height` inline on the `.ad` itself: the user resized the frame.
   - Files under `loose/`: single pieces the user parked on the board outside any frame (reference pictures, spare copy). They are the user's scratch space. Read them if the user points at one, but do not tidy, restyle or delete them.
   - A design may have a board title that differs from its folder name (`studio designs` shows both). `studio` commands accept either.
3. **Edit in place.** Change the lines you need. Never regenerate the file from a template and drop the user's inline styles. If you restructure, carry each tweak across.
4. If you move a tweak from inline into a class, the rendered result must stay identical. Check with `studio shot`.
5. Reply to each comment you act on: `studio reply <board> <id> "what changed" --resolve`.
6. `studio accept <board> <design>` once you have read and handled the user's changes, so the next `changes` starts clean. Without a design it accepts the whole board.
7. **Saving while the user works is safe.** If you save a design the user is editing, the user's next edit on it is refused and the canvas reloads your version; the user never overwrites it. Only text the user was typing in that design at that very moment is dropped (the user is told).

## Before you say it's ready

```bash
S=apps/studio/bin/studio
$S check  <board> <design>      # must come back clean, or explain each remaining note
$S tree   <board> <design>      # this is the user's Elements list: are the names clear, is it flat?
$S shot   <board> <design>      # look at it
```
