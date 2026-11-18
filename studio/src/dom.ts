// The live documents. Each design on the canvas is an iframe showing the real HTML file;
// this module finds elements in them and converts between canvas and document coordinates.
import { coverage, opaqueAt, visibleRect } from './alpha'
import { get, set, type Box } from './store'

export interface Frame { iframe: HTMLIFrameElement; ox: number; oy: number; root: HTMLElement | null; art: boolean }
export const frames = new Map<string, Frame>()

const INLINE = new Set(['EM', 'I', 'B', 'STRONG', 'SPAN', 'U', 'SMALL', 'SUP', 'SUB', 'MARK', 'A', 'BR', 'S', 'CODE', 'FONT'])
export const sidOf = (el: Element) => Number((el as HTMLElement).dataset?.sid ?? el.getAttribute('data-sid'))

export function docOf(design: string): Document | null {
  try { return frames.get(design)?.iframe.contentDocument || null } catch { return null }
}
export function elOf(design: string | null, sid: number): HTMLElement | null {
  if (!design) return null
  return docOf(design)?.querySelector<HTMLElement>(`[data-sid="${sid}"]`) || null
}
export function selected(): HTMLElement[] {
  const { sel } = get()
  return sel.sids.map((s) => elOf(sel.design, s)).filter(Boolean) as HTMLElement[]
}

/** Element box in canvas coordinates. */
export function boxOf(design: string, el: Element): Box {
  const f = frames.get(design)
  const d = get().designs[design]
  // pictures report what is visibly there, not their (often much larger) layout box
  const r = (el.tagName === 'IMG' && visibleRect(el as HTMLElement)) || el.getBoundingClientRect()
  if (!f || !d) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: d.x + r.left - f.ox, y: d.y + r.top - f.oy, w: r.width, h: r.height }
}

export function designAt(pt: { x: number; y: number }): string | null {
  const { designs, order } = get()
  for (let i = order.length - 1; i >= 0; i--) {
    const d = designs[order[i]]
    if (d && pt.x >= d.x && pt.x <= d.x + d.w && pt.y >= d.y && pt.y <= d.y + d.h) return d.id
  }
  return null
}

export function isRoot(design: string, el: Element): boolean {
  const f = frames.get(design)
  const doc = el.ownerDocument
  return el === f?.root || el === doc.body || el === doc.documentElement
}

/**
 * The element under a canvas point, judged by what is visible: transparent parts of a picture
 * let the click through to whatever is underneath.
 */
export function pick(design: string, pt: { x: number; y: number }, deep: boolean): HTMLElement | null {
  const hit = pickAt(design, pt, deep)
  if (hit || deep) return hit
  // Nothing but background here. A hairline (a rule, a divider, a 3px dotted line) is next to impossible to hit exactly,
  // so a thin piece within a few screen pixels of the pointer still takes the click.
  const doc = docOf(design)
  const r = 4 / (get().view.z || 1)
  const into = (v: number, lo: number, size: number) => { const e = Math.min(size / 2, 0.5); return Math.max(lo + e, Math.min(lo + size - e, v)) }
  for (const el of Array.from(doc?.querySelectorAll<HTMLElement>('[data-sid]') || [])) {
    if (isRoot(design, el)) continue
    const b = boxOf(design, el)
    if (!b.w || !b.h || Math.min(b.w, b.h) > r * 2) continue // (nothing to see, or big enough to hit)
    if (pt.x < b.x - r || pt.x > b.x + b.w + r || pt.y < b.y - r || pt.y > b.y + b.h + r) continue
    // what a click right on it would take (so whatever sits in front of it there still wins)
    const at = pickAt(design, { x: into(pt.x, b.x, b.w), y: into(pt.y, b.y, b.h) }, false)
    if (!at || (at !== el && !at.contains(el))) continue
    const ab = at === el ? b : boxOf(design, at) // a thin tag inside a block of copy stands for the block: only if that is thin too
    if (Math.min(ab.w, ab.h) <= r * 2) return at
  }
  return null
}
function pickAt(design: string, pt: { x: number; y: number }, deep: boolean): HTMLElement | null {
  const f = frames.get(design)
  const d = get().designs[design]
  const doc = docOf(design)
  if (!f || !d || !doc) return null
  const x = pt.x - d.x + f.ox, y = pt.y - d.y + f.oy
  for (const top of doc.elementsFromPoint(x, y)) {
    let el = top.closest<HTMLElement>('[data-sid]')
    if (!el) continue
    if (isRoot(design, el)) return null
    if (el.tagName === 'IMG' && !opaqueAt(el, x, y)) continue
    const svg = el.closest('svg')
    if (svg && (svg as Element) !== el && svg.hasAttribute('data-sid')) el = svg as unknown as HTMLElement
    if (deep) return el
    if (isWrapper(design, el)) return null
    // An inline bit of copy (em, span) stands for its text block. But a span sitting among
    // pictures and other pieces is its own thing, so it stays selectable on its own.
    while (INLINE.has(el.tagName)) {
      const up: HTMLElement | null = el.parentElement?.closest<HTMLElement>('[data-sid]') || null
      if (!up || isRoot(design, up) || !isTextLeaf(up)) break
      el = up
    }
    return el
  }
  return null
}

export const isPage = (design: string) => { const f = frames.get(design); return !!f && !f.art }

/**
 * Big containers (a full-bleed background, an email's outer table cell) count as the design's
 * background for a plain click. Selecting one by accident is how whole sections get deleted.
 */
export function isWrapper(design: string, el: Element): boolean {
  const d = get().designs[design]
  if (!d) return false
  const b = boxOf(design, el)
  // only what is on the ad counts: a bottle that hangs a third off the edge covers far less than its size says
  const clipped = (Math.max(0, Math.min(b.x + b.w, d.x + d.w) - Math.max(b.x, d.x)) * Math.max(0, Math.min(b.y + b.h, d.y + d.h) - Math.max(b.y, d.y))) / (d.w * d.h)
  // a picture is judged by how much of the design it visibly covers, not by its box
  const cover = el.tagName === 'IMG' ? coverage(el as HTMLElement, d.w * d.h) : null
  if (cover != null) return Math.min(cover, clipped) >= 0.85
  if (clipped >= 0.85) return true
  // an inline icon counts as one piece, however many paths it has
  if (Array.from(el.querySelectorAll('[data-sid]')).filter((c) => c.tagName === 'svg' || !c.closest('svg')).length > 20) return true
  return isPage(design) && b.h >= d.h * 0.5
}

/** True when the element is a block of copy: text with only inline tags inside. */
export function isTextLeaf(el: Element): boolean {
  if (!el.textContent?.trim() || el.closest('svg')) return false
  return Array.from(el.querySelectorAll('*')).every((c) => INLINE.has(c.tagName))
}

export function label(el: Element): string {
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('')
  const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim()
  const txt = own || (isTextLeaf(el) ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '')
  const tag = el.tagName.toLowerCase()
  return `${tag}${cls}${txt ? ` “${txt.length > 28 ? txt.slice(0, 26) + '…' : txt}”` : ''}`
}

export function parentSel(design: string, el: Element): HTMLElement | null {
  const up = el.parentElement?.closest<HTMLElement>('[data-sid]') || null
  return up && !isRoot(design, up) ? up : null
}

/** Source HTML of an element without the editor's own attributes. */
export function clean(html: string): string {
  return html.replace(/ data-sid="\d+"/g, '').replace(/ contenteditable="[^"]*"/g, '')
}

export function cssColor(v: string): { color: string; alpha: number } {
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (!m) return { color: '#000000', alpha: v === 'transparent' ? 0 : 1 }
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  return { color: '#' + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join(''), alpha: p[3] == null || Number.isNaN(p[3]) ? 1 : p[3] }
}
export function toCss(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const n = parseInt(color.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(alpha * 100) / 100})`
}

// ---------- reloads ----------
// A sid is an element's position in the file. When a design reloads (a structural edit, an undo, the agent saving),
// positions can shift, so for a moment a sid read from the old document may name a different element in the new one.
const reloadingAt = new Map<string, number>()
/** Mark a design as about to reload. Cleared when the new document is in (or after a few seconds, if it never arrives). */
export const markReloading = (design: string, on = true) => { if (on) reloadingAt.set(design, Date.now()); else reloadingAt.delete(design) }
export const isReloading = (design: string) => Date.now() - (reloadingAt.get(design) || 0) < 6000

// print: tag, class and the start of the text. nth/total: which one it is among the elements of the same tag and class.
interface Print { print: string; nth: number; total: number }
const prints = new Map<string, { n: number; at: number; of: Map<number, Print> }>()
const kindOf = (el: Element) => `${el.tagName}|${el.getAttribute('class') || ''}`
const printOf = (el: Element) => `${kindOf(el)}|${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`
const sameKind = (doc: Document, kind: string) => Array.from(doc.querySelectorAll<HTMLElement>('[data-sid]')).filter((x) => kindOf(x) === kind)

/**
 * Note what the selected elements are (tag, class, start of the text) before a reload, so the selection can find them
 * again afterwards. `picked`: elements just clicked in the old document, under the sid they are expected to have in
 * the new one; `delta`: how many elements the pending edit adds or removes.
 */
export function rememberSelection(design: string, picked?: [number, Element][], delta = 0) {
  const doc = docOf(design)
  const { sel } = get()
  if (!doc) return
  const pairs = picked || (sel.design === design ? sel.sids.map((sid) => [sid, elOf(design, sid)] as [number, Element | null]).filter((p): p is [number, Element] => !!p[1]) : [])
  if (!pairs.length) return
  const old = prints.get(design)
  const live = old && Date.now() - old.at < 10000 ? old : null
  const of = live ? live.of : new Map<number, Print>()
  for (const [sid, el] of pairs) {
    if (!picked && of.has(sid)) continue
    const peers = el.ownerDocument ? sameKind(el.ownerDocument, kindOf(el)) : []
    of.set(sid, { print: printOf(el), nth: peers.indexOf(el as HTMLElement), total: peers.length })
  }
  prints.set(design, { n: live && !picked ? live.n : doc.querySelectorAll('[data-sid]').length + delta, at: Date.now(), of })
}

/** After a reload: keep each remembered sid only if the same element is still there, follow it if it moved, drop it otherwise. */
export function restoreSelection(design: string) {
  const p = prints.get(design)
  prints.delete(design)
  const doc = docOf(design)
  const { sel } = get()
  if (!p || !doc || sel.design !== design || Date.now() - p.at > 10000) return
  const all = Array.from(doc.querySelectorAll<HTMLElement>('[data-sid]'))
  const kind = (print: string) => print.split('|').slice(0, 2).join('|')
  const sids: number[] = []
  for (const sid of sel.sids) {
    const want = p.of.get(sid)
    const el = elOf(design, sid)
    if (want == null || (el && printOf(el) === want.print)) { sids.push(sid); continue }
    const hits = all.filter((x) => printOf(x) === want.print)
    const peers = sameKind(doc, kind(want.print))
    if (hits.length === 1) sids.push(sidOf(hits[0]))
    // Its text changed (an undo of retyped copy, a restyled word) and tags inside it came or went, so its number moved:
    // it is still "the second div.side" as long as there are as many of those as before.
    else if (want.nth >= 0 && peers.length === want.total && peers[want.nth]) sids.push(sidOf(peers[want.nth]))
    // retyped but not moved: same kind of element at the same place, and nothing was added or removed around it
    else if (el && all.length === p.n && kind(printOf(el)) === kind(want.print)) sids.push(sid)
  }
  const next = [...new Set(sids)]
  if (next.join() !== sel.sids.join()) set({ sel: { design, sids: next } })
}
