import { memo, useEffect, useRef, useState } from 'react'
import { addComment, addLoose, cancelEditing, createFrame, finishEditing, fitLoose, insert, insertImages, local, moveOut, moveProps, mover, selectFresh, startEditing, style, zoomTo, type Mover } from '../commands'
import { boxOf, designAt, docOf, elOf, frameAt, frames, isPage, isReloading, isRoot, isTextLeaf, LOOSE_PAD, markReloading, pick, piecesOf, quiet, rawBox, remeasure, restoreSelection, sidOf } from '../dom'
import { saveLayout } from '../net'
import { bump, get, select, selectFrames, set, toast, useStore, type Box, type Guide } from '../store'
import { Overlay, rotOf } from './Overlay'
import { ItemsBelow, ItemsTop } from './Items'
import { ExpandFrame } from './Expand'
import { CropFrame, startCrop } from './Crop'
import { SliceFrame } from './Slices'
import { openMenu } from './ContextMenu'
import { addMedia, addSection, addStep, addText, mediaFiles, selectItems } from '../items'
import { prepareImages } from '../alpha'
import { REVIEW } from '../mode'
import { ReviewPins, useReviewGestures } from '../review/Review'

type Pt = { x: number; y: number }

/**
 * Scaling like Photoshop (or Figma's K tool): every size in the piece grows by the same factor, so text scales like a
 * picture: font sizes, letter and line spacing, padding, borders, corners, gaps, and the parts placed inside it.
 */
type ScalePart = { el: HTMLElement; v: Record<string, number> }
const BOX = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'row-gap', 'column-gap', '-webkit-text-stroke-width']
function scaleParts(root: HTMLElement): ScalePart[] {
  const parts: ScalePart[] = []
  const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((x) => x === root || !x.parentElement?.closest('svg'))
  for (const el of all) {
    const cs = getComputedStyle(el), up = el === root ? null : getComputedStyle(el.parentElement!)
    const v: Record<string, number> = {}
    const fs = parseFloat(cs.fontSize)
    // a size it sets itself (an inherited one follows its parent by itself)
    if (el === root || fs !== parseFloat(up!.fontSize)) v['font-size'] = fs
    if (cs.letterSpacing.endsWith('px') && (el === root || cs.letterSpacing !== up!.letterSpacing)) v['letter-spacing'] = parseFloat(cs.letterSpacing)
    if (cs.lineHeight.endsWith('px') && (el === root || 'font-size' in v || cs.lineHeight !== up!.lineHeight)) v['line-height'] = parseFloat(cs.lineHeight)
    for (const p of BOX) { const n = parseFloat(cs.getPropertyValue(p)); if (n) v[p] = n }
    const tag = el.tagName.toLowerCase()
    // widths: the piece's own unless its text just runs on one line; parts inside when they are given one (or are pictures and drawings)
    if (el === root ? !(cs.whiteSpace === 'nowrap' && !el.style.width) : el.style.width || tag === 'img' || tag === 'svg') v.width = el.getBoundingClientRect().width / (el === root ? 1 : 1)
    if ((el === root && el.style.height) || (el !== root && (el.style.height || tag === 'img' || tag === 'svg'))) v.height = el.getBoundingClientRect().height
    if (el !== root && (cs.position === 'absolute' || cs.position === 'relative')) { const l = parseFloat(cs.left), t = parseFloat(cs.top); if (Number.isFinite(l) && cs.left !== 'auto') v.left = l; if (Number.isFinite(t) && cs.top !== 'auto') v.top = t }
    if (Object.keys(v).length) parts.push({ el, v })
  }
  return parts
}
const scaled = (part: ScalePart, k: number) => Object.fromEntries(Object.entries(part.v).map(([p, n]) => [p, `${Math.round(n * k * 100) / 100}px`]))
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  // through: the press landed on a selection it does not replace (inside a selected group, on a transparent spot of a selected cut-out). A drag moves that selection; a plain click selects `through` instead.
  | { kind: 'move'; design: string; p0: Pt; sx: number; sy: number; els: HTMLElement[]; movers: Mover[] | null; box0: Box; targets: Box[]; clicked: number; was: boolean; shift: boolean; through?: number[] }
  | { kind: 'frame'; design: string; p0: Pt; x0: number; y0: number; moved: boolean; group?: { id: string; x0: number; y0: number }[] }
  | { kind: 'marquee'; design: string | null; p0: Pt; keep?: string[] }
  | { kind: 'resize'; design: string; handle: string; p0: Pt; el: HTMLElement; m: Mover; bw: number; bh: number; img: boolean; box0: Box; init: Record<string, string>; last: Record<string, string | null>; scale?: ScalePart[] | null; k?: number }
  | { kind: 'create'; design: string | null; p0: Pt; shape: 'rect' | 'ellipse' }
  | { kind: 'newframe'; p0: Pt }
  | { kind: 'newsection'; p0: Pt }
  | { kind: 'rotate'; design: string; el: HTMLElement; c: Pt; a0: number; r0: number; last: number | null }
  | { kind: 'fresize'; design: string; handle: string; p0: Pt; w0: number; h0: number; root: HTMLElement; init: { width: string; height: string } }

const union = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y))
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 }
}
function nearest(vals: number[], targets: number[], thr: number): number | null {
  let best: number | null = null
  for (const v of vals) for (const t of targets) { const d = t - v; if (Math.abs(d) <= thr && (best == null || Math.abs(d) < Math.abs(best))) best = d }
  return best
}
function guidesFor(box: Box, targets: Box[]): Guide[] {
  const out: Guide[] = []
  const near = (a: number, b: number) => Math.abs(a - b) < 0.6
  for (const x of [box.x, box.x + box.w / 2, box.x + box.w]) {
    const hits = targets.filter((t) => near(t.x, x) || near(t.x + t.w / 2, x) || near(t.x + t.w, x))
    if (hits.length) out.push({ axis: 'x', pos: x, from: Math.min(box.y, ...hits.map((h) => h.y)), to: Math.max(box.y + box.h, ...hits.map((h) => h.y + h.h)) })
  }
  for (const y of [box.y, box.y + box.h / 2, box.y + box.h]) {
    const hits = targets.filter((t) => near(t.y, y) || near(t.y + t.h / 2, y) || near(t.y + t.h, y))
    if (hits.length) out.push({ axis: 'y', pos: y, from: Math.min(box.x, ...hits.map((h) => h.x)), to: Math.max(box.x + box.w, ...hits.map((h) => h.x + h.w)) })
  }
  return out
}

/** One HTML file, shown live. The iframe is the real document; nothing is redrawn or converted. */
const DesignFrame = memo(function DesignFrame({ id, live }: { id: string; live: boolean }) {
  const d = useStore((s) => s.designs[id])
  const board = useStore((s) => s.board)
  const rev = useStore((s) => s.loaded[id])
  const editing = useStore((s) => s.editing?.design === id)
  const ref = useRef<HTMLIFrameElement>(null)
  const [box, setBox] = useState<{ iw: number; ih: number; ox: number; oy: number } | null>(null)

  const measure = (first: boolean) => {
    const iframe = ref.current
    const doc = iframe?.contentDocument
    const cur = get().designs[id]
    if (!iframe || !doc || !doc.body || !cur) return
    const art = doc.querySelector<HTMLElement>('.ad, [data-artboard]')
    let next: { iw: number; ih: number; ox: number; oy: number }
    let w: number, h: number
    let width = cur.width
    if (art) {
      let r = art.getBoundingClientRect()
      const iw = Math.max(iframe.offsetWidth, Math.ceil(r.right))
      if (first && iw !== iframe.offsetWidth) { iframe.style.width = `${iw}px`; r = art.getBoundingClientRect() }
      next = cur.loose ? { iw: Math.ceil(r.right) + LOOSE_PAD, ih: Math.ceil(r.bottom) + LOOSE_PAD, ox: r.left, oy: r.top } : { iw, ih: Math.max(100, Math.ceil(r.bottom)), ox: r.left, oy: r.top }
      w = Math.round(r.width); h = Math.round(r.height)
    } else {
      // the file says how wide it is (<meta name="studio:width" content="600"> on emails). A stored 1200 is the old
      // default, not a choice, so the file's own width wins over it; a width picked in the panel wins over the file.
      const declared = Number(doc.querySelector('meta[name="studio:width"]')?.getAttribute('content')) || 0
      width = declared && (!cur.width || cur.width === 1200) ? declared : cur.width || 1200
      iframe.style.width = `${width}px`
      iframe.style.height = '800px'
      h = Math.max(200, doc.documentElement.scrollHeight)
      w = width
      next = { iw: width, ih: h, ox: 0, oy: 0 }
    }
    iframe.style.width = `${next.iw}px`; iframe.style.height = `${next.ih}px`
    frames.set(id, { iframe, ox: next.ox, oy: next.oy, root: art || doc.body, art: !!art })
    setBox(next)
    if (w !== cur.w || h !== cur.h || width !== cur.width) {
      const fresh = get().designs[id] || cur // never write back a stale position
      set({ designs: { ...get().designs, [id]: { ...fresh, w, h, width } } })
      if (!quiet.has(id)) saveLayout([{ id, w, h, width }])
    }
    bump()
    // learn what each picture really looks like, then redraw boxes around the visible part
    prepareImages(doc).then(bump)
  }

  // A new version of the file is in the iframe. Whatever still pointed into the old document is settled here.
  const landed = () => {
    const doc = ref.current?.contentDocument
    if (!doc || !doc.URL.endsWith(`rev=${get().loaded[id]}`)) return // a newer version is already on its way
    cancelEditing(id) // copy being typed in the old document: that element is gone, the ad must not stay in edit mode
    restoreSelection(id) // the selection is by position in the file: check it is still the same pieces
    markReloading(id, false)
  }
  const onLoad = () => {
    measure(true)
    landed()
    const doc = ref.current?.contentDocument
    // a loose piece's file is kept the size of the piece: after copy was retyped (or an undo), fit it again
    doc?.fonts?.ready.then(() => { measure(false); if (get().designs[id]?.loose && !get().editing) setTimeout(() => { if (ref.current?.contentDocument === doc && !get().editing) fitLoose(id) }, 60) })
    setTimeout(() => measure(false), 500)
    const after = get().afterLoad
    if (after && after.design === id) {
      set({ afterLoad: null })
      const now = get().sel
      const sid = after.sid ?? (now.design === id && now.sids.length === 1 ? now.sids[0] : null)
      const el = sid != null ? elOf(id, sid) : null
      if (el) { select(id, [sidOf(el)]); if (after.edit && (after.sid != null || isTextLeaf(el))) startEditing(id, el, after.at) }
    }
  }
  useEffect(() => { if (live && frames.has(id)) measure(false) }, [d?.width]) // eslint-disable-line react-hooks/exhaustive-deps
  // Slow images or fonts can hold back the load event, so start measuring as soon as the page has parsed.
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => {
      const doc = ref.current?.contentDocument
      if (!doc || !doc.body || doc.URL === 'about:blank' || doc.readyState === 'loading') return
      if (!frames.has(id) || frames.get(id)!.iframe !== ref.current || frames.get(id)!.root?.ownerDocument !== doc) { measure(true); landed() }
      if (doc.readyState === 'complete') clearInterval(t)
    }, 400)
    return () => clearInterval(t)
  }, [live, rev]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { remeasure.set(id, () => measure(false)); return () => { remeasure.delete(id) } }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { frames.delete(id) }, [id])
  useEffect(() => { if (!live) { frames.delete(id); setBox(null) } }, [live, id])

  if (!d) return null
  const src = `/b/${encodeURIComponent(board)}/${id.split('/').map(encodeURIComponent).join('/')}?studio=1&rev=${rev}`
  return (
    <div className={`design${d.loose ? ' loose' : ''}`} style={{ left: d.x, top: d.y, width: d.w, height: d.h }}>
      {live
        ? <iframe ref={ref} src={src} onLoad={onLoad} title={id} tabIndex={-1}
            style={{ left: -(box?.ox || 0), top: -(box?.oy || 0), width: box?.iw ?? d.width ?? Math.max(1080, d.w), height: box?.ih ?? Math.max(1920, d.h), pointerEvents: editing ? 'auto' : 'none' }} />
        : <div className="placeholder">{d.loose ? '' : d.title || id.replace(/^ads\//, '').replace(/\/index(-9x16)?\.html$/, '$1')}</div>}
    </div>
  )
})

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const view = useStore((s) => s.view)
  const size = useStore((s) => s.size)
  const tool = useStore((s) => s.tool)
  const space = useStore((s) => s.space)
  const order = useStore((s) => s.order)
  const designs = useStore((s) => s.designs)
  useReviewGestures(ref)

  useEffect(() => {
    const el = ref.current!
    set({ size: { w: el.clientWidth, h: el.clientHeight } })
    const ro = new ResizeObserver(() => set({ size: { w: el.clientWidth, h: el.clientHeight } }))
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const s = get()
      if (e.ctrlKey || e.metaKey) zoomTo(s.view.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
      else set({ view: { ...s.view, x: s.view.x - e.deltaX, y: s.view.y - e.deltaY } })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { ro.disconnect(); el.removeEventListener('wheel', onWheel) }
  }, [])

  // Only designs near the viewport run as live documents. The rest are placeholders.
  const vis = { x: -view.x / view.z, y: -view.y / view.z, w: size.w / view.z, h: size.h / view.z }
  const near = order.filter((id) => {
    const d = designs[id]
    return d && (d.loose || d.w * view.z > 30) && d.x < vis.x + vis.w * 1.5 && d.x + d.w > vis.x - vis.w * 0.5 && d.y < vis.y + vis.h * 1.5 && d.y + d.h > vis.y - vis.h * 0.5
  })
  const cx = vis.x + vis.w / 2, cy = vis.y + vis.h / 2
  const liveSet = new Set(near.sort((a, b) => Math.hypot(designs[a].x + designs[a].w / 2 - cx, designs[a].y + designs[a].h / 2 - cy) - Math.hypot(designs[b].x + designs[b].w / 2 - cx, designs[b].y + designs[b].h / 2 - cy)).slice(0, REVIEW ? 10 : 28)) // (a phone runs out of memory long before a Mac)

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect()
    const v = get().view
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z }
  }

  const snapTargets = (design: string, els: HTMLElement[]): Box[] => {
    const moving = new Set(els)
    const out: Box[] = []
    const parent = els[0].parentElement
    for (const c of Array.from(parent?.children || [])) if (!moving.has(c as HTMLElement) && c.hasAttribute('data-sid')) { const b = boxOf(design, c); if (b.w && b.h) out.push(b) }
    const d = get().designs[design]
    out.push({ x: d.x, y: d.y, w: d.w, h: d.h })
    if (parent && !isRoot(design, parent)) out.push(boxOf(design, parent))
    return out
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return // right-click: the menu picks what is under the pointer (capturing it here would hide that)
    // Ending a text edit can add or remove tags, which renumbers every later element once the design reloads.
    const fin = get().editing ? finishEditing() : null
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
    const s = get()
    const t = e.target as HTMLElement
    ref.current!.setPointerCapture(e.pointerId)
    const p = toWorld(e)
    if (e.button === 1 || s.tool === 'hand' || s.space) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: s.view.x, vy: s.view.y }; return }
    if (e.button !== 0) return

    const fh = t.closest<HTMLElement>('[data-fhandle]')?.dataset.fhandle
    if (fh && s.sel.design && frames.get(s.sel.design)?.root) {
      const root = frames.get(s.sel.design)!.root!, dd = s.designs[s.sel.design]
      quiet.add(s.sel.design)
      drag.current = { kind: 'fresize', design: s.sel.design, handle: fh, p0: p, w0: dd.w, h0: dd.h, root, init: { width: root.style.width, height: root.style.height } }
      return
    }
    const handle = t.closest<HTMLElement>('[data-handle]')?.dataset.handle
    // a loose piece is resized by its own outline: the handles act on the piece inside
    const lone = s.sel.design && s.designs[s.sel.design]?.loose && !s.sel.sids.length ? piecesOf(s.sel.design) : []
    // just outside a corner: turn the piece about its middle, as in Figma
    if (t.closest('[data-rotate]') && s.sel.design) {
      if (lone.length === 1) { select(s.sel.design, [sidOf(lone[0])]); s.sel = get().sel }
      const el = s.sel.sids.length === 1 ? elOf(s.sel.design, s.sel.sids[0]) : null
      const dn = s.sel.design
      if (el && dn) {
        const b = rawBox(dn, el), c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
        drag.current = { kind: 'rotate', design: dn, el, c, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: rotOf(el), last: null }
        ref.current!.classList.add('rotating')
      }
      return
    }
    if (handle && lone.length === 1) { select(s.sel.design, [sidOf(lone[0])]); s.sel = get().sel }
    if (handle && s.sel.design && s.sel.sids.length === 1) {
      const el = elOf(s.sel.design, s.sel.sids[0])
      if (el) {
        const cs = getComputedStyle(el)
        const init = { width: el.style.width, height: el.style.height, left: el.style.left, top: el.style.top, translate: el.style.translate }
        const isImg = el.tagName === 'IMG' || el.tagName === 'svg'
        // a corner of a text block (or of anything, with the Scale tool, K) scales it all like a picture
        const scale = handle.length === 2 && !isImg && (s.scaleMode || isTextLeaf(el)) ? scaleParts(el) : null
        drag.current = { kind: 'resize', design: s.sel.design, handle, p0: p, el, m: mover(el), bw: parseFloat(cs.width) || el.offsetWidth, bh: parseFloat(cs.height) || el.offsetHeight, img: isImg, box0: boxOf(s.sel.design, el), init, last: {}, scale }
      }
      return
    }
    const lab = t.closest<HTMLElement>('[data-label]')?.dataset.label
    // a whole frame: shift adds it to (or takes it out of) the frames selected; a press on one of several selected frames moves them all
    const frameDown = (design: string) => {
      if (e.shiftKey) {
        const cur = s.dsel.length ? s.dsel : s.sel.design && !s.sel.sids.length ? [s.sel.design] : []
        selectFrames(cur.includes(design) ? cur.filter((x) => x !== design) : [...cur, design])
        return
      }
      const group = s.dsel.length > 1 && s.dsel.includes(design) ? s.dsel : null
      if (!group && (s.sel.design !== design || s.sel.sids.length)) select(design, [])
      drag.current = { kind: 'frame', design, p0: p, x0: s.designs[design].x, y0: s.designs[design].y, moved: false, group: group?.filter((id) => s.designs[id]).map((id) => ({ id, x0: s.designs[id].x, y0: s.designs[id].y })) }
    }
    if (lab) { frameDown(lab); return }
    if (s.tool === 'frame') { drag.current = { kind: 'newframe', p0: p }; return }
    if (s.tool === 'section') { drag.current = { kind: 'newsection', p0: p }; return }
    if (s.tool === 'step') { e.preventDefault(); addStep(p); return } // (no default: the new box keeps the keyboard)
    // A selected piece that hangs outside its frame (the frame crops it) can still be grabbed by its box and dragged back in.
    if (s.tool === 'move' && s.sel.design && s.sel.sids.length && !designAt(p)) {
      const d0 = s.sel.design
      const cur = s.sel.sids.map((x) => elOf(d0, x)).filter(Boolean) as HTMLElement[]
      const bs = cur.map((c) => rawBox(d0, c)) // (its whole box: the part outside the frame is what the user grabs)
      if (bs.some((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h)) {
        drag.current = { kind: 'move', design: d0, p0: p, sx: e.clientX, sy: e.clientY, els: cur, movers: null, box0: union(bs), targets: snapTargets(d0, cur), clicked: -1, was: true, shift: e.shiftKey }
        return
      }
    }
    const design = designAt(p)
    if (s.tool === 'note') { if (design) addComment(design, p, pick(design, p, false)); return }
    if (s.tool === 'text') {
      const TEXT = 'font-size:48px;font-weight:600;line-height:1.1;white-space:nowrap'
      if (design && !s.designs[design].loose) { const l = local(design, p); insert(design, `<div style="position:absolute;left:${l.x}px;top:${l.y}px;${TEXT}">Text</div>`, true) }
      else addLoose(`<div style="position:absolute;left:0px;top:0px;${TEXT};color:#ffffff">Text</div>`, { x: p.x, y: p.y, w: 110, h: 54 }, 'text', true)
      return
    }
    if (s.tool === 'rect' || s.tool === 'ellipse') { drag.current = { kind: 'create', design: design && !s.designs[design].loose ? design : null, p0: p, shape: s.tool }; return }

    // bare board: a drag draws a selection box around planning objects (shift adds to what is selected)
    if (!design) { const keep = e.shiftKey ? s.isel : []; select(null); if (keep.length) selectItems(keep); drag.current = { kind: 'marquee', design: null, p0: p, keep } as Drag; return }
    // As in Figma, one click reaches what is inside any frame (its background or its name picks the frame itself).
    // A loose piece on the board is one thing: the first click takes it whole, the next reaches inside.
    const active = s.sel.design === design
    let el = active || !s.designs[design]?.loose ? pick(design, p, e.metaKey || e.ctrlKey) : null
    // A full-bleed photo is skipped by a plain click (it counts as background). But once it IS selected
    // (from the layers list or with ⌘-click), a press on it must keep it and drag it, not drop the selection.
    if (!el && active && s.sel.sids.length) { const under = pick(design, p, true); if (under && s.sel.sids.includes(sidOf(under))) el = under }
    // The design is about to reload (a text edit just ended, a delete or undo is landing): select, but start nothing
    // on a document that is on its way out.
    if (active && (fin?.design === design || isReloading(design))) { selectFresh(fin, design, el, el && e.shiftKey ? s.sel.sids : []); return }
    const moveDrag = (els: HTMLElement[], clicked: number, was: boolean, through?: number[]): Drag => ({ kind: 'move', design, p0: p, sx: e.clientX, sy: e.clientY, els, movers: null, box0: union(els.map((x) => boxOf(design, x))), targets: snapTargets(design, els), clicked, was, shift: e.shiftKey, through })
    // As in Figma, a press on what is already selected moves it, also where a plain click would pick something else:
    // on a child of the selected group, or on a transparent spot of a selected cut-out. Not when another piece sits in
    // front of the selection at that point: then the user means that piece.
    if (active && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !(el && s.sel.sids.includes(sidOf(el)))) {
      const cur = s.sel.sids.map((x) => elOf(design, x)).filter(Boolean) as HTMLElement[]
      const f = frames.get(design), dd = s.designs[design]
      const stack = f ? docOf(design)?.elementsFromPoint(p.x - dd.x + f.ox, p.y - dd.y + f.oy) || [] : []
      const under = (b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
      const inFront = (a: Element, b: Element) => stack.indexOf(a) >= 0 && stack.indexOf(a) < stack.indexOf(b)
      if (cur.some((c) => (el ? c.contains(el) || (under(boxOf(design, c)) && inFront(c, el)) : under(boxOf(design, c))))) {
        drag.current = moveDrag(cur, -1, true, el ? [sidOf(el)] : [])
        return
      }
    }
    if (!el) {
      if (active && e.altKey) { drag.current = { kind: 'marquee', design, p0: p }; return }
      frameDown(design)
      return
    }
    const sid = sidOf(el)
    let sids = s.sel.design === design ? s.sel.sids : []
    const was = sids.includes(sid)
    // shift on a selected piece: it stays selected so a shift-drag can move it level; a shift-click takes it out on release
    if (e.shiftKey) sids = was ? sids : [...sids, sid]
    else if (!was) sids = [sid]
    select(design, sids)
    const els = sids.map((x) => elOf(design, x)).filter(Boolean) as HTMLElement[]
    if (!els.length) return
    drag.current = moveDrag(els, sid, was)
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    const s = get()
    const p = toWorld(e)
    if (!d) {
      if (s.tool !== 'move' || s.editing) { if (s.hover) set({ hover: null }); return }
      const t = e.target as HTMLElement
      const lab = t.closest<HTMLElement>('[data-label]')?.dataset.label
      const design = lab || designAt(p)
      const el = design && (design === s.sel.design || !s.designs[design]?.loose) && !lab && !t.closest('[data-handle]') && !t.closest('[data-rotate]') ? pick(design, p, e.metaKey || e.ctrlKey) : null
      const next = design ? { design, sid: el ? sidOf(el) : null } : null
      if (next?.design !== s.hover?.design || next?.sid !== s.hover?.sid) set({ hover: next })
      return
    }
    const z = s.view.z
    if (d.kind === 'pan') { set({ view: { ...s.view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } }); return }
    if (d.kind === 'rotate') {
      let a = d.r0 + ((Math.atan2(p.y - d.c.y, p.x - d.c.x) - d.a0) * 180) / Math.PI
      a = e.shiftKey ? Math.round(a / 15) * 15 : Math.round(a * 10) / 10
      a = Math.round((((a % 360) + 540) % 360 - 180) * 10) / 10
      if (a) d.el.style.rotate = `${a}deg`; else d.el.style.removeProperty('rotate')
      d.last = a
      bump()
      return
    }
    if (d.kind === 'fresize') {
      const w = d.handle.includes('e') ? Math.max(20, Math.round(d.w0 + p.x - d.p0.x)) : d.w0
      const h = d.handle.includes('s') ? Math.max(20, Math.round(d.h0 + p.y - d.p0.y)) : d.h0
      d.root.style.width = `${w}px`; d.root.style.height = `${h}px`
      remeasure.get(d.design)?.()
      return
    }
    if (d.kind === 'frame') {
      if (!d.moved && Math.hypot((p.x - d.p0.x) * z, (p.y - d.p0.y) * z) < 4) return
      d.moved = true
      const cur = s.designs[d.design]
      if (cur.loose) { const to = frameAt(p); if (to !== (s.drop?.to ?? null) || !to !== !s.drop) set({ drop: to ? { to } : null }) }
      if (d.group) { const all = { ...s.designs }; for (const g of d.group) all[g.id] = { ...all[g.id], x: Math.round(g.x0 + p.x - d.p0.x), y: Math.round(g.y0 + p.y - d.p0.y) }; set({ designs: all }); return }
      set({ designs: { ...s.designs, [d.design]: { ...cur, x: Math.round(d.x0 + p.x - d.p0.x), y: Math.round(d.y0 + p.y - d.p0.y) } } })
      return
    }
    if (d.kind === 'move') {
      if (!d.movers) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return
        d.movers = d.els.map(mover)
        set({ hover: null })
      }
      let dx = p.x - d.p0.x, dy = p.y - d.p0.y
      // shift keeps the move level or plumb: the locked axis must not be nudged by snapping either
      const lockY = e.shiftKey && Math.abs(dx) > Math.abs(dy), lockX = e.shiftKey && !lockY
      if (lockY) dy = 0
      if (lockX) dx = 0
      if (!e.ctrlKey) {
        const thr = 6 / z, b = d.box0
        const ax = nearest([b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx], d.targets.flatMap((t) => [t.x, t.x + t.w / 2, t.x + t.w]), thr)
        const ay = nearest([b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy], d.targets.flatMap((t) => [t.y, t.y + t.h / 2, t.y + t.h]), thr)
        if (ax != null && !lockX) dx += ax
        if (ay != null && !lockY) dy += ay
        set({ guides: guidesFor({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, d.targets) })
      }
      for (const m of d.movers) for (const [k, v] of Object.entries(moveProps(m, dx, dy))) { if (v === null) m.el.style.removeProperty(k); else m.el.style.setProperty(k, v) }
      ;(d as { last?: Pt }).last = { x: dx, y: dy }
      // outside its own frame: it is on its way to another frame, or onto the bare board
      const src = s.designs[d.design]
      const inside = p.x >= src.x && p.x <= src.x + src.w && p.y >= src.y && p.y <= src.y + src.h
      const to = frameAt(p)
      const drop = to && to !== d.design ? { to } : !inside && !src.loose ? { to: null } : null
      if (drop?.to !== s.drop?.to || !drop !== !s.drop) set({ drop })
      bump()
      return
    }
    if (d.kind === 'resize') {
      const dx = p.x - d.p0.x, dy = p.y - d.p0.y
      const sx = d.handle.includes('e') ? 1 : d.handle.includes('w') ? -1 : 0
      const sy = d.handle.includes('s') ? 1 : d.handle.includes('n') ? -1 : 0
      const b0 = d.box0
      const tw = Math.max(6, b0.w + sx * dx), th = Math.max(6, b0.h + sy * dy)
      const size: Record<string, string | null> = {}
      if (d.scale) {
        d.k = Math.max(0.05, Math.max(tw / b0.w, th / b0.h))
        for (const part of d.scale) for (const [k, v] of Object.entries(scaled(part, d.k))) part.el.style.setProperty(k, v)
      } else
      // Pictures always scale as a whole (so rotated and masked ones behave). Shift does it for anything else.
      if (d.img || (e.shiftKey && sx && sy)) {
        const k = sx && sy ? Math.max(tw / b0.w, th / b0.h) : sx ? tw / b0.w : th / b0.h
        size.width = `${Math.round(d.bw * k)}px`
        size.height = `${Math.round(d.bh * k)}px`
      } else {
        if (sx) size.width = `${Math.round(Math.max(4, d.bw + tw - b0.w))}px`
        if (sy) size.height = `${Math.round(Math.max(4, d.bh + th - b0.h))}px`
      }
      const put = (props: Record<string, string | null>) => { for (const [k, v] of Object.entries(props)) { if (v === null) d.el.style.removeProperty(k); else d.el.style.setProperty(k, v) } }
      // Resize, see where the element actually ended up, then shift it so the opposite side stays put.
      put(size)
      put(moveProps(d.m, 0, 0))
      const nb = boxOf(d.design, d.el)
      // A side handle on a picture scales it about its middle. On anything else it leaves the top (or left) where it is:
      // text grows downwards as it wraps, and the block must not hop up while the user sets its width.
      const anchor = (b: Box) => ({ x: sx > 0 ? b.x : sx < 0 ? b.x + b.w : d.img ? b.x + b.w / 2 : b.x, y: sy > 0 ? b.y : sy < 0 ? b.y + b.h : d.img ? b.y + b.h / 2 : b.y })
      const a0 = anchor(b0), a1 = anchor(nb)
      const mx = Math.round(a0.x - a1.x), my = Math.round(a0.y - a1.y)
      let move: Record<string, string | null> = {}
      if (mx || my) { move = moveProps(d.m, mx, my); put(move) }
      else { d.el.style.left = d.init.left; d.el.style.top = d.init.top; d.el.style.translate = d.init.translate }
      d.last = { ...size, ...move }
      bump()
      return
    }
    if (d.kind === 'marquee' || d.kind === 'create' || d.kind === 'newframe' || d.kind === 'newsection') {
      const box = { x: Math.min(d.p0.x, p.x), y: Math.min(d.p0.y, p.y), w: Math.abs(p.x - d.p0.x), h: Math.abs(p.y - d.p0.y) }
      if (d.kind === 'create' && e.shiftKey) box.w = box.h = Math.max(box.w, box.h)
      set({ marquee: box })
      if (d.kind === 'marquee' && d.design) {
        const root = frames.get(d.design)?.root
        const hits = Array.from(root?.children || []).filter((c) => c.hasAttribute('data-sid')).filter((c) => { const b = boxOf(d.design!, c); return b.w && b.h && b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y && !(b.x <= box.x && b.y <= box.y && b.x + b.w >= box.x + box.w && b.y + b.h >= box.y + box.h) })
        set({ sel: { design: d.design, sids: hits.map(sidOf) } })
      }
      if (d.kind === 'marquee' && !d.design && box.w * s.view.z > 4 && box.h * s.view.z > 4) {
        const touch = (b: Box) => b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y
        const holds = (b: Box) => b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
        // a section only when the box takes all of it, else every drag inside a section would pick the section too
        const hits = Object.values(s.items).filter((i) => i.kind !== 'arrow' && (i.kind === 'section' ? holds(i) : touch(i))).map((i) => i.id)
        const ids = [...new Set([...(d.keep || []), ...hits])]
        // frames it touches are selected too, so a whole row of designs can be moved or deleted at once
        const frames = s.order.filter((id) => s.designs[id] && touch(s.designs[id]))
        if (ids.join() !== s.isel.join() || frames.join() !== (s.dsel.length ? s.dsel : s.sel.design ? [s.sel.design] : []).join()) selectFrames(frames, ids)
      }
    }
  }

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    try { ref.current!.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    const s = get()
    if (d.kind === 'rotate') {
      ref.current!.classList.remove('rotating')
      if (d.last === null || d.last === d.r0) return
      const v = d.last ? `${d.last}deg` : null
      if (s.designs[d.design]?.loose) { style(d.design, [d.el], { rotate: v }); fitLoose(d.design); select(d.design, []) }
      else style(d.design, [d.el], { rotate: v }, true)
      return
    }
    if (d.kind === 'fresize') {
      quiet.delete(d.design)
      const c = s.designs[d.design]
      if (c.w !== d.w0 || c.h !== d.h0) { style(d.design, [d.root], { width: `${c.w}px`, height: `${c.h}px` }, true); saveLayout([{ id: d.design, w: c.w, h: c.h }]) }
      return
    }
    if (d.kind === 'newsection') {
      const box = s.marquee
      set({ marquee: null })
      addSection(box && box.w > 40 && box.h > 40 ? box : { x: d.p0.x, y: d.p0.y, w: 2400, h: 1400 })
      return
    }
    if (d.kind === 'newframe') {
      const box = s.marquee
      set({ marquee: null })
      // a drag draws the frame; a plain click drops a 4:5 ad there
      createFrame(box && box.w > 8 && box.h > 8 ? box : { x: d.p0.x, y: d.p0.y, w: 1080, h: 1350 })
      return
    }
    if (d.kind === 'frame') {
      const drop = s.drop
      set({ drop: null })
      if (!d.moved) { if (d.group) select(d.design, []); return } // a plain click on one of several picks that one
      if (d.group) { saveLayout(d.group.map((g) => ({ id: g.id, x: s.designs[g.id].x, y: s.designs[g.id].y })), d.group.map((g) => ({ id: g.id, x: g.x0, y: g.y0 }))); return }
      const c = s.designs[d.design]
      // a loose piece let go over a frame goes into it
      if (c.loose && drop?.to && piecesOf(d.design).length) { moveOut(d.design, piecesOf(d.design), drop.to).then((ok) => { if (!ok) { const now = get().designs[d.design]; if (now) set({ designs: { ...get().designs, [d.design]: { ...now, x: d.x0, y: d.y0 } } }) } }); return }
      saveLayout([{ id: d.design, x: c.x, y: c.y }], [{ id: d.design, x: d.x0, y: d.y0 }])
      return
    }
    if (d.kind === 'move') {
      set({ guides: [] })
      const last = (d as { last?: Pt }).last
      if (!d.movers || !last) { // a click, not a drag
        if (d.through) select(d.design, d.through)
        else if (d.shift && d.was) select(d.design, s.sel.sids.filter((x) => x !== d.clicked))
        else if (!d.shift && d.was && s.sel.sids.length > 1) select(d.design, [d.clicked])
        return
      }
      const drop = s.drop
      set({ drop: null })
      if (drop) { moveOut(d.design, d.els, drop.to, { movers: d.movers, dx: last.x, dy: last.y }); return }
      for (const m of d.movers) style(d.design, [m.el], moveProps(m, last.x, last.y))
      if (s.designs[d.design]?.loose) fitLoose(d.design)
      else style(d.design, [], {}, true)
      return
    }
    if (d.kind === 'resize') {
      if (d.scale && d.k) { // every scaled part is written, the piece itself with its new place
        for (const part of d.scale) style(d.design, [part.el], part.el === d.el ? { ...scaled(part, d.k), ...d.last } : scaled(part, d.k))
        if (s.designs[d.design]?.loose) { fitLoose(d.design); select(d.design, []) } else style(d.design, [], {}, true)
        return
      }
      if (Object.keys(d.last).length) { if (s.designs[d.design]?.loose) { style(d.design, [d.el], d.last); fitLoose(d.design); select(d.design, []) } else style(d.design, [d.el], d.last, true) }
      return
    }
    if (d.kind === 'marquee') { set({ marquee: null }); return }
    if (d.kind === 'create') {
      const box = s.marquee
      set({ marquee: null })
      const w = box && box.w > 3 ? Math.round(box.w) : 200, h = box && box.h > 3 ? Math.round(box.h) : 200
      if (!d.design) { const o = box && box.w > 3 ? box : d.p0; addLoose(`<div style="position:absolute;left:0px;top:0px;width:${w}px;height:${h}px;background:#d9d9d9${d.shape === 'ellipse' ? ';border-radius:50%' : ''}"></div>`, { x: o.x, y: o.y, w, h }, d.shape === 'ellipse' ? 'circle' : 'box'); return }
      const a = local(d.design, box && box.w > 3 ? box : d.p0)
      insert(d.design, `<div style="position:absolute;left:${a.x}px;top:${a.y}px;width:${w}px;height:${h}px;background:#d9d9d9${d.shape === 'ellipse' ? ';border-radius:50%' : ''}"></div>`)
    }
  }

  const onDouble = (e: React.MouseEvent) => {
    const s = get()
    if (s.tool !== 'move') return
    const lab = (e.target as HTMLElement).closest<HTMLElement>('[data-label]')?.dataset.label
    if (lab) { set({ renaming: lab }); return }
    const p = toWorld(e)
    const design = designAt(p)
    if (!design) return
    const el = pick(design, p, false)
    if (!el) return
    const f = frames.get(design), dd = s.designs[design]
    const at = f ? { x: p.x - dd.x + f.ox, y: p.y - dd.y + f.oy } : undefined
    // The document under the pointer is on its way out (the copy the user just left is being saved). The first click of this
    // double-click selected the piece by where it will be: go into it once the new document is in.
    if (isReloading(design)) {
      if (isTextLeaf(el)) { set({ afterLoad: { design, sid: null, edit: true, at } }); setTimeout(() => { const a = get().afterLoad; if (a && a.sid === null && a.design === design) set({ afterLoad: null }) }, 4000) } // (never left waiting for a reload that does not come)
      return
    }
    if (isTextLeaf(el)) {
      startEditing(design, el, at)
      return
    }
    const deep = pick(design, p, true)
    // a picture: crop it, as in Figma
    const pic = el.tagName === 'IMG' ? el : deep?.tagName === 'IMG' ? deep : null
    if (pic) { select(design, [sidOf(pic)]); startCrop({ kind: 'el', design, sid: sidOf(pic) }); return }
    if (deep) select(design, [sidOf(deep)])
  }

  return (
    <div
      ref={ref}
      className={`canvas tool-${space ? 'hand' : tool}`}
      {...(REVIEW ? {} : { // review mode (the phone) has its own touch handling: see useReviewGestures
      onPointerDown: onDown,
      onPointerMove: onMove,
      onPointerUp: onUp,
      onPointerLeave: () => !drag.current && get().hover && set({ hover: null }),
      onDoubleClick: onDouble,
      onContextMenu: (e: React.MouseEvent) => openMenu(e, toWorld(e)),
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const p = toWorld(e), design = designAt(p), files = [...e.dataTransfer.files]
        if (!files.length) return
        // into an ad: pictures go into its HTML. On the bare board (and videos anywhere): planning media you can add notes to.
        const inAd = design && !get().designs[design]?.loose
        const pics = files.filter((f) => f.type.startsWith('image/'))
        if (inAd && pics.length) insertImages(design, pics, p)
        const rest = inAd ? mediaFiles(files).filter((f) => !f.type.startsWith('image/')) : mediaFiles(files)
        if (rest.length) addMedia(rest, p)
      } })}
    >
      <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        <ItemsBelow />
        {order.map((id) => <DesignFrame key={id} id={id} live={liveSet.has(id)} />)}
        <ItemsTop />
        <ExpandFrame />
        <CropFrame />
        <SliceFrame />
      </div>
      {REVIEW ? <ReviewPins /> : <Overlay />}
    </div>
  )
}
