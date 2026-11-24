// Editing commands. Every change is applied to the live document first (instant feedback)
// and then written into the HTML file as the smallest possible edit.
import type { Design, Edit } from '../shared/types'
import { forget, prepareImages } from './alpha'
import { boxOf, clean, docOf, elOf, frames, isPage, isReloading, isRoot, isTextLeaf, isWrapper, label, markReloading, parentSel, pick, piecesOf, rawBox, rememberSelection, selected, sidOf } from './dom'
import { commentOp, deleteDesign, history_, newFrame, reloadDesign, revertDesign, saveLayout, sendEdits, settled, settledAll, transferApi, upload } from './net'
import { ask, bump, get, select, set, toast, type Box } from './store'

// ---------- pending style edits ----------
const pending = new Map<string, Map<number, Record<string, string | null>>>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Set inline styles on live elements now, write them to the file shortly after. */
export function style(design: string, els: HTMLElement[], props: Record<string, string | null>, now = false) {
  // the design is about to reload: these elements belong to the old document, and their sids may be other elements in the new one
  if (isReloading(design)) els = []
  let per = pending.get(design)
  if (!per) pending.set(design, (per = new Map()))
  for (const el of els) {
    for (const [k, v] of Object.entries(props)) { if (v === null) el.style.removeProperty(k); else el.style.setProperty(k, v) }
    per.set(sidOf(el), { ...(per.get(sidOf(el)) || {}), ...props })
    if (el.tagName === 'IMG' && Object.keys(props).some((k) => RESHAPES.test(k))) reshape(el)
  }
  bump()
  if (timer) clearTimeout(timer)
  if (now) flush()
  else timer = setTimeout(flush, 350)
}

// Things that change which part of a picture is visible, so its click map has to be read again.
const RESHAPES = /^(object-fit|object-position|mix-blend-mode|mask|-webkit-mask)/
function reshape(img: HTMLElement) {
  forget(img)
  prepareImages(img.ownerDocument).then(bump)
}

export function flush() {
  if (timer) { clearTimeout(timer); timer = null }
  for (const [design, per] of pending) {
    const edits: Edit[] = [...per].map(([sid, props]) => ({ kind: 'style', sid, props }))
    if (edits.length && !isReloading(design)) sendEdits(design, edits) // (sids queued just before a reload are not safe to write)
  }
  pending.clear()
}

/** Edits that add, remove or rewrite elements. The design reloads when they land. */
export async function structural(design: string, edits: Edit[], then?: { edit?: boolean; select?: boolean }, from?: string | null) {
  // Copy still being typed is saved first, and the design reloaded with it. (A panel button does not end the edit by itself.)
  if (editState) {
    const fin = finishEditing()
    if (fin?.gone != null && fin.design === design) edits = edits.filter((e) => e.kind === 'insert' || e.sid !== fin.gone) // the emptied block is already deleted
    if (!edits.length) return { ok: true }
  }
  flush()
  markReloading(design)
  // Wait for what is already on its way (the text edit above, say). Sent straight behind an edit that reloads the
  // design, this one would be dropped as stale.
  await settled(design)
  const r = await writeNow(design, edits, from)
  if (r.ok && then && r.newSid != null) set({ afterLoad: { design, sid: r.newSid, edit: then.edit } })
  return r
}
/** Queue a structural edit this instant, for the callers that cannot wait (ending a text edit). */
function writeNow(design: string, edits: Edit[], from?: string | null) {
  flush()
  markReloading(design)
  return sendEdits(design, edits, from).then((r) => { if (r.offline || (r.ok && !r.reload)) markReloading(design, false); return r }) // nothing changed: nothing reloads
}

export function setAttr(design: string, el: HTMLElement, name: string, value: string | null) {
  if (isReloading(design)) return
  flush()
  if (value === null) el.removeAttribute(name); else el.setAttribute(name, value)
  if (el.tagName === 'IMG' && (name === 'src' || name === 'style')) {
    // a replaced picture has another shape: read it again once it has loaded, or clicks keep following the old one
    if (name === 'src') { forget(el); el.addEventListener('load', () => reshape(el), { once: true }) } else reshape(el)
  }
  bump()
  sendEdits(design, [{ kind: 'attr', sid: sidOf(el), name, value }])
}

/** Several attributes and styles on one element as a single change (one ⌘Z puts all of it back). */
export function changeEl(design: string, el: HTMLElement, attrs: Record<string, string | null>, props: Record<string, string | null> = {}) {
  if (isReloading(design)) return
  flush()
  const sid = sidOf(el)
  const edits: Edit[] = Object.entries(attrs).map(([name, value]) => { if (value === null) el.removeAttribute(name); else el.setAttribute(name, value); return { kind: 'attr', sid, name, value } })
  for (const [k, v] of Object.entries(props)) { if (v === null) el.style.removeProperty(k); else el.style.setProperty(k, v) }
  if (Object.keys(props).length) edits.push({ kind: 'style', sid, props })
  if (el.tagName === 'IMG') { if ('src' in attrs) { forget(el); el.addEventListener('load', () => reshape(el), { once: true }) } else reshape(el) }
  bump()
  sendEdits(design, edits)
}

// ---------- moving ----------
export interface Mover { el: HTMLElement; mode: 'lt' | 'tr'; left: number; top: number; tx: number; ty: number }

/** Work out how an element can be moved: by left/top when that is clean, else with `translate`. */
export function mover(el: HTMLElement): Mover {
  const cs = getComputedStyle(el)
  const t = cs.translate && cs.translate !== 'none' ? cs.translate.split(' ').map((v) => parseFloat(v) || 0) : [0, 0]
  const m: Mover = { el, mode: 'tr', left: 0, top: 0, tx: t[0] || 0, ty: t[1] || 0 }
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    const left = parseFloat(cs.left), top = parseFloat(cs.top)
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const b = { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
      const keep = [el.style.left, el.style.top]
      el.style.left = `${left + 8}px`; el.style.top = `${top + 8}px`
      const ok = Math.abs(el.offsetLeft - b.l - 8) < 1 && Math.abs(el.offsetTop - b.t - 8) < 1 && el.offsetWidth === b.w && el.offsetHeight === b.h
      el.style.left = keep[0]; el.style.top = keep[1]
      if (ok) { m.mode = 'lt'; m.left = left; m.top = top }
    }
  }
  return m
}
export function moveProps(m: Mover, dx: number, dy: number): Record<string, string | null> {
  if (m.mode === 'lt') return { left: `${Math.round(m.left + dx)}px`, top: `${Math.round(m.top + dy)}px` }
  const x = Math.round(m.tx + dx), y = Math.round(m.ty + dy)
  return { translate: x || y ? `${x}px ${y}px` : null }
}

export function nudge(dx: number, dy: number) {
  const { sel } = get()
  if (!sel.design) return
  if (!sel.sids.length) { // nothing inside selected: move the frame itself
    const d = get().designs[sel.design]
    set({ designs: { ...get().designs, [d.id]: { ...d, x: d.x + dx, y: d.y + dy } } })
    saveLayout([{ id: d.id, x: d.x + dx, y: d.y + dy }], [{ id: d.id, x: d.x, y: d.y }])
    return
  }
  for (const el of selected()) style(sel.design, [el], moveProps(mover(el), dx, dy))
}

// ---------- structure ----------
export async function removeDesign(id: string) {
  const name = id.split('/').slice(-2).join('/')
  // no question, as in Figma: the file goes to Studio's trash and ⌘Z brings it back
  void name
  flush()
  await settledAll() // the last tweak must reach the file before the delete does
  const r = await deleteDesign(id)
  if (r.ok) { select(null); toast(`${id.startsWith('loose/') ? 'Deleted' : 'Design deleted'}. ⌘Z to undo.`) } else toast(r.error || 'Could not delete')
}

// ---- whole frames: ⌘C / ⌘V / ⌘D on a frame (the copy is a new design file) ----
const FRAMES = 'studio-frames:'
let frameClip: { board: string; ids: { id: string; x: number; y: number; w: number; h: number }[] } | null = null
/** The frames selected as a whole: several, or one with nothing inside it picked. */
export function selectedFrames(): string[] {
  const s = get()
  return s.dsel.length ? s.dsel : s.sel.design && !s.sel.sids.length ? [s.sel.design] : []
}
export function copyFrames(ids = selectedFrames()) {
  const s = get()
  const list = ids.filter((id) => s.designs[id]).map((id) => ({ id, x: s.designs[id].x, y: s.designs[id].y, w: s.designs[id].w, h: s.designs[id].h }))
  if (!list.length) return false
  frameClip = { board: s.board, ids: list }
  clipboard = [] // a frame copy replaces an element copy
  navigator.clipboard?.writeText(FRAMES + JSON.stringify(frameClip)).catch(() => {})
  toast(`Copied ${list.length > 1 ? `${list.length} frames` : 'the frame'}. ⌘V pastes a copy (on any board).`)
  return true
}
/** ⌘V with frames on the clipboard (from this tab, another tab or another board). */
export async function pasteFrames(text?: string): Promise<boolean> {
  if (text?.startsWith(FRAMES)) { try { frameClip = JSON.parse(text.slice(FRAMES.length)) } catch { /* keep ours */ } }
  else if (text && !text.startsWith(FRAMES)) return false
  if (!frameClip?.ids.length) return false
  const s = get()
  const same = frameClip.board === s.board
  // same board: right of the originals; another board: in the middle of the view
  const x0 = Math.min(...frameClip.ids.map((f) => f.x)), y0 = Math.min(...frameClip.ids.map((f) => f.y))
  const x1 = Math.max(...frameClip.ids.map((f) => f.x + f.w)), y1 = Math.max(...frameClip.ids.map((f) => f.y + f.h))
  const v = s.view, cx = (s.size.w / 2 - v.x) / v.z, cy = (s.size.h / 2 - v.y) / v.z
  const dx = same ? x1 - x0 + 120 : Math.round(cx - (x0 + x1) / 2), dy = same ? 0 : Math.round(cy - (y0 + y1) / 2)
  toast(`Pasting ${frameClip.ids.length > 1 ? `${frameClip.ids.length} frames` : 'the frame'}…`)
  const made: string[] = []
  for (const f of frameClip.ids) {
    const r = await fetch(`/api/copy-design?board=${encodeURIComponent(s.board)}`, { method: 'POST', body: JSON.stringify({ fromBoard: frameClip.board, fromId: f.id, x: f.x + dx, y: f.y + dy, w: f.w, h: f.h }) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Studio is not answering' }))
    if (!r.ok) { toast(r.error || 'Could not paste the frame'); continue }
    made.push(r.design)
  }
  for (let i = 0; i < 60 && made.some((id) => !get().designs[id]); i++) await new Promise((res) => setTimeout(res, 50))
  const here = made.filter((id) => get().designs[id])
  if (here.length) { if (here.length > 1) set({ dsel: here, sel: { design: null, sids: [] }, isel: [] }); else select(here[0], []); toast(`Pasted ${here.length > 1 ? `${here.length} frames` : 'a copy of the frame'}.`) }
  return true
}
/** ⌘D on frames: copy and paste in one go, next to the originals. */
export async function duplicateFrames(ids = selectedFrames()) {
  const keep = frameClip
  if (!copyFrames(ids)) return
  await pasteFrames()
  frameClip = keep ?? frameClip
}

/** Several whole frames at once: one question, then each file goes to Studio's trash (⌘Z brings them back one by one). */
export async function removeDesigns(ids: string[]) {
  const s = get()
  const real = ids.filter((id) => s.designs[id])
  if (!real.length) return
  if (real.length === 1) return removeDesign(real[0])
  flush()
  await settledAll()
  let ok = 0
  for (const id of real) if ((await deleteDesign(id)).ok) ok++
  select(null)
  toast(ok === real.length ? `${ok} designs deleted. ⌘Z to undo.` : `Deleted ${ok} of ${real.length}.`)
}

export async function revert(id: string) {
  if (!(await ask('Revert your edits?', 'Every hand edit on this design is thrown away and it goes back to the agent\'s last version. ⌘Z undoes this.', 'Revert'))) return
  flush()
  await settledAll()
  const r = await revertDesign(id)
  toast(r.ok ? (r.changed ? 'Reverted. ⌘Z to undo.' : 'Nothing to revert.') : r.error)
}

let lastElementDelete = 0
export async function deleteSelection() {
  const { sel } = get()
  if (!sel.design) return
  // a second ⌫ right after deleting a piece is a double tap, not a wish to delete the whole design
  if (!sel.sids.length) { if (Date.now() - lastElementDelete > 600) removeDesign(sel.design); return }
  // Deleting a container takes everything inside with it, so make that an explicit choice.
  const d = get().designs[sel.design]
  const els = selected()
  const inside = els.reduce((n, el) => n + el.querySelectorAll('[data-sid]').length, 0)
  const big = els.some((el) => { const b = boxOf(sel.design!, el); return (b.w * b.h) / (d.w * d.h) > 0.4 })
  void inside; void big // (no question: ⌘Z brings it back)
  lastElementDelete = Date.now()
  structural(sel.design, sel.sids.map((sid) => ({ kind: 'remove', sid })))
  select(sel.design, [])
  toast(`Deleted ${els.length > 1 ? `${els.length} elements` : label(els[0])}. ⌘Z to undo.`)
}

export async function duplicate() {
  const { sel } = get()
  if (!sel.design || !sel.sids.length) return
  const sids = [...sel.sids].sort((a, b) => b - a)
  for (const sid of sids) await structural(sel.design, [{ kind: 'duplicate', sid }], { select: true })
}

// Each design file has its own <style>, so a class means nothing (or something else) in another file. A copy
// therefore also carries the look the piece really had, to be written inline when it is pasted into another design.
const LOOK = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'color', 'background-color', 'display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'margin', 'padding', 'border-radius', 'white-space', 'mix-blend-mode', 'object-fit']
// More of the look, carried when it differs: what makes a card a card and a cut-out a cut-out.
const MORE = ['background-image', 'background-size', 'background-position', 'background-repeat', '-webkit-background-clip', '-webkit-text-fill-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'box-shadow', 'opacity', 'rotate', 'transform', 'filter', 'backdrop-filter', '-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-position', '-webkit-mask-repeat', 'text-shadow', 'text-decoration-line', 'overflow', 'object-position', 'flex-wrap', 'box-sizing', 'vertical-align', 'aspect-ratio']
// Only for what is inside the piece: where each part sits in it.
const INSIDE = ['position', 'left', 'top', 'right', 'bottom']
const INHERITED = LOOK.slice(0, 9).concat('white-space')
/** A computed value as it should be written: sizes that follow the font stay relative to it, and no double quotes (it goes in an attribute). */
function written(prop: string, v: string, fontSize: number): string {
  v = v.replace(/"/g, "'")
  if ((prop === 'line-height' || prop === 'letter-spacing') && v.endsWith('px') && fontSize) return `${Math.round((parseFloat(v) / fontSize) * 1000) / 1000}${prop === 'line-height' ? '' : 'em'}`
  return v
}
const addStyle = (el: Element, decls: string[]) => { if (decls.length) el.setAttribute('style', [(el.getAttribute('style') || '').trim().replace(/;$/, ''), ...decls].filter(Boolean).join(';')) }
/** The element's markup with its look made explicit: every listed property whose value differs from a bare tag in the same spot. */
function portable(el: HTMLElement): { html: string; own: Record<string, string> } {
  const clone = el.cloneNode(true) as HTMLElement
  const from = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))], to = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]
  // Each element is compared with a stand-in: the same tag with the same inline style but no class, built up as a tree
  // of its own. No rule of this file reaches a stand-in, not ".sale" and not ".sale span" or ".side b" either (a bare
  // tag put inside the real ".sale" would still be styled by ".sale span", and the span's look would not be carried).
  const twin = new Map<Element, HTMLElement>()
  try { from.forEach((src, i) => {
    const up = src === el ? el.parentElement : src.parentElement && twin.get(src.parentElement)
    if (!up || src.tagName === 'BR' || src.closest('svg')) return
    const t = el.ownerDocument.createElement(src.tagName)
    const inline = src.getAttribute('style')
    if (inline) t.setAttribute('style', inline)
    up.appendChild(t)
    twin.set(src, t)
    const a = getComputedStyle(src), b = getComputedStyle(t)
    const fs = parseFloat(a.fontSize)
    const fixed = a.position === 'absolute' || a.position === 'fixed'
    const bare = !src.textContent?.trim()
    const sized = src.tagName === 'IMG' ? ['width'] : src !== el && (fixed || bare) ? (bare ? ['width', 'height'] : ['width']) : []
    const props = [...LOOK, ...MORE, ...(src === el ? [] : INSIDE), ...sized]
    const decls = props.filter((p) => !src.style.getPropertyValue(p) && a.getPropertyValue(p) !== b.getPropertyValue(p) && !(p.startsWith('border-') && p !== 'border-radius' && /^0px|none/.test(a.getPropertyValue(p)))).map((p) => `${p}:${written(p, a.getPropertyValue(p), fs)}`)
    addStyle(to[i], decls)
    addStyle(t, decls) // so that what is inside it inherits what the real one hands down
  }) } finally { twin.get(el)?.remove() } // the stand-ins sit in the live design for an instant: never leave one behind
  const cs = getComputedStyle(el)
  return { html: clean(clone.outerHTML), own: Object.fromEntries(INHERITED.map((p) => [p, cs.getPropertyValue(p)])) }
}
/** What to insert into another design: also what the piece inherited from its old artboard, where the new one differs. */
function carried(c: { look: string; own: Record<string, string> }, root: HTMLElement | null): string {
  const t = document.createElement('template')
  t.innerHTML = c.look
  const el = t.content.firstElementChild as HTMLElement | null
  if (!el) return c.look
  const there = root ? getComputedStyle(root) : null // (null: the bare board, where nothing is handed down)
  const has = new Set((el.getAttribute('style') || '').split(';').map((d) => d.split(':')[0].trim()))
  addStyle(el, INHERITED.filter((p) => !has.has(p) && c.own[p] && c.own[p] !== there?.getPropertyValue(p)).map((p) => `${p}:${written(p, c.own[p], parseFloat(c.own['font-size']))}`))
  return t.innerHTML
}

/**
 * A pasted piece keeps its place when it fits in the frame it lands in; when it would hang (mostly) outside, as a
 * piece from a taller ad does, it goes to the middle of the frame, as Figma does.
 */
function inFrame(html: string, c: { w?: number; h?: number }, root: HTMLElement): string {
  const t = document.createElement('template')
  t.innerHTML = html
  const el = t.content.firstElementChild as HTMLElement | null
  if (!el || !c.w || !c.h) return html
  const W = root.offsetWidth, H = root.offsetHeight
  const left = parseFloat(el.style.left), top = parseFloat(el.style.top)
  if (!Number.isFinite(left) || !Number.isFinite(top)) return html
  const shownW = Math.max(0, Math.min(left + c.w, W) - Math.max(left, 0)), shownH = Math.max(0, Math.min(top + c.h, H) - Math.max(top, 0))
  if (shownW * shownH >= c.w * c.h * 0.6) return html // (mostly) inside already
  el.style.left = `${Math.round((W - c.w) / 2)}px`
  el.style.top = `${Math.round((H - c.h) / 2)}px`
  el.style.removeProperty('right'); el.style.removeProperty('bottom'); el.style.removeProperty('translate')
  return t.innerHTML
}

/** The highest z-index among the artboard's pieces. Above 0 means the layers were reordered and every piece carries one. */
const topZ = (root: Element) => Math.max(0, ...paintOrder(root).map((el) => parseInt(getComputedStyle(el).zIndex) || 0))
/** Give a new piece this z-index. Without one it would paint behind every reordered piece, the background photo included. */
function withZ(html: string, z: number): string {
  if (z <= 0) return html
  const t = document.createElement('template')
  t.innerHTML = html
  const el = t.content.firstElementChild
  if (!el) return html
  const css = (el.getAttribute('style') || '').replace(/(^|;)\s*z-index\s*:[^;]*;?/gi, '$1').trim().replace(/;$/, '')
  el.setAttribute('style', `${css}${css ? ';' : ''}z-index:${z}`)
  return t.innerHTML
}

type Clip = { html: string; look: string; own: Record<string, string>; w?: number; h?: number }
let clipboard: Clip[] = []
let clipFrom: string | null = null
let clipBoard: string | null = null
const CLIP = 'studio-clip:'
/**
 * What copy() puts on the system clipboard: the whole copy, so another tab (or the same tab after a reload, or on
 * another board) can paste it too. A paste compares it to tell "the element I just copied" from an older screenshot.
 */
export const clipText = () => (clipboard.length ? CLIP + JSON.stringify({ board: clipBoard, from: clipFrom, items: clipboard }) : '')
/** A copy made in another tab arrived on the system clipboard: take it as ours. */
export function adoptClip(text: string): boolean {
  if (!text.startsWith(CLIP) || text === clipText()) return text === clipText() && !!clipboard.length
  try {
    const j = JSON.parse(text.slice(CLIP.length))
    if (!Array.isArray(j.items) || !j.items.length) return false
    clipboard = j.items; clipFrom = j.from || null; clipBoard = j.board || null
    return true
  } catch { return false }
}
/** Links to files in a copied piece, made to work from anywhere: /b/<board>/<path> (resolved against its own file). */
function servedLinks(html: string, base: string): string {
  const fix = (u: string) => {
    if (/^(data:|blob:|#)/i.test(u.trim())) return u
    try { const url = new URL(u.trim(), base); return url.origin === location.origin && url.pathname.startsWith('/b/') ? url.pathname : u } catch { return u }
  }
  return html
    .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])(.*?)\2/gi, (_m, a, q, u) => `${a}${q}${fix(u)}${q}`)
    .replace(/url\(\s*(&quot;|["']?)(.*?)\1\s*\)/gi, (_m, q, u) => `url(${q}${fix(u)}${q})`)
}
/** The other way round on paste: each /b/... link becomes a path from the design it lands in (files from another board are copied in). */
async function localLinks(html: string, design: string | null): Promise<string> {
  const urls = [...new Set(html.match(/\/b\/[^"'()\s&]+/g) || [])]
  if (!urls.length) return html
  const s = get()
  const r = await fetch(`/api/import-assets?board=${encodeURIComponent(s.board)}${design ? `&design=${encodeURIComponent(design)}` : ''}`, { method: 'POST', body: JSON.stringify({ urls }) }).then((r) => r.json()).catch(() => ({}))
  for (const [u, rel] of Object.entries((r.map || {}) as Record<string, string>)) html = html.split(u).join(rel.split('/').map(encodeURIComponent).join('/'))
  return html
}
export function copy() {
  const els = selected()
  if (!els.length) return
  clipboard = els.map((el) => { const p = portable(el); return { html: clean(el.outerHTML), look: servedLinks(p.html, el.ownerDocument.baseURI), own: p.own, w: el.offsetWidth, h: el.offsetHeight } })
  clipFrom = get().sel.design
  clipBoard = get().board
  frameClip = null // the last copy wins
  // also onto the system clipboard, or an image copied earlier would still be there and win the next ⌘V
  navigator.clipboard?.writeText(clipText()).catch(() => {})
  toast(`Copied ${clipboard.length} element${clipboard.length > 1 ? 's' : ''}`)
}
export async function paste() {
  if (!clipboard.length) return
  const s = get()
  const design = s.sel.design && !s.designs[s.sel.design]?.loose ? s.sel.design : null
  const sameBoard = clipBoard === s.board
  // nothing (or a loose piece) selected: as in Figma, it lands on the board, in the middle of the view
  if (!design) {
    const v = s.view, cx = (s.size.w / 2 - v.x) / v.z, cy = (s.size.h / 2 - v.y) / v.z
    let dx = 0
    for (const c of clipboard) {
      const w = Math.max(20, Math.round(c.w || 300)), h = Math.max(20, Math.round(c.h || 200))
      const t = document.createElement('template')
      t.innerHTML = await localLinks(carried(c, null), null)
      const el = t.content.firstElementChild as HTMLElement | null
      if (!el) continue
      el.style.position = 'absolute'; el.style.left = '0px'; el.style.top = '0px'; el.style.width = `${w}px`
      if (el.tagName !== 'IMG' && !el.textContent?.trim()) el.style.height = `${h}px`
      el.style.removeProperty('right'); el.style.removeProperty('bottom'); el.style.removeProperty('translate')
      if (el.tagName === 'IMG') for (const p of INHERITED) el.style.removeProperty(p) // a picture has no text to style
      await addLoose(t.innerHTML, { x: cx - w / 2 + dx, y: cy - h / 2, w, h }, el.tagName === 'IMG' ? 'image' : 'piece')
      dx += w + 40
    }
    return
  }
  const root = frames.get(design)?.root
  if (!root) { toast('Zoom in on this design to load it, then paste'); return }
  if (!root.hasAttribute('data-sid')) { toast('This file has no artboard element to paste into'); return }
  let z = topZ(root)
  const here = sameBoard && design === clipFrom
  for (const c of clipboard) {
    const html = inFrame(here ? c.html : await localLinks(carried(c, root), design), c, root)
    await structural(design, [{ kind: 'insert', parent: sidOf(root), html: withZ(html, z ? ++z : 0) }], { select: true }, here || !sameBoard ? null : clipFrom)
  }
}

export async function insert(design: string, html: string, edit = false) {
  const root = frames.get(design)?.root
  if (!root || !root.hasAttribute('data-sid')) { toast('This file has no artboard element to add to'); return }
  const z = topZ(root)
  await structural(design, [{ kind: 'insert', parent: sidOf(root), html: withZ(html, z ? z + 1 : 0) }], { edit, select: true })
  set({ tool: 'move' })
}

export function local(design: string, pt: { x: number; y: number }) {
  const d = get().designs[design]
  const f = frames.get(design)
  // An email or page adds pieces to its <body>. Unless the body is positioned, they are placed from the page's top-left
  // corner (where the scrolled page starts), not from the body's box.
  if (f && !f.art && f.root) {
    const w = f.root.ownerDocument.defaultView
    if (w && w.getComputedStyle(f.root).position === 'static') return { x: Math.round(pt.x - d.x + f.ox + w.scrollX), y: Math.round(pt.y - d.y + f.oy + w.scrollY) }
  }
  const r = f?.root?.getBoundingClientRect()
  return { x: Math.round(pt.x - d.x + (f?.ox || 0) - (r?.left || 0)), y: Math.round(pt.y - d.y + (f?.oy || 0) - (r?.top || 0)) }
}

export async function insertImages(design: string | null, files: File[], pt: { x: number; y: number }) {
  for (const file of files.filter((f) => f.type.startsWith('image/'))) {
    try {
      const src = await upload(design, file, file.name || 'pasted.png')
      if (!design || get().designs[design]?.loose) { // onto the bare board
        const size = await new Promise<{ w: number; h: number }>((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth || 600, h: i.naturalHeight || 600 }); i.onerror = () => res({ w: 600, h: 600 }); i.src = URL.createObjectURL(file) })
        const w = Math.min(800, size.w), h = Math.round((w * size.h) / size.w)
        await addLoose(`<img src="${src}" style="position:absolute;left:0px;top:0px;width:${w}px;height:${h}px">`, { x: pt.x - w / 2, y: pt.y - h / 2, w, h }, (file.name || 'image').replace(/\.\w+$/, ''))
        continue
      }
      const p = local(design, pt)
      const w = Math.min(600, get().designs[design].w)
      await insert(design, `<img src="${src}" style="position:absolute;left:${Math.max(0, p.x - w / 2)}px;top:${Math.max(0, p.y - w / 2)}px;width:${w}px">`)
    } catch (e) { toast(`Image failed: ${(e as Error).message}`) }
  }
}

// ---------- frames and loose pieces ----------
/** A new frame, wherever and whatever size it was drawn. Its name is typed straight away. */
export async function createFrame(box: Box) {
  const n = Object.values(get().designs).filter((d) => !d.loose).length + 1
  const r = await newFrame({ title: `Frame ${n}`, x: Math.round(box.x), y: Math.round(box.y), w: Math.max(20, Math.round(box.w)), h: Math.max(20, Math.round(box.h)) })
  set({ tool: 'move' })
  if (!r.ok) { toast(r.error || 'Could not make the frame'); return }
  for (let i = 0; i < 60 && !get().designs[r.design]; i++) await new Promise((res) => setTimeout(res, 50))
  if (get().designs[r.design]) { select(r.design, []); set({ renaming: r.design }) }
}
export function rename(id: string, title: string) {
  const d = get().designs[id]
  title = title.trim()
  set({ renaming: null })
  if (!d || !title || title === (d.title || '')) return
  set({ designs: { ...get().designs, [id]: { ...d, title } } })
  saveLayout([{ id, title }])
}
/** Put a piece on the bare board: it becomes a small file of its own. `box` is where it sits on the canvas. */
export async function addLoose(html: string, box: Box, name = 'piece', edit = false) {
  const r = await transferApi({ items: [{ html, x: box.x, y: box.y, w: box.w, h: box.h, name }] })
  set({ tool: 'move' })
  if (!r.ok) { toast(r.error || 'Could not add that'); return }
  const id = r.designs?.[0]
  for (let i = 0; id && i < 60 && !get().designs[id]; i++) await new Promise((res) => setTimeout(res, 50))
  if (!id || !get().designs[id]) return
  select(id, [])
  if (!edit) return
  for (let i = 0; i < 60 && !piecesOf(id).length; i++) await new Promise((res) => setTimeout(res, 50))
  const el = piecesOf(id)[0]
  if (el) { select(id, [sidOf(el)]); startEditing(id, el) }
}

const stemOf = (el: Element) => (el.getAttribute('class') || '').split(/\s+/)[0] || (el.tagName === 'IMG' ? ((el.getAttribute('src') || '').split('/').pop() || 'image').replace(/\.\w+$/, '') : isTextLeaf(el) ? (el.textContent || '').trim().split(/\s+/).slice(0, 3).join('-') : el.tagName.toLowerCase())
/** The piece's markup, set to sit at left/top in its new home with nothing left of how it was placed in the old one. */
function placedAt(html: string, left: number, top: number, size: { width?: string; height?: string }): string {
  const t = document.createElement('template')
  t.innerHTML = html
  const el = t.content.firstElementChild as HTMLElement | null
  if (!el) return html
  for (const p of ['translate', 'right', 'bottom', 'inset', 'margin', 'z-index']) el.style.removeProperty(p)
  el.style.setProperty('position', 'absolute')
  el.style.setProperty('left', `${Math.round(left)}px`)
  el.style.setProperty('top', `${Math.round(top)}px`)
  el.style.setProperty('margin', '0')
  if (size.width && !el.style.width) el.style.setProperty('width', size.width)
  if (size.height && !el.style.height) el.style.setProperty('height', size.height)
  return t.innerHTML
}
/**
 * Take pieces out of their design and put them where they were dropped: into the frame `to`, or (null) onto the bare
 * board. They keep their look (written inline, since the other file has other CSS) and the spot they were dropped at.
 */
export async function moveOut(design: string, els: HTMLElement[], to: string | null, drag?: { movers: Mover[]; dx: number; dy: number }): Promise<boolean> {
  const d = get().designs[design]
  const toRoot = to ? frames.get(to)?.root : null
  if (!d || !els.length) return false
  if (to && (!toRoot || !toRoot.hasAttribute('data-sid'))) { toast('Zoom in on that frame to load it, then drop again'); reloadDesign(design); return false }
  let z = toRoot ? topZ(toRoot) : 0
  // Measured where the piece lived, not where the drag left it: pushed against its frame's edge a line of copy wraps
  // into a narrow column, and that is not its size.
  if (drag) for (const m of drag.movers) for (const [k, v] of Object.entries(moveProps(m, 0, 0))) { if (v === null) m.el.style.removeProperty(k); else m.el.style.setProperty(k, v) }
  const items = els.map((el) => {
    const b = rawBox(design, el)
    if (drag) { b.x += drag.dx; b.y += drag.dy }
    const cs = getComputedStyle(el)
    const ow = el.offsetWidth || b.w, oh = el.offsetHeight || b.h
    const p = portable(el)
    // a turned piece: its box on screen is bigger than the piece, and both share a centre
    const at = to ? local(to, { x: b.x + (b.w - ow) / 2, y: b.y + (b.h - oh) / 2 }) : { x: (Math.ceil(b.w) - ow) / 2, y: (Math.ceil(b.h) - oh) / 2 }
    let html = to ? carried({ look: p.html, own: p.own }, toRoot!) : carried({ look: p.html, own: p.own }, null)
    const w = cs.width.endsWith('px') ? cs.width : undefined
    html = placedAt(html, at.x, at.y, { width: w, height: el.tagName === 'IMG' && cs.height.endsWith('px') ? cs.height : undefined })
    if (to && z) html = withZ(html, ++z)
    return { html, x: b.x, y: b.y, w: b.w, h: b.h, name: stemOf(el) }
  })
  const emptied = !!d.loose && piecesOf(design).every((k) => els.includes(k))
  const sids = els.map(sidOf)
  flush()
  await settledAll()
  markReloading(design)
  if (to) { markReloading(to); rememberSelection(to) }
  const r = await transferApi({ from: design, sids, rev: get().designs[design]?.rev, emptied, to: to || undefined, parent: toRoot ? sidOf(toRoot) : undefined, items })
  if (!r.ok) { toast(r.error || 'Could not move that'); markReloading(design, false); if (to) markReloading(to, false); reloadDesign(design); return false }
  if (to) { select(to, []); if (r.newSid != null) set({ afterLoad: { design: to, sid: r.newSid } }) }
  else {
    const id = r.designs?.[0]
    for (let i = 0; id && i < 60 && !get().designs[id]; i++) await new Promise((res) => setTimeout(res, 50))
    select(id && get().designs[id] ? id : null, [])
  }
  return true
}
/** A loose piece was moved or resized inside its own little file: make the file fit it again, without the piece moving on the board. */
export function fitLoose(design: string) {
  const d = get().designs[design]
  const root = frames.get(design)?.root
  const kids = piecesOf(design)
  if (!d?.loose || !root || !kids.length || isReloading(design)) { flush(); return }
  const rr = root.getBoundingClientRect()
  const rs = kids.map((k) => k.getBoundingClientRect())
  const x0 = Math.min(...rs.map((r) => r.left)) - rr.left, y0 = Math.min(...rs.map((r) => r.top)) - rr.top
  const w = Math.ceil(Math.max(...rs.map((r) => r.right)) - rr.left - x0), h = Math.ceil(Math.max(...rs.map((r) => r.bottom)) - rr.top - y0)
  const dx = Math.round(x0), dy = Math.round(y0)
  if (!dx && !dy && Math.abs(w - rr.width) < 1.5 && Math.abs(h - rr.height) < 1.5) { flush(); return }
  if (dx || dy) for (const k of kids) style(design, [k], moveProps(mover(k), -dx, -dy))
  style(design, [root], { width: `${w}px`, height: `${h}px` }, true)
  const cur = get().designs[design]
  set({ designs: { ...get().designs, [design]: { ...cur, x: cur.x + dx, y: cur.y + dy, w, h } } })
  saveLayout([{ id: design, x: cur.x + dx, y: cur.y + dy, w, h }])
}

// ---------- layers ----------
const NOT_LAYERS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'BR'])

/** An element's siblings (itself included) in the order they are painted, back to front. */
export function paintOrder(parent: Element): HTMLElement[] {
  const kids = Array.from(parent.children).filter((c) => c.hasAttribute('data-sid') && !NOT_LAYERS.has(c.tagName)) as HTMLElement[]
  return kids.map((el, i) => ({ el, i, z: parseInt(getComputedStyle(el).zIndex) || 0 })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.el)
}

/**
 * Make the siblings paint in exactly this order. Every sibling gets its own z-index (1, 2, 3…):
 * with gaps or ties the browser falls back to file order, which is why a single "z-index: 0" used to do nothing.
 */
function applyOrder(design: string, order: HTMLElement[]) {
  order.forEach((el, i) => {
    const cs = getComputedStyle(el)
    const want = String(i + 1)
    if (cs.zIndex === want && cs.position !== 'static') return
    style(design, [el], { 'z-index': want, ...(cs.position === 'static' ? { position: 'relative' } : {}) })
  })
}

export type ZDir = 'front' | 'back' | 'forward' | 'backward'
/**
 * The new back-to-front order when the chosen layers move. They move as one block and keep their own order (one at a
 * time, two neighbours would just swap back). `floor`: how many of the other layers, from the back, are background
 * that nothing may go behind.
 */
export function restack<T>(order: T[], chosen: Set<T>, floor: number, dir: ZDir): T[] {
  const picked = order.filter((x) => chosen.has(x)), rest = order.filter((x) => !chosen.has(x))
  if (dir === 'front') return [...rest, ...picked]
  if (dir === 'back') return [...rest.slice(0, floor), ...picked, ...rest.slice(floor)]
  const next = [...order]
  const base = new Set(rest.slice(0, floor))
  if (dir === 'forward') { for (let i = next.length - 2; i >= 0; i--) if (chosen.has(next[i]) && !chosen.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]] }
  else for (let i = 1; i < next.length; i++) if (chosen.has(next[i]) && !chosen.has(next[i - 1]) && !base.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]]
  return next
}
export function zOrder(dir: ZDir) {
  const { sel } = get()
  if (!sel.design) return
  const design = sel.design
  const groups = new Map<Element, Set<HTMLElement>>()
  for (const el of selected()) if (el.parentElement) groups.set(el.parentElement, (groups.get(el.parentElement) || new Set()).add(el))
  for (const [parent, chosen] of groups) {
    const order = paintOrder(parent)
    const rest = order.filter((x) => !chosen.has(x))
    // the floor is just above a full-bleed background, so "to back" never hides a piece behind the photo
    let floor = 0
    if (![...chosen].some((x) => isWrapper(design, x))) while (floor < rest.length && isWrapper(design, rest[floor])) floor++
    const next = restack(order, chosen, floor, dir)
    if (next.some((x, i) => x !== order[i])) applyOrder(design, next) // nothing to move: no write, no undo step
  }
  flush()
}

/** Drop a layer just in front of, or just behind, one of its siblings (the layers list). */
export function moveLayer(design: string, el: HTMLElement, target: HTMLElement, where: 'front' | 'behind') {
  const parent = el.parentElement
  if (!parent || target.parentElement !== parent || el === target) return
  const order = paintOrder(parent).filter((x) => x !== el)
  const at = order.indexOf(target)
  if (at < 0) return
  order.splice(where === 'front' ? at + 1 : at, 0, el)
  applyOrder(design, order)
  flush()
}

export function toggleHidden(design: string, el: HTMLElement) {
  const hidden = getComputedStyle(el).display === 'none'
  style(design, [el], { display: hidden ? (el.style.display === 'none' ? null : 'block') : 'none' }, true)
}

export function selectParent() {
  const { sel } = get()
  if (!sel.design) return
  const el = elOf(sel.design, sel.sids[0])
  const up = el ? parentSel(sel.design, el) : null
  select(up || !sel.sids.length ? (up ? sel.design : null) : sel.design, up ? [sidOf(up)] : [])
}

// ---------- text editing ----------
// n0: how many tags the copy held when editing began. undo: the copy before and after each "style these words" step.
let editState: { el: HTMLElement; before: string; off: () => void; range: Range | null; n0: number; undo: { before: string; after: string; from: number; to: number }[] } | null = null
/**
 * What ending a text edit did to the file. Elements are numbered in file order, so adding or removing a <br> or a
 * styled run moves the sid of every element after the copy by `delta` once the design reloads.
 */
export interface Fin { design: string; after: number; delta: number; gone?: number }
/** Where an element picked from the document as it was before `fin` will be once the design has reloaded. */
export const sidAfter = (fin: Fin | null, design: string, sid: number) => (fin && fin.design === design && sid > fin.after ? sid + fin.delta : sid)
/**
 * Select an element that was just clicked. Right after a text edit, or while the design is reloading, its sid comes from
 * the old document: translate it, and note what the element is so the reload can confirm or correct it. Returns true
 * when the document under the click is on its way out, so nothing else (a drag) should start on it.
 */
export function selectFresh(fin: Fin | null, design: string, el: HTMLElement | null, also: number[] = []): boolean {
  const going = (!!fin && fin.design === design) || isReloading(design)
  const sid = el ? sidAfter(fin, design, sidOf(el)) : null
  select(design, sid == null ? also : [...also.filter((x) => x !== sid), sid])
  if (going && el && sid != null) rememberSelection(design, [[sid, el]], fin?.delta)
  return going
}
// A press on the properties panel must not end text editing: that is how you restyle the selected words.
let panelPress = 0
if (typeof window !== 'undefined') window.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement | null)?.closest?.('.panel.right')) panelPress = Date.now() }, true)

/** While copy is being edited with some of it selected: the element that selection starts in (for reading its style). */
export function selectionHost(el: HTMLElement): HTMLElement | null {
  const r = editState?.el === el ? editState.range : null
  if (!r || r.collapsed) return null
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || !r.intersectsNode(n)) continue
    if (n === r.startContainer && r.startOffset >= n.data.length) continue
    if (n === r.endContainer && r.endOffset === 0) continue
    return n.parentElement || el
  }
  return el
}

/**
 * Style only the selected words. Each stretch of selected text is wrapped in its own <font style> run, inside
 * whatever tag it already sits in. A <font> on purpose: the file's own CSS (".sale span", ".side b") never targets
 * it, so the run takes exactly the style it is given and nothing else. Nothing around the text is split or moved.
 * Returns false when there is no selection to style.
 */
export function styleSelection(el: HTMLElement, props: Record<string, string | null>): boolean {
  const st = editState
  if (!st || st.el !== el || !st.range || st.range.collapsed) return false
  const doc = el.ownerDocument
  const r = st.range
  const parts: { n: Text; start: number; end: number }[] = []
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data || !r.intersectsNode(n)) continue
    const start = n === r.startContainer ? r.startOffset : 0
    const end = n === r.endContainer ? r.endOffset : n.data.length
    if (end > start) parts.push({ n, start, end })
  }
  if (!parts.length) return false
  const was = el.innerHTML
  // where the selection is, counted in characters, so an undo can select the same words again
  const chars = (node: Node, offset: number) => { const pre = doc.createRange(); pre.selectNodeContents(el); pre.setEnd(node, offset); return pre.toString().length }
  const from = chars(r.startContainer, r.startOffset), to = chars(r.endContainer, r.endOffset)
  const runs: HTMLElement[] = []
  for (const { n, start, end } of parts) {
    let t = n
    if (end < t.data.length) t.splitText(end)
    if (start > 0) t = t.splitText(start)
    const p = t.parentElement
    let run: HTMLElement
    if (p && p !== el && p.tagName === 'FONT' && p.childNodes.length === 1) run = p
    else { run = doc.createElement('font'); t.replaceWith(run); run.appendChild(t) }
    for (const [k, v] of Object.entries(props)) { if (v === null) run.style.removeProperty(k); else run.style.setProperty(k, v) }
    runs.push(run)
  }
  const nr = doc.createRange()
  nr.setStart(runs[0], 0)
  nr.setEnd(runs[runs.length - 1], runs[runs.length - 1].childNodes.length)
  st.range = nr
  const sl = doc.getSelection()
  sl?.removeAllRanges(); sl?.addRange(nr)
  st.undo.push({ before: was, after: el.innerHTML, from, to })
  bump()
  return true
}

/** ⌘Z while copy is being edited: take back the last "style these words" step. False when there is none to take back. */
export function undoStyle(): boolean {
  const st = editState
  const top = st?.undo[st.undo.length - 1]
  // typed since then: putting the old markup back would throw the typing away, so leave it to the browser's own undo
  if (!st || !top || top.after !== st.el.innerHTML) return false
  st.undo.pop()
  st.el.innerHTML = top.before
  // the words stay selected, ready for the next try
  const doc = st.el.ownerDocument
  const range = doc.createRange()
  range.selectNodeContents(st.el)
  const walker = doc.createTreeWalker(st.el, NodeFilter.SHOW_TEXT)
  let seen = 0, open = false
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!open && top.from <= seen + n.data.length) { range.setStart(n, top.from - seen); open = true }
    if (open && top.to <= seen + n.data.length) { range.setEnd(n, top.to - seen); break }
    seen += n.data.length
  }
  st.range = range
  const sl = doc.getSelection()
  sl?.removeAllRanges(); sl?.addRange(range)
  bump()
  return true
}

export function startEditing(design: string, el: HTMLElement, at?: { x: number; y: number }) {
  if (editState) finishEditing()
  flush()
  const before = clean(el.innerHTML)
  el.setAttribute('contenteditable', 'true')
  // decorative children (a toggle graphic, an icon) must not take typed text
  el.querySelectorAll<HTMLElement>('*').forEach((c) => { if (!c.textContent?.trim() && c.tagName !== 'BR') c.setAttribute('contenteditable', 'false') })
  const doc = el.ownerDocument
  const key = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase()
    if (e.key === 'Enter') { e.preventDefault(); doc.execCommand('insertLineBreak') }
    if (mod && k === 'z' && !e.shiftKey && undoStyle()) e.preventDefault()
    // The browser's own bold/italic/underline wrap the words in <b>, <i>, <u>, which the file's CSS may restyle (".side b").
    if (mod && (k === 'b' || k === 'i' || k === 'u')) {
      e.preventDefault()
      const cs = getComputedStyle(selectionHost(el) || el)
      if (k === 'b') styleSelection(el, { 'font-weight': Number(cs.fontWeight) >= 600 ? '400' : '700' })
      if (k === 'i') styleSelection(el, { 'font-style': cs.fontStyle === 'italic' ? 'normal' : 'italic' })
      if (k === 'u') styleSelection(el, { 'text-decoration': cs.textDecorationLine.includes('underline') ? 'none' : 'underline' })
    }
  }
  const paste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r/g, '')
    if (text && text === clipText()) return // an element copied on the canvas, not words
    // Line by line: a "\n" in insertText makes Chrome wrap the following lines in <div>, and the block stops being plain copy.
    text.split('\n').forEach((line, i) => { if (i) doc.execCommand('insertLineBreak'); if (line) doc.execCommand('insertText', false, line) })
  }
  // Switching to another app blurs the copy too, but that is not "done": the user is fetching words to paste. Focus comes back with the window.
  const blur = () => setTimeout(() => { if (document.hasFocus() && editState?.el === el && Date.now() - panelPress > 600) finishEditing() }, 0)
  // Leaving has to work even when the copy has lost focus (after a press on the panel): the iframe takes the pointer
  // while editing, so the canvas never sees a click on another piece, and Escape goes to the iframe's body.
  const out = (e: PointerEvent) => {
    if (el.contains(e.target as Node)) return
    // this press must not leave the keyboard inside the iframe, or ⌘Z, ⌫ and the arrow keys go nowhere afterwards
    doc.addEventListener('mousedown', (m) => m.preventDefault(), { capture: true, once: true })
    const fin = finishEditing()
    const f = frames.get(design), d = get().designs[design]
    if (e.button !== 0 || !f || !d || frames.get(design)?.iframe.contentDocument !== doc) return
    // the same click selects what it landed on, as a click on the canvas does
    selectFresh(fin, design, pick(design, { x: d.x + e.clientX - f.ox, y: d.y + e.clientY - f.oy }, e.metaKey || e.ctrlKey))
  }
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finishEditing() } }
  const selChange = () => {
    const sl = doc.getSelection()
    // only while the copy itself has focus: moving to the panel must not lose (or collapse) the selection being styled
    if (!editState || editState.el !== el || !sl || !sl.rangeCount || !el.contains(sl.anchorNode) || !doc.hasFocus()) return
    editState.range = sl.getRangeAt(0).cloneRange()
    bump()
  }
  doc.addEventListener('selectionchange', selChange)
  doc.addEventListener('pointerdown', out, true)
  doc.addEventListener('keydown', esc, true)
  el.addEventListener('keydown', key)
  el.addEventListener('paste', paste)
  el.addEventListener('blur', blur)
  editState = { el, before, range: null, n0: el.querySelectorAll('*').length, undo: [], off: () => { el.removeEventListener('keydown', key); el.removeEventListener('paste', paste); el.removeEventListener('blur', blur); doc.removeEventListener('selectionchange', selChange); doc.removeEventListener('pointerdown', out, true); doc.removeEventListener('keydown', esc, true) } }
  set({ editing: { design, sid: sidOf(el) }, hover: null })
  select(design, [sidOf(el)])
  el.focus()
  const s = doc.getSelection()
  // double-click: select the word under the pointer. Enter: select everything.
  const caret = at ? doc.caretRangeFromPoint(at.x, at.y) : null
  s?.removeAllRanges()
  if (caret && el.contains(caret.startContainer)) {
    s?.addRange(caret)
    // one step into the word first: from a word's very start, "back a word" lands on the word before it
    s?.modify('move', 'forward', 'character')
    s?.modify('move', 'backward', 'word')
    s?.modify('extend', 'forward', 'word')
  } else {
    const range = doc.createRange()
    range.selectNodeContents(el)
    s?.addRange(range)
  }
}

const LOST = 'The file changed while you were typing, so that text was not saved.'
const LONE_NBSP = /([^\s>;])&nbsp;(?=[^\s<&])/g, END_NBSP = /&nbsp;(?=(?:<\/\w+>)*(?:<br|$))/g // (a line can end inside a tag: "$204&nbsp;</s>")
/**
 * Typing swaps a plain space for a non-breaking one next to another space and at line ends. Left in the file, two
 * words stop wrapping or a centred line sits off. Only lone ones become spaces again, and only if the copy had none
 * like it before: runs ("★★★★★&nbsp; &nbsp;Rated") and an agent's own &nbsp; are deliberate.
 */
export function plainSpaces(before: string, html: string): string {
  if (!before.match(LONE_NBSP)) html = html.replace(LONE_NBSP, '$1 ')
  if (!before.match(END_NBSP)) html = html.replace(END_NBSP, '')
  return html
}

/** End the text edit and save it. Returns what that does to the file's element numbering, or null when nothing was written. */
export function finishEditing(): Fin | null {
  const st = editState
  const { editing } = get()
  if (!st) return null
  editState = null
  st.off()
  if (!editing) return null
  set({ editing: null })
  const doc = st.el.ownerDocument
  // The design reloaded under the copy (the agent saved, an undo landed). This element belongs to a document that is
  // gone, and its sid may be another element in the new one, so it must never be written.
  if (doc !== docOf(editing.design)) { if (clean(st.el.innerHTML) !== st.before) toast(LOST); bump(); return null }
  st.el.removeAttribute('contenteditable')
  st.el.querySelectorAll('[contenteditable]').forEach((c) => c.removeAttribute('contenteditable'))
  doc.getSelection()?.removeAllRanges()
  window.focus()
  if (document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur()
  // Chrome wraps lines in <div> or <p> after some pastes and deletes. A block inside the copy would turn it into a
  // group that can no longer be retyped, so each one becomes a line break again.
  st.el.querySelectorAll('div:not([data-sid]), p:not([data-sid])').forEach((b) => { if (b.previousSibling) b.before(doc.createElement('br')); b.replaceWith(...Array.from(b.childNodes)) })
  const html = plainSpaces(st.before, clean(st.el.innerHTML))
  bump()
  if (html === st.before) return null
  const fin: Fin = { design: editing.design, after: editing.sid + st.n0, delta: st.el.querySelectorAll('*').length - st.n0 }
  const hadText = /\S/.test(st.before.replace(/<[^>]*>|&nbsp;/g, ''))
  if (hadText && !st.el.textContent?.trim() && !st.el.querySelector(':not(br)')) {
    // every word deleted: an empty block cannot be seen, clicked or retyped again, so it goes, as in Figma
    writeNow(editing.design, [{ kind: 'remove', sid: editing.sid }])
    select(editing.design, [])
    return { ...fin, delta: -(st.n0 + 1), gone: editing.sid }
  }
  writeNow(editing.design, [{ kind: 'inner', sid: editing.sid, html }])
  return fin
}

/** A design has reloaded: if copy in its old document was still being typed, leave edit mode (that element is gone). */
export function cancelEditing(design: string) {
  const st = editState
  if (get().editing?.design !== design || (st && st.el.ownerDocument === docOf(design))) return
  if (st) { editState = null; st.off(); if (clean(st.el.innerHTML) !== st.before) toast(LOST) }
  set({ editing: null })
}

export function editSelected() {
  const { sel } = get()
  const el = sel.design ? elOf(sel.design, sel.sids[0]) : null
  if (el && sel.design && isTextLeaf(el)) startEditing(sel.design, el)
}

// ---------- comments ----------
export async function addComment(design: string, pt: { x: number; y: number }, target: Element | null) {
  const d = get().designs[design]
  const r = await commentOp({ design, add: { x: Math.round(pt.x - d.x), y: Math.round(pt.y - d.y), target: target && !isRoot(design, target) ? label(target) : 'the whole design', author: 'user' } })
  set({ tool: 'move', openComment: r.id || null })
}

// ---------- viewport ----------
export function zoomTo(z: number, cx?: number, cy?: number) {
  const s = get()
  const nz = Math.max(0.02, Math.min(16, z))
  const px = cx ?? s.size.w / 2, py = cy ?? s.size.h / 2
  const wx = (px - s.view.x) / s.view.z, wy = (py - s.view.y) / s.view.z
  set({ view: { z: nz, x: px - wx * nz, y: py - wy * nz } })
}
export function zoomToBox(b: Box | null, max = 1) {
  const s = get()
  if (!b || !b.w || !b.h) return
  const pad = 70
  const z = Math.min(max, (s.size.w - pad * 2) / b.w, (s.size.h - pad * 2) / b.h)
  set({ view: { z, x: s.size.w / 2 - (b.x + b.w / 2) * z, y: s.size.h / 2 - (b.y + b.h / 2) * z } })
}
const union = (bs: Box[]): Box | null => {
  if (!bs.length) return null
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y))
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 }
}
export const fitAll = () => { const s = get(); const all = [...Object.values(s.designs), ...Object.values(s.items).filter((i) => i.kind !== 'arrow')]; if (all.length) zoomToBox(union(all)) }
export function fitSelection() {
  const { sel, designs, isel, items, dsel } = get()
  const its = [...isel.map((i) => items[i]), ...dsel.map((d) => designs[d])].filter((i) => i && (i as { kind?: string }).kind !== 'arrow') as Box[]
  if (!sel.design && its.length) return zoomToBox(union(its), 1)
  if (!sel.design) return fitAll()
  const els = selected()
  zoomToBox(els.length ? union(els.map((el) => boxOf(sel.design!, el))) : designs[sel.design], els.length ? 3 : 1)
}
export function focusDesign(id: string) {
  select(id, [])
  zoomToBox(get().designs[id])
}

/** Lay the designs out in tidy rows using their real sizes. */
export function tidy() {
  const s = get()
  const out: Design[] = []
  let x = 0, y = 0, rowH = 0, n = 0
  for (const id of s.order) {
    const d = s.designs[id]
    if (n === 8) { x = 0; y += rowH + 260; rowH = 0; n = 0 }
    out.push({ ...d, x, y })
    x += d.w + 140; rowH = Math.max(rowH, d.h); n++
  }
  const from = s.order.map((id) => ({ id, x: s.designs[id].x, y: s.designs[id].y }))
  set({ designs: Object.fromEntries(out.map((d) => [d.id, d])) })
  saveLayout(out.map((d) => ({ id: d.id, x: d.x, y: d.y })), from)
  requestAnimationFrame(fitAll)
}

/** Designs that arrived on top of another frame go in a row below everything. Nothing else moves. */
export function placeBelow(ids: string[]) {
  const s = get()
  const near = (a: Design, b: Design) => a.x < b.x + b.w + 40 && a.x + a.w + 40 > b.x && a.y < b.y + b.h + 40 && a.y + a.h + 40 > b.y
  const all = Object.values(s.designs)
  const clash = ids.map((id) => s.designs[id]).filter((d) => d && all.some((o) => o.id !== d.id && near(d, o)))
  const stay = all.filter((d) => !clash.includes(d))
  if (!clash.length || !stay.length) return
  let x = Math.min(...stay.map((d) => d.x))
  const y = Math.max(...stay.map((d) => d.y + d.h)) + 260
  const designs = { ...s.designs }
  for (const d of clash) { designs[d.id] = { ...d, x, y }; x += d.w + 140 }
  set({ designs })
  saveLayout(clash.map((d) => ({ id: d.id, x: designs[d.id].x, y })), clash.map((d) => ({ id: d.id, x: d.x, y: d.y })))
  toast(clash.length > 1 ? 'New designs placed below the others' : 'New design placed below the others')
}

// A style change still waiting to be written (or on its way) must land before the undo does, or the undo takes the
// step before it and the server then rejects the late write.
export const undo = async () => { flush(); await settledAll(); history_('undo') }
export const redo = async () => { flush(); await settledAll(); history_('redo') }
export { docOf }
