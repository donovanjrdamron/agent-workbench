// Slices, as in Figma: mark parts of a design (an email's sections) and export each as its own picture, ready to drop
// into Klaviyo image blocks. Drag on the design to draw a slice (edges snap to the design's sides and to other slices),
// drag a slice to move it, its edges to resize, ⌫ to delete. "Slice by section" cuts the whole email at its rows.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { frames } from '../dom'
import { finishEditing, flush } from '../commands'
import { settled } from '../net'
import { get, toast, useStore } from '../store'

export interface Slice { id: string; name: string; x: number; y: number; w: number; h: number }
interface SliceState { design: string | null; list: Slice[]; sel: string | null; scale: number; format: 'png' | 'jpg'; busy: boolean; dir: string }
export const useSlices = create<SliceState>(() => ({ design: null, list: [], sel: null, scale: 2, format: 'png', busy: false, dir: '' }))
const S = useSlices.setState, G = useSlices.getState

const q = (design: string) => `board=${encodeURIComponent(get().board)}&design=${encodeURIComponent(design)}`
const post = (url: string, body: object) => fetch(url, { method: 'POST', body: JSON.stringify({ board: get().board, ...body }) }).then((r) => r.json()).catch(() => ({ error: 'Studio is not answering' }))
const uid = () => 's_' + Math.random().toString(36).slice(2, 8)
const sorted = (l: Slice[]) => [...l].sort((a, b) => a.y - b.y || a.x - b.x)

export async function startSlicing(design: string) {
  if (get().editing) finishEditing()
  S({ design, list: [], sel: null, dir: '' })
  const r = await fetch(`/api/slices?${q(design)}`).then((r) => r.json()).catch(() => ({ slices: [] }))
  if (G().design === design) S({ list: r.slices || [] })
  if (!r.slices?.length) toast('Drag across the design to draw a slice, or use Slice by section.')
}
export const stopSlicing = () => S({ design: null, list: [], sel: null })

let saveT: ReturnType<typeof setTimeout> | undefined
function save(list: Slice[]) {
  const design = G().design
  S({ list })
  if (!design) return
  clearTimeout(saveT)
  saveT = setTimeout(() => { post('/api/slices', { design, slices: sorted(list) }).then((r) => { if (r.error) toast(r.error) }) }, 250)
}

/** Cut a page at its rows: the email table's rows (or the main column's blocks), tiled top to bottom with no gaps. */
function bySection(design: string): Slice[] {
  const f = frames.get(design), doc = f?.iframe.contentDocument
  if (!f || !doc?.body) return []
  const kids = (el: Element) => [...el.children].filter((c) => !['STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE', 'BR'].includes(c.tagName) && c.getBoundingClientRect().height > 0)
  let root: Element = doc.body
  for (let i = 0; i < 12; i++) { const k = kids(root); if (k.length === 1) root = k[0]; else break }
  const rr = root.getBoundingClientRect()
  const tops: number[] = []
  // (sections placed with left/top can sit in the file in any order: cut by where they are)
  for (const top of kids(root).map((k) => Math.round(k.getBoundingClientRect().top - f.oy)).sort((a, b) => a - b)) {
    const last = tops[tops.length - 1]
    if (last === undefined || top - last >= 24) tops.push(top) // thin spacer rows join the section above
  }
  const bottom = Math.round(rr.bottom - f.oy), x = Math.round(rr.left - f.ox), w = Math.round(rr.width)
  if (!tops.length) return []
  tops[0] = Math.min(tops[0], Math.round(rr.top - f.oy))
  return tops.map((t, i) => ({ id: uid(), name: '', x, y: t, w, h: (tops[i + 1] ?? bottom) - t })).filter((s) => s.h > 0)
}

async function exportAll() {
  const { design, list, scale, format } = G()
  if (!design || !list.length) return
  S({ busy: true })
  try {
    if (get().editing) finishEditing()
    flush(); await settled(design)
    clearTimeout(saveT); await post('/api/slices', { design, slices: sorted(list) })
    const r = await post('/api/export-slices', { design, scale, format })
    if (r.exported) { S({ dir: r.dir }); toast(`Exported ${r.exported.length} slice${r.exported.length > 1 ? 's' : ''} at ${scale}x`) } else toast(r.error || 'Export failed')
  } finally { S({ busy: false }) }
}

const HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'se', 'sw']
const SNAP = 8 // screen pixels

/** The slices over the design on the board. */
export function SliceFrame() {
  const { design, list, sel } = useSlices()
  const d = useStore((s) => (design ? s.designs[design] : undefined))
  const z = useStore((s) => s.view.z)
  const drag = useRef<{ kind: string; id: string; x0: number; y0: number; s0: Slice } | null>(null)
  const [draft, setDraft] = useState<Slice | null>(null)

  useEffect(() => {
    if (!design) return
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      const { sel, list } = G()
      if ((e.key === 'Backspace' || e.key === 'Delete') && sel) { e.preventDefault(); e.stopImmediatePropagation(); save(list.filter((s) => s.id !== sel)); S({ sel: null }) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (sel) S({ sel: null }); else stopSlicing() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); stopSlicing() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [design])
  useEffect(() => { if (design && !d) stopSlicing() }, [design, d]) // the design was deleted or the board changed

  if (!design || !d) return null
  const W = d.w, H = d.h
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget.closest('.slice-layer') as HTMLElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z }
  }
  // edges stick to the design's sides and to the other slices' edges
  const snap = (v: number, axis: 'x' | 'y', skip: string) => {
    const lines = axis === 'x' ? [0, W, ...list.filter((s) => s.id !== skip).flatMap((s) => [s.x, s.x + s.w])] : [0, H, ...list.filter((s) => s.id !== skip).flatMap((s) => [s.y, s.y + s.h])]
    let best = v, gap = SNAP / z
    for (const l of lines) if (Math.abs(l - v) < gap) { gap = Math.abs(l - v); best = l }
    return Math.round(best)
  }
  const clamp = (s: Slice): Slice => { const x = Math.max(0, Math.min(W - 1, s.x)), y = Math.max(0, Math.min(H - 1, s.y)); return { ...s, x, y, w: Math.max(1, Math.min(W - x, s.w)), h: Math.max(1, Math.min(H - y, s.h)) } }

  const down = (kind: string, id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || get().space) return // space-drag pans the board as usual
    e.stopPropagation(); e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = at(e)
    if (kind === 'new') {
      const s = { id: uid(), name: '', x: snap(p.x, 'x', ''), y: snap(p.y, 'y', ''), w: 0, h: 0 }
      drag.current = { kind, id: s.id, x0: s.x, y0: s.y, s0: s }
      S({ sel: null }); setDraft(s)
    } else {
      const s0 = G().list.find((s) => s.id === id)!
      drag.current = { kind, id, x0: p.x, y0: p.y, s0 }
      S({ sel: id })
    }
  }
  const move = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g) return
    const p = at(e)
    if (g.kind === 'new') {
      const x1 = snap(p.x, 'x', ''), y1 = snap(p.y, 'y', '')
      setDraft({ ...g.s0, x: Math.min(g.x0, x1), y: Math.min(g.y0, y1), w: Math.abs(x1 - g.x0), h: Math.abs(y1 - g.y0) })
      return
    }
    const dx = p.x - g.x0, dy = p.y - g.y0, s0 = g.s0
    let n: Slice
    if (g.kind === 'move') {
      let x = s0.x + dx, y = s0.y + dy
      const sx = snap(x, 'x', s0.id), ex = snap(x + s0.w, 'x', s0.id)
      x = sx !== Math.round(x) ? sx : ex !== Math.round(x + s0.w) ? ex - s0.w : Math.round(x)
      const sy = snap(y, 'y', s0.id), ey = snap(y + s0.h, 'y', s0.id)
      y = sy !== Math.round(y) ? sy : ey !== Math.round(y + s0.h) ? ey - s0.h : Math.round(y)
      n = { ...s0, x: Math.max(0, Math.min(W - s0.w, x)), y: Math.max(0, Math.min(H - s0.h, y)) }
    } else {
      let x0 = s0.x, y0 = s0.y, x1 = s0.x + s0.w, y1 = s0.y + s0.h
      if (g.kind.includes('w')) x0 = Math.min(x1 - 4, snap(s0.x + dx, 'x', s0.id))
      if (g.kind.includes('e')) x1 = Math.max(x0 + 4, snap(s0.x + s0.w + dx, 'x', s0.id))
      if (g.kind.includes('n')) y0 = Math.min(y1 - 4, snap(s0.y + dy, 'y', s0.id))
      if (g.kind.includes('s')) y1 = Math.max(y0 + 4, snap(s0.y + s0.h + dy, 'y', s0.id))
      n = clamp({ ...s0, x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
    S({ list: G().list.map((s) => (s.id === n.id ? n : s)) })
  }
  const up = () => {
    const g = drag.current
    drag.current = null
    if (!g) return
    if (g.kind === 'new') {
      const s = draft && clamp(draft)
      setDraft(null)
      if (s && s.w >= 4 && s.h >= 4) { save([...G().list, s]); S({ sel: s.id }) }
      return
    }
    save(G().list)
  }
  const order = sorted(list)
  const line = 1.5 / z, font = 12 / z
  return (
    <>
      <div className="slice-layer" style={{ left: d.x, top: d.y, width: W, height: H }} onPointerDown={down('new', '')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {[...order, ...(draft ? [draft] : [])].map((s) => {
          const n = order.indexOf(s) + 1
          return (
            <div key={s.id} className={`slice${s.id === sel ? ' on' : ''}${s === draft ? ' draft' : ''}`} style={{ left: s.x, top: s.y, width: s.w, height: s.h, outlineWidth: line }}
              onPointerDown={s === draft ? undefined : down('move', s.id)}>
              {s !== draft && (
                <span className="slice-tag" style={{ fontSize: font, padding: `${2 / z}px ${6 / z}px`, borderRadius: 3 / z, top: 4 / z, left: 4 / z }}
                  onDoubleClick={(e) => { e.stopPropagation(); const v = prompt('Name this slice (used in the file name)', s.name); if (v !== null) save(G().list.map((x) => (x.id === s.id ? { ...x, name: v.trim() } : x))) }}>
                  {String(n).padStart(2, '0')}{s.name ? ` ${s.name}` : ''} · {s.w}×{s.h}
                </span>
              )}
              {s.id === sel && HANDLES.map((h) => (
                <div key={h} className={`slice-h sh-${h}`} onPointerDown={down(h, s.id)}
                  style={h.length === 2 ? { width: 9 / z, height: 9 / z, margin: -4.5 / z, borderWidth: line } : h === 'n' || h === 's' ? { width: 26 / z, height: 6 / z, margin: `${-3 / z}px ${-13 / z}px`, borderRadius: 3 / z } : { width: 6 / z, height: 26 / z, margin: `${-13 / z}px ${-3 / z}px`, borderRadius: 3 / z }} />
              ))}
            </div>
          )
        })}
      </div>
      {createPortal(<SliceBar />, document.body)}
    </>
  )
}

function SliceBar() {
  const { design, list, sel, scale, format, busy, dir } = useSlices()
  if (!design) return null
  const auto = () => {
    const cut = bySection(design)
    if (!cut.length) { toast('Could not find sections in this design. Draw the slices by dragging instead.'); return }
    save(cut); S({ sel: null })
  }
  return (
    <div className="slice-bar" onPointerDown={(e) => e.stopPropagation()}>
      <b>Slices{list.length ? ` · ${list.length}` : ''}</b>
      <button onClick={auto} title="Cut the email at its rows, top to bottom">Slice by section</button>
      {sel && <button onClick={() => { save(list.filter((s) => s.id !== sel)); S({ sel: null }) }} title="⌫">Delete</button>}
      {!sel && list.length > 0 && <button onClick={() => save([])}>Clear</button>}
      <span className="slice-sep" />
      <select value={scale} onChange={(e) => S({ scale: Number(e.target.value) })} title="Klaviyo: 2x keeps pictures sharp on phones">
        {[1, 2, 3].map((v) => <option key={v} value={v}>{v}x</option>)}
      </select>
      <select value={format} onChange={(e) => S({ format: e.target.value as 'png' | 'jpg' })}>
        <option value="png">PNG</option><option value="jpg">JPG</option>
      </select>
      <button className="go" disabled={busy || !list.length} onClick={exportAll}>{busy ? 'Exporting…' : `Export ${list.length || ''} slice${list.length === 1 ? '' : 's'}`}</button>
      {dir && <button onClick={() => post('/api/reveal', { path: dir })} title={dir}>Show in Finder</button>}
      <span className="slice-sep" />
      <button onClick={stopSlicing} title="Enter or Esc">Done</button>
    </div>
  )
}
