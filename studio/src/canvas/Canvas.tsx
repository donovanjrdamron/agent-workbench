import { memo, useEffect, useRef, useState } from 'react'
import { addComment, cancelEditing, finishEditing, insert, insertImages, local, moveProps, mover, selectFresh, startEditing, style, zoomTo, type Mover } from '../commands'
import { boxOf, designAt, docOf, elOf, frames, isPage, isReloading, isRoot, isTextLeaf, markReloading, pick, restoreSelection, sidOf } from '../dom'
import { saveLayout } from '../net'
import { bump, get, select, set, toast, useStore, type Box, type Guide } from '../store'
import { Overlay } from './Overlay'
import { prepareImages } from '../alpha'

type Pt = { x: number; y: number }
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  // through: the press landed on a selection it does not replace (inside a selected group, on a transparent spot of a selected cut-out). A drag moves that selection; a plain click selects `through` instead.
  | { kind: 'move'; design: string; p0: Pt; sx: number; sy: number; els: HTMLElement[]; movers: Mover[] | null; box0: Box; targets: Box[]; clicked: number; was: boolean; shift: boolean; through?: number[] }
  | { kind: 'frame'; design: string; p0: Pt; x0: number; y0: number; moved: boolean }
  | { kind: 'marquee'; design: string | null; p0: Pt }
  | { kind: 'resize'; design: string; handle: string; p0: Pt; el: HTMLElement; m: Mover; bw: number; bh: number; img: boolean; box0: Box; init: Record<string, string>; last: Record<string, string | null> }
  | { kind: 'create'; design: string; p0: Pt; shape: 'rect' | 'ellipse' }

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
      next = { iw, ih: Math.max(100, Math.ceil(r.bottom)), ox: r.left, oy: r.top }
      w = Math.round(r.width); h = Math.round(r.height)
    } else {
      width = cur.width || 1200
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
      saveLayout([{ id, w, h, width }])
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
    doc?.fonts?.ready.then(() => measure(false))
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
  useEffect(() => () => { frames.delete(id) }, [id])
  useEffect(() => { if (!live) { frames.delete(id); setBox(null) } }, [live, id])

  if (!d) return null
  const src = `/b/${encodeURIComponent(board)}/${id.split('/').map(encodeURIComponent).join('/')}?studio=1&rev=${rev}`
  return (
    <div className="design" style={{ left: d.x, top: d.y, width: d.w, height: d.h }}>
      {live
        ? <iframe ref={ref} src={src} onLoad={onLoad} title={id} tabIndex={-1}
            style={{ left: -(box?.ox || 0), top: -(box?.oy || 0), width: box?.iw ?? d.width ?? Math.max(1080, d.w), height: box?.ih ?? Math.max(1920, d.h), pointerEvents: editing ? 'auto' : 'none' }} />
        : <div className="placeholder">{id.replace(/^ads\//, '').replace(/\/index(-9x16)?\.html$/, '$1')}</div>}
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
    return d && d.w * view.z > 30 && d.x < vis.x + vis.w * 1.5 && d.x + d.w > vis.x - vis.w * 0.5 && d.y < vis.y + vis.h * 1.5 && d.y + d.h > vis.y - vis.h * 0.5
  })
  const cx = vis.x + vis.w / 2, cy = vis.y + vis.h / 2
  const liveSet = new Set(near.sort((a, b) => Math.hypot(designs[a].x + designs[a].w / 2 - cx, designs[a].y + designs[a].h / 2 - cy) - Math.hypot(designs[b].x + designs[b].w / 2 - cx, designs[b].y + designs[b].h / 2 - cy)).slice(0, 28))

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
    // Ending a text edit can add or remove tags, which renumbers every later element once the design reloads.
    const fin = get().editing ? finishEditing() : null
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
    const s = get()
    const t = e.target as HTMLElement
    ref.current!.setPointerCapture(e.pointerId)
    const p = toWorld(e)
    if (e.button === 1 || s.tool === 'hand' || s.space) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: s.view.x, vy: s.view.y }; return }
    if (e.button !== 0) return

    const handle = t.closest<HTMLElement>('[data-handle]')?.dataset.handle
    if (handle && s.sel.design && s.sel.sids.length === 1 && !isPage(s.sel.design)) {
      const el = elOf(s.sel.design, s.sel.sids[0])
      if (el) {
        const cs = getComputedStyle(el)
        const init = { width: el.style.width, height: el.style.height, left: el.style.left, top: el.style.top, translate: el.style.translate }
        drag.current = { kind: 'resize', design: s.sel.design, handle, p0: p, el, m: mover(el), bw: parseFloat(cs.width) || el.offsetWidth, bh: parseFloat(cs.height) || el.offsetHeight, img: el.tagName === 'IMG' || el.tagName === 'svg', box0: boxOf(s.sel.design, el), init, last: {} }
      }
      return
    }
    const lab = t.closest<HTMLElement>('[data-label]')?.dataset.label
    if (lab) {
      select(lab, [])
      drag.current = { kind: 'frame', design: lab, p0: p, x0: s.designs[lab].x, y0: s.designs[lab].y, moved: false }
      return
    }
    const design = designAt(p)
    if (s.tool === 'note') { if (design) addComment(design, p, pick(design, p, false)); return }
    if (s.tool === 'text') {
      if (design) { const l = local(design, p); insert(design, `<div style="position:absolute;left:${l.x}px;top:${l.y}px;font-size:48px;font-weight:600;line-height:1.1;white-space:nowrap">Text</div>`, true) }
      return
    }
    if (s.tool === 'rect' || s.tool === 'ellipse') { if (design) drag.current = { kind: 'create', design, p0: p, shape: s.tool }; return }

    if (!design) { select(null); return }
    // First click picks the frame. Only an already-selected frame lets you reach inside it.
    const active = s.sel.design === design
    let el = active ? pick(design, p, e.metaKey || e.ctrlKey) : null
    // A full-bleed photo is skipped by a plain click (it counts as background). But once it IS selected
    // (from the layers list or with ⌘-click), a press on it must keep it and drag it, not drop the selection.
    if (!el && active && s.sel.sids.length) { const under = pick(design, p, true); if (under && s.sel.sids.includes(sidOf(under))) el = under }
    // The design is about to reload (a text edit just ended, a delete or undo is landing): select, but start nothing
    // on a document that is on its way out.
    if (active && (fin?.design === design || isReloading(design))) { selectFresh(fin, design, el, el && e.shiftKey ? s.sel.sids : []); return }
    const moveDrag = (els: HTMLElement[], clicked: number, was: boolean, through?: number[]): Drag => ({ kind: 'move', design, p0: p, sx: e.clientX, sy: e.clientY, els, movers: null, box0: union(els.map((x) => boxOf(design, x))), targets: snapTargets(design, els), clicked, was, shift: e.shiftKey, through })
    // As in Figma, a press on what is already selected moves it, also where a plain click would pick something else:
    // on a child of the selected group, or on a transparent spot of a selected cut-out. Not when another piece sits in
    // front of the selection at that point: then they means that piece.
    if (active && !isPage(design) && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !(el && s.sel.sids.includes(sidOf(el)))) {
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
      if (!active || s.sel.sids.length) select(design, [])
      drag.current = { kind: 'frame', design, p0: p, x0: s.designs[design].x, y0: s.designs[design].y, moved: false }
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
    // Pages are flow layouts: a click selects the element, a drag moves the whole frame.
    if (isPage(design)) { drag.current = { kind: 'frame', design, p0: p, x0: s.designs[design].x, y0: s.designs[design].y, moved: false }; return }
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
      const el = design && design === s.sel.design && !lab && !t.closest('[data-handle]') ? pick(design, p, e.metaKey || e.ctrlKey) : null
      const next = design ? { design, sid: el ? sidOf(el) : null } : null
      if (next?.design !== s.hover?.design || next?.sid !== s.hover?.sid) set({ hover: next })
      return
    }
    const z = s.view.z
    if (d.kind === 'pan') { set({ view: { ...s.view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } }); return }
    if (d.kind === 'frame') {
      if (!d.moved && Math.hypot((p.x - d.p0.x) * z, (p.y - d.p0.y) * z) < 4) return
      d.moved = true
      const cur = s.designs[d.design]
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
      // text grows downwards as it wraps, and the block must not hop up while they sets its width.
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
    if (d.kind === 'marquee' || d.kind === 'create') {
      const box = { x: Math.min(d.p0.x, p.x), y: Math.min(d.p0.y, p.y), w: Math.abs(p.x - d.p0.x), h: Math.abs(p.y - d.p0.y) }
      if (d.kind === 'create' && e.shiftKey) box.w = box.h = Math.max(box.w, box.h)
      set({ marquee: box })
      if (d.kind === 'marquee' && d.design) {
        const root = frames.get(d.design)?.root
        const hits = Array.from(root?.children || []).filter((c) => c.hasAttribute('data-sid')).filter((c) => { const b = boxOf(d.design!, c); return b.w && b.h && b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y && !(b.x <= box.x && b.y <= box.y && b.x + b.w >= box.x + box.w && b.y + b.h >= box.y + box.h) })
        set({ sel: { design: d.design, sids: hits.map(sidOf) } })
      }
    }
  }

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    try { ref.current!.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    const s = get()
    if (d.kind === 'frame') { if (d.moved) { const c = s.designs[d.design]; saveLayout([{ id: d.design, x: c.x, y: c.y }], [{ id: d.design, x: d.x0, y: d.y0 }]) } return }
    if (d.kind === 'move') {
      set({ guides: [] })
      const last = (d as { last?: Pt }).last
      if (!d.movers || !last) { // a click, not a drag
        if (d.through) select(d.design, d.through)
        else if (d.shift && d.was) select(d.design, s.sel.sids.filter((x) => x !== d.clicked))
        else if (!d.shift && d.was && s.sel.sids.length > 1) select(d.design, [d.clicked])
        return
      }
      for (const m of d.movers) style(d.design, [m.el], moveProps(m, last.x, last.y))
      style(d.design, [], {}, true)
      return
    }
    if (d.kind === 'resize') { if (Object.keys(d.last).length) style(d.design, [d.el], d.last, true); return }
    if (d.kind === 'marquee') { set({ marquee: null }); return }
    if (d.kind === 'create') {
      const box = s.marquee
      set({ marquee: null })
      const a = local(d.design, box && box.w > 3 ? box : d.p0)
      const w = box && box.w > 3 ? Math.round(box.w) : 200, h = box && box.h > 3 ? Math.round(box.h) : 200
      insert(d.design, `<div style="position:absolute;left:${a.x}px;top:${a.y}px;width:${w}px;height:${h}px;background:#d9d9d9${d.shape === 'ellipse' ? ';border-radius:50%' : ''}"></div>`)
    }
  }

  const onDouble = (e: React.MouseEvent) => {
    const s = get()
    if (s.tool !== 'move') return
    const p = toWorld(e)
    const design = designAt(p)
    if (!design) return
    const el = pick(design, p, false)
    if (!el) return
    const f = frames.get(design), dd = s.designs[design]
    const at = f ? { x: p.x - dd.x + f.ox, y: p.y - dd.y + f.oy } : undefined
    // The document under the pointer is on its way out (the copy they just left is being saved). The first click of this
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
    if (deep) select(design, [sidOf(deep)])
  }

  return (
    <div
      ref={ref}
      className={`canvas tool-${space ? 'hand' : tool}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => !drag.current && get().hover && set({ hover: null })}
      onDoubleClick={onDouble}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const p = toWorld(e); const design = designAt(p); const files = [...e.dataTransfer.files]; if (!files.length) return; if (design) insertImages(design, files, p); else toast('Drop the image on a design') }}
    >
      <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
        {order.map((id) => <DesignFrame key={id} id={id} live={liveSet.has(id)} />)}
      </div>
      <Overlay />
    </div>
  )
}
