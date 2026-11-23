import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Canvas } from '../canvas/Canvas'
import { nameOf } from '../canvas/Overlay'
import { fitAll } from '../commands'
import { designAt, isRoot, label, pick } from '../dom'
import { REVIEW } from '../mode'
import { commentOp, connect, refreshBoards } from '../net'
import { get, set, toast, useStore } from '../store'
import type { Comment } from '../../shared/types'

/*
 * Review mode (the board on the phone): look around and leave comments, like Figma's app.
 * - one finger pans (with a fling), two fingers pinch-zoom, double-tap zooms in
 * - Comment, then tap the spot; or press and hold anywhere. The box opens on top of the keyboard and the board does not
 *   move under it, unless the spot would be hidden behind the keyboard: then it slides up just enough, once, and goes
 *   back when the box closes.
 */

type Pt = { x: number; y: number }
type View = { x: number; y: number; z: number }
interface R {
  placing: boolean // Comment was tapped: the next tap on the board puts the comment there
  draft: { at: Pt; text: string } | null // a comment not sent yet (its pin stays, dashed, if it has text)
  composing: boolean
  thread: string | null // the comment open at the bottom
  sheet: 'list' | 'boards' | null
  vv: { top: number; h: number } // the part of the page the keyboard leaves visible
}
export const useReview = create<R>(() => ({ placing: false, draft: null, composing: false, thread: null, sheet: null, vv: { top: 0, h: typeof innerHeight === 'number' ? innerHeight : 800 } }))
const rget = useReview.getState, rset = useReview.setState

// ---------- moving the view ----------
let anim = 0
const ease = (k: number) => 1 - Math.pow(1 - k, 3)
function animate(frame: (e: number) => View, ms = 230) {
  cancelAnimationFrame(anim)
  const t0 = performance.now()
  const step = (t: number) => { const k = Math.min(1, (t - t0) / ms); set({ view: frame(ease(k)) }); if (k < 1) anim = requestAnimationFrame(step) }
  anim = requestAnimationFrame(step)
}
const animateView = (to: View, ms?: number) => { const from = get().view; animate((e) => ({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }), ms) }
/** Zoom about a point on screen (it stays under the finger). */
function zoomAt(p: Pt, z: number) {
  const v = get().view, nz = Math.max(0.02, Math.min(16, z)), wx = (p.x - v.x) / v.z, wy = (p.y - v.y) / v.z
  animate((e) => { const zz = v.z * Math.pow(nz / v.z, e); return { z: zz, x: p.x - wx * zz, y: p.y - wy * zz } }, 260)
}

/** Where the comment's pin points, on the board. */
function pinAt(c: Comment): Pt | null {
  const s = get()
  const o = c.design ? s.designs[c.design] : c.item ? s.items[c.item] : { x: 0, y: 0 }
  return o ? { x: o.x + c.x, y: o.y + c.y } : null
}

// Keep the spot being commented on in sight above the box (and the keyboard). `back`: where the view was before.
let back: { from: View; to: View } | null = null
function reveal(w: Pt, sheetH: number) {
  const v = get().view, size = get().size, vh = Math.min(size.h, rget().vv.h)
  const x = w.x * v.z + v.x, y = w.y * v.z + v.y
  const top = 64, bottom = Math.max(top + 40, vh - sheetH - 28)
  let nx = v.x, ny = v.y
  if (y < top || y > bottom) ny = v.y + ((top + bottom) / 2 - y)
  if (x < 24 || x > size.w - 24) nx = v.x + (size.w / 2 - x)
  if (Math.abs(nx - v.x) < 1 && Math.abs(ny - v.y) < 1) return
  const to = { x: nx, y: ny, z: v.z }
  back = { from: back?.from || v, to }
  animateView(to, 220)
}
function goBack() {
  const b = back
  back = null
  const v = get().view
  // only if the user has not moved the board himself since
  if (b && Math.abs(v.x - b.to.x) < 2 && Math.abs(v.y - b.to.y) < 2 && Math.abs(v.z - b.to.z) < 0.001) animateView(b.from, 220)
}

const input = () => document.getElementById('rv-input') as HTMLTextAreaElement | null
const blur = () => { const a = document.activeElement; if (a instanceof HTMLElement) a.blur() }

/** Called straight from the tap, so iOS opens the keyboard (it only does for a focus inside a touch). */
function openDraft(at: Pt) {
  const old = rget().draft
  rset({ draft: { at, text: old?.text || '' }, composing: true, placing: false, thread: null, sheet: null })
  const el = input()
  if (el) { el.value = old?.text || ''; el.focus({ preventScroll: true }) }
}
function reopenDraft() {
  rset({ composing: true, thread: null, sheet: null, placing: false })
  input()?.focus({ preventScroll: true })
}
function openThread(id: string) {
  blur()
  rset({ thread: id, composing: false, placing: false, sheet: null })
}
/** Tap outside, or the X on a comment: close. Text not sent yet stays as a dashed pin to come back to. */
function closeAll() {
  blur()
  const d = rget().draft
  rset({ composing: false, thread: null, sheet: null, placing: false, draft: d && d.text.trim() ? d : null })
  goBack()
}
function discardDraft() { blur(); rset({ composing: false, draft: null }); goBack() }

async function sendDraft() {
  const d = rget().draft
  const text = (input()?.value ?? d?.text ?? '').trim()
  if (!d || !text) return
  const at = d.at, design = designAt(at), s = get()
  let body: Record<string, unknown>
  if (design) {
    const dd = s.designs[design], el = pick(design, at, false)
    body = { design, add: { x: Math.round(at.x - dd.x), y: Math.round(at.y - dd.y), target: el && !isRoot(design, el) ? label(el) : 'the whole design', author: 'user', text } }
  } else {
    // on the board: the object under the spot (the smallest, a section last), so the pin moves with it
    const hit = Object.values(s.items).filter((i) => i.kind !== 'arrow' && at.x >= i.x && at.x <= i.x + i.w && at.y >= i.y && at.y <= i.y + i.h)
      .sort((a, b) => Number(a.kind === 'section') - Number(b.kind === 'section') || a.w * a.h - b.w * b.h)[0]
    const what = hit ? { box: 'note', text: 'text', section: 'section', image: 'picture', video: 'video', link: 'link', arrow: 'arrow' }[hit.kind] : ''
    body = { onBoard: true, add: { x: Math.round(at.x - (hit?.x || 0)), y: Math.round(at.y - (hit?.y || 0)), target: hit ? `the ${what}${hit.text ? ` "${hit.text.replace(/\s+/g, ' ').slice(0, 60)}"` : ''}` : 'the board', author: 'user', text, ...(hit ? { item: hit.id } : {}) } }
  }
  blur()
  rset({ draft: null, composing: false })
  const el = input(); if (el) el.value = ''
  goBack()
  const r = await commentOp(body)
  if (!r.ok) { toast(r.error || 'The comment did not save. It is kept, tap its pin to try again.'); rset({ draft: { at, text } }) }
}

// ---------- touch ----------
let ghost = { until: 0, x: 0, y: 0 } // the click a browser sends after a tap
type G =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; t0: number; lt: number; trail: { t: number; x: number; y: number }[]; held: boolean }
  | { kind: 'pinch'; d0: number; z0: number; w: Pt }

/** All touch on the board in review mode: nothing is ever selected or moved there, the board only looks. */
export function useReviewGestures(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!REVIEW || !ref.current) return
    const el = ref.current
    const pts = new Map<number, Pt>()
    let g: G | null = null
    let hold: ReturnType<typeof setTimeout> | null = null
    let lastTap = { t: 0, x: 0, y: 0 }
    let fling = 0
    const at = (e: PointerEvent): Pt => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const world = (p: Pt): Pt => { const v = get().view; return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z } }
    const noHold = () => { if (hold) { clearTimeout(hold); hold = null } }
    const pan = (p: Pt, moved: boolean): G => { const v = get().view, t = performance.now(); return { kind: 'pan', sx: p.x, sy: p.y, vx: v.x, vy: v.y, moved, t0: t, lt: t, trail: [{ t, x: p.x, y: p.y }], held: false } }
    const two = () => { const [a, b] = [...pts.values()]; return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 } }

    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.rv-pin')) return // a pin opens on its own
      e.preventDefault()
      cancelAnimationFrame(anim); cancelAnimationFrame(fling)
      try { el.setPointerCapture(e.pointerId) } catch { /* already gone */ }
      const p = at(e)
      pts.set(e.pointerId, p)
      if (pts.size === 1) {
        g = pan(p, false)
        noHold()
        // press and hold: a comment right there (it opens when the finger lifts, so the keyboard can come up)
        hold = setTimeout(() => { hold = null; if (g?.kind === 'pan' && !g.moved && pts.size === 1) { g.held = true; rset({ draft: { at: world(p), text: rget().draft?.text || '' }, composing: false, thread: null, sheet: null, placing: false }) } }, 450)
      } else if (pts.size === 2) {
        noHold()
        const { m, d } = two()
        g = { kind: 'pinch', d0: d, z0: get().view.z, w: world(m) }
      }
    }
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      const p = at(e)
      pts.set(e.pointerId, p)
      if (!g) return
      if (g.kind === 'pinch') {
        if (pts.size < 2) return
        const { m, d } = two(), z = Math.max(0.02, Math.min(16, g.z0 * d / g.d0))
        set({ view: { z, x: m.x - g.w.x * z, y: m.y - g.w.y * z } })
        return
      }
      if (g.held) return
      if (!g.moved) {
        if (Math.hypot(p.x - g.sx, p.y - g.sy) < 8) return
        g.moved = true
        noHold()
      }
      set({ view: { ...get().view, x: g.vx + p.x - g.sx, y: g.vy + p.y - g.sy } })
      const t = performance.now()
      g.lt = t
      g.trail.push({ t, x: p.x, y: p.y })
      while (g.trail.length > 2 && t - g.trail[0].t > 100) g.trail.shift()
    }
    const up = (e: PointerEvent, cancelled: boolean) => {
      if (!pts.has(e.pointerId)) return
      pts.delete(e.pointerId)
      noHold()
      if (!g) return
      if (g.kind === 'pinch') { g = pts.size === 1 ? pan([...pts.values()][0], true) : pts.size ? g : null; return }
      if (pts.size) return
      const was = g
      g = null
      if (cancelled) return
      if (was.held || !was.moved) ghost = { until: performance.now() + 450, x: e.clientX, y: e.clientY }
      if (was.held) { const d = rget().draft; if (d) openDraft(d.at); return }
      if (!was.moved) { tap({ x: was.sx, y: was.sy }); return }
      // a fling keeps the board gliding, unless the finger rested before it lifted
      if (performance.now() - was.lt > 70) return
      // speed over the last moments of the swipe (one jumpy sample must not throw the board), capped
      const a = was.trail[0], z = was.trail[was.trail.length - 1], span = z.t - a.t
      if (span < 16) return
      let vx = (z.x - a.x) / span, vy = (z.y - a.y) / span, last = performance.now()
      const sp = Math.hypot(vx, vy)
      if (sp < 0.2) return
      if (sp > 2.5) { vx *= 2.5 / sp; vy *= 2.5 / sp }
      const step = (t: number) => {
        const dt = Math.min(32, t - last); last = t
        const f = Math.pow(0.996, dt); vx *= f; vy *= f
        const v = get().view
        set({ view: { ...v, x: v.x + vx * dt, y: v.y + vy * dt } })
        if (Math.hypot(vx, vy) > 0.02) fling = requestAnimationFrame(step)
      }
      fling = requestAnimationFrame(step)
    }
    const tap = (p: Pt) => {
      const r = rget()
      if (r.placing) { openDraft(world(p)); return }
      if (r.composing || r.thread || r.sheet) { closeAll(); return }
      const now = performance.now()
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) { lastTap.t = 0; zoomAt(p, get().view.z * 2); return }
      lastTap = { t: now, x: p.x, y: p.y }
    }
    const onUp = (e: PointerEvent) => up(e, false), onCancel = (e: PointerEvent) => up(e, true)
    const stop = (e: Event) => e.preventDefault() // Safari's own page pinch
    // the browser follows a tap with a click where the finger was: by then a pin may sit there (the one just placed)
    const swallow = (e: MouseEvent) => { if (performance.now() < ghost.until && Math.hypot(e.clientX - ghost.x, e.clientY - ghost.y) < 30) { e.stopPropagation(); e.preventDefault() } }
    document.addEventListener('click', swallow, true)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    document.addEventListener('gesturestart', stop)
    document.addEventListener('gesturechange', stop)
    return () => {
      noHold(); cancelAnimationFrame(fling)
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('gesturestart', stop); document.removeEventListener('gesturechange', stop)
      document.removeEventListener('click', swallow, true)
    }
  }, [ref])
}

// ---------- pins ----------
export function ReviewPins() {
  const comments = useStore((s) => s.comments)
  const view = useStore((s) => s.view)
  useStore((s) => s.designs); useStore((s) => s.items)
  const draft = useReview((s) => s.draft)
  const thread = useReview((s) => s.thread)
  const composing = useReview((s) => s.composing)
  const pos = (w: Pt) => ({ left: w.x * view.z + view.x, top: w.y * view.z + view.y })
  return (
    <div className="overlay">
      {comments.map((c, i) => {
        if (c.resolved && thread !== c.id) return null
        const w = pinAt(c)
        return w && <button key={c.id} className={`rv-pin${c.author === 'agent' ? ' agent' : ''}${thread === c.id ? ' on' : ''}`} style={pos(w)} onClick={() => (thread === c.id ? closeAll() : openThread(c.id))}><span>{c.author === 'agent' ? 'AI' : i + 1}</span></button>
      })}
      {draft && <button className={`rv-pin draft${composing ? ' on' : ''}`} style={pos(draft.at)} onClick={() => (composing ? closeAll() : reopenDraft())}><span>+</span></button>}
    </div>
  )
}

// ---------- the bottom boxes ----------
/** Measures itself, and keeps `w` (the spot it is about) in sight above it. */
function useSheet(w: Pt | null, open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const vh = useReview((s) => s.vv.h)
  useEffect(() => {
    if (!open || !w) return
    // wait for the keyboard to settle, then move (at most) once
    const t = setTimeout(() => reveal(w, ref.current?.offsetHeight || 120), 160)
    return () => clearTimeout(t)
  }, [open, vh, w?.x, w?.y]) // eslint-disable-line react-hooks/exhaustive-deps
  return ref
}

function Composer() {
  const draft = useReview((s) => s.draft)
  const open = useReview((s) => s.composing)
  const [text, setText] = useState('')
  const ref = useSheet(open ? draft?.at || null : null, open)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (open) setText(ta.current?.value || '') }, [open])
  const grow = () => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(140, el.scrollHeight)}px` } }
  useLayoutEffect(grow, [text, open])
  const where = (() => {
    if (!draft) return ''
    const id = designAt(draft.at)
    return id ? nameOf(get().designs[id], id) : 'the board'
  })()
  return (
    // always in the page (hidden when shut) so a tap can focus it at once and the keyboard comes up with it
    <div ref={ref} className={`rv-sheet rv-compose${open ? '' : ' off'}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="rv-head"><span className="rv-where">Comment on {where}</span><button className="rv-x" aria-label="Discard" onPointerDown={(e) => e.preventDefault()} onClick={discardDraft}>×</button></div>
      <div className="rv-row">
        <textarea id="rv-input" ref={ta} rows={1} placeholder="Add a comment" enterKeyHint="send" autoComplete="off"
          onChange={(e) => { setText(e.target.value); const d = rget().draft; if (d) rset({ draft: { ...d, text: e.target.value } }) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDraft() } }} />
        {/* keeps the keyboard up: the press does not take focus from the box */}
        <button className="rv-send" disabled={!text.trim()} aria-label="Send" onPointerDown={(e) => e.preventDefault()} onClick={sendDraft}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  )
}

function Thread() {
  const id = useReview((s) => s.thread)
  const comments = useStore((s) => s.comments)
  const index = comments.findIndex((c) => c.id === id)
  const c = comments[index]
  const w = c ? pinAt(c) : null
  const ref = useSheet(w, !!c)
  const [reply, setReply] = useState('')
  useEffect(() => setReply(''), [id])
  if (!c) return null
  const send = () => { const t = reply.trim(); if (!t) return; commentOp({ design: c.design, update: { id: c.id }, reply: { by: 'user', text: t } }); setReply('') }
  const where = c.design ? nameOf(get().designs[c.design], c.design) : 'the board'
  return (
    <div ref={ref} className="rv-sheet rv-thread" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rv-head">
        <span className="rv-where"><b>{c.author === 'agent' ? 'AI' : `#${index + 1}`}</b> · {where}</span>
        <button className="rv-chip" onClick={() => { commentOp({ design: c.design, update: { id: c.id, resolved: !c.resolved } }); if (!c.resolved) closeAll() }}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
        <button className="rv-x" aria-label="Close" onPointerDown={(e) => e.preventDefault()} onClick={closeAll}>×</button>
      </div>
      <div className="rv-body">
        {c.target && <p className="rv-target">On {c.target}</p>}
        <p className={`rv-msg ${c.author}`}>{c.text || <i>(empty)</i>}</p>
        {c.replies.map((r, i) => <p key={i} className={`rv-msg ${r.by}`}><b>{r.by === 'agent' ? 'Agent' : 'You'}</b> {r.text}</p>)}
      </div>
      <div className="rv-row">
        <textarea rows={1} value={reply} placeholder="Reply" enterKeyHint="send" onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="rv-send" disabled={!reply.trim()} aria-label="Send" onPointerDown={(e) => e.preventDefault()} onClick={send}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  )
}

function List() {
  const comments = useStore((s) => s.comments)
  const designs = useStore((s) => s.designs)
  const open = comments.map((c, i) => ({ c, i })).filter(({ c }) => !c.resolved)
  const go = (c: Comment) => {
    const w = pinAt(c)
    rset({ sheet: null })
    if (!w) return
    const s = get(), z = Math.max(s.view.z, 0.5)
    back = null
    animateView({ z, x: s.size.w / 2 - w.x * z, y: Math.min(s.size.h, rget().vv.h) * 0.33 - w.y * z }, 300)
    setTimeout(() => openThread(c.id), 310)
  }
  return (
    <div className="rv-sheet rv-list" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rv-head"><span className="rv-where"><b>{open.length ? `${open.length} open comment${open.length > 1 ? 's' : ''}` : 'No open comments'}</b></span><button className="rv-x" aria-label="Close" onClick={closeAll}>×</button></div>
      <div className="rv-body">
        {open.map(({ c, i }) => (
          <button key={c.id} className="rv-item" onClick={() => go(c)}>
            <span className={`rv-num${c.author === 'agent' ? ' agent' : ''}`}>{c.author === 'agent' ? 'AI' : i + 1}</span>
            <span className="rv-item-text"><span>{c.text || '(empty)'}</span><small>{c.design ? nameOf(designs[c.design], c.design) : 'Board'}{c.replies.length ? ` · ${c.replies.length} repl${c.replies.length > 1 ? 'ies' : 'y'}` : ''}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Boards() {
  const boards = useStore((s) => s.boards)
  const board = useStore((s) => s.board)
  const pickBoard = (name: string) => {
    closeAll()
    rset({ draft: null })
    if (name === board) return
    history.replaceState(null, '', `?board=${encodeURIComponent(name)}`)
    connect(name)
  }
  return (
    <div className="rv-sheet rv-list" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rv-head"><span className="rv-where"><b>Boards</b></span><button className="rv-x" aria-label="Close" onClick={closeAll}>×</button></div>
      <div className="rv-body">
        {boards.filter((b) => !b.closed).map((b) => <button key={b.name} className={`rv-item${b.name === board ? ' on' : ''}`} onClick={() => pickBoard(b.name)}><span className="rv-item-text"><span>{b.name}</span></span></button>)}
      </div>
    </div>
  )
}

// ---------- the page ----------
export function ReviewApp() {
  const board = useStore((s) => s.board)
  const count = useStore((s) => s.order.length)
  const comments = useStore((s) => s.comments)
  const connected = useStore((s) => s.connected)
  const toastMsg = useStore((s) => s.toast)
  const r = useReview()
  const [ready, setReady] = useState(false)
  const [fitted, setFitted] = useState('')
  useEffect(() => { document.title = board ? `${board} · Review` : 'Studio review' }, [board])
  useEffect(() => {
    (async () => {
      const list = await refreshBoards()
      const asked = new URLSearchParams(location.search).get('board')
      const aliases: Record<string, string> = asked ? await fetch('/api/boards').then((r) => r.json()).then((j) => j.aliases || {}).catch(() => ({})) : {}
      const want = (asked && aliases[asked]) || asked
      const pick = list.find((b) => b.name === want) || list.filter((b) => !b.closed).pop()
      if (pick) connect(pick.name)
      setReady(true)
    })()
  }, [])
  useEffect(() => { if (board && count && fitted !== board) { setFitted(board); requestAnimationFrame(fitAll) } }, [board, count, fitted])
  // the keyboard: iOS keeps the page its full height and slides what is visible. Follow it so the board stays where it
  // was on screen and the box sits right on top of the keyboard.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const upd = () => { rset({ vv: { top: vv.offsetTop, h: vv.height } }); if (window.scrollY || window.scrollX) window.scrollTo(0, 0) }
    vv.addEventListener('resize', upd); vv.addEventListener('scroll', upd); upd()
    return () => { vv.removeEventListener('resize', upd); vv.removeEventListener('scroll', upd) }
  }, [])
  const open = comments.filter((c) => !c.resolved).length
  const busy = r.composing || !!r.thread || !!r.sheet
  return (
    <div className="app review" style={{ transform: r.vv.top ? `translateY(${r.vv.top}px)` : undefined }}>
      <main className="stage">
        {board ? <Canvas /> : <div className="loading">{ready ? 'No boards open. Open one on the Mac.' : 'Loading…'}</div>}
        <div className="rv-ui" style={{ height: r.vv.h }}>
          <div className="rv-top">
            <button className="rv-pill rv-board" onClick={() => rset({ sheet: r.sheet === 'boards' ? null : 'boards', thread: null, composing: false, placing: false })}>
              <span>{board || 'Studio'}</span>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6l4 4 4-4" /></svg>
            </button>
            <button className="rv-pill" onClick={() => rset({ sheet: r.sheet === 'list' ? null : 'list', thread: null, composing: false, placing: false })} aria-label="Comments">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" /></svg>
              <span>{open}</span>
            </button>
          </div>
          {!connected && board && <div className="rv-hint warn">Not connected to the Mac…</div>}
          {r.placing && <div className="rv-hint">Tap where the comment goes</div>}
          {!busy && (
            <div className="rv-bottom">
              <button className="rv-round" aria-label="Fit everything" onClick={fitAll}>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
              </button>
              <button className={`rv-fab${r.placing ? ' on' : ''}`} onClick={() => rset({ placing: !r.placing })}>
                {r.placing ? 'Cancel' : <><svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" /></svg>Comment</>}
              </button>
              <span className="rv-round-gap" />
            </div>
          )}
          <Composer />
          {r.thread && <Thread />}
          {r.sheet === 'list' && <List />}
          {r.sheet === 'boards' && <Boards />}
          {toastMsg && <div className="rv-toast">{toastMsg}</div>}
        </div>
      </main>
    </div>
  )
}
