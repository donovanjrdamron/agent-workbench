// Planning objects on the world plane: sections under everything, then arrows, then boxes, text, media and links.
// They take their own clicks, so the design canvas underneath never sees a press that was meant for them.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Item } from '../../shared/types'
import { designAt } from '../dom'
import { addBoardComment } from '../commands'
import { addNext, addNote, boxFor, commitMove, dragGroup, dropIntoDesign, openFile, selectItems, SHEET, startEdit } from '../items'
import { itemOp } from '../net'
import { AiButtons } from '../panels/AiDialog'
import { useAi } from '../ai'
import { startCrop } from './Crop'
import { get, set, useStore, type Box } from '../store'

type Pt = { x: number; y: number }
function toWorld(e: { clientX: number; clientY: number }): Pt {
  const r = document.querySelector('.canvas')!.getBoundingClientRect()
  const v = get().view
  return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z }
}
const free = () => { const s = get(); return s.tool === 'move' && !s.space }

/** Press on an item: select it, and drag it (with what it carries) if the pointer moves. */
type Corner = 'nw' | 'ne' | 'se' | 'sw'
const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw']
const RAD = Math.PI / 180
const turnable = (it: Item) => it.kind !== 'arrow' && it.kind !== 'section' && it.kind !== 'file'
/** Press on an item: select it, and drag it (with what it carries) if the pointer moves. A press on a corner grip
 * resizes it from that corner (the opposite one stays put, also when it is turned); just outside a corner turns it. */
function press(e: React.PointerEvent, it: Item, opts: { resize?: Corner; rotate?: boolean } = {}) {
  if (!free() || e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  if (get().tool === 'note' && !opts.resize && !opts.rotate) { addBoardComment(toWorld(e)); return } // the comment tool pins on board objects too
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
  const s = get()
  let ids = s.isel
  if (e.shiftKey) ids = ids.includes(it.id) ? ids.filter((i) => i !== it.id) : [...ids, it.id]
  else if (!ids.includes(it.id)) ids = [it.id]
  selectItems(ids)
  if (it.kind === 'arrow') return
  const p0 = toWorld(e)
  const sx = e.clientX, sy = e.clientY
  const g = opts.resize || opts.rotate ? { items: [it.id], designs: [] } : dragGroup(ids.filter((i) => get().items[i]?.kind !== 'arrow'))
  const start: Record<string, Item> = {}
  for (const id of g.items) start[id] = { ...get().items[id] }
  const from: Record<string, Pt> = {}
  for (const id of g.designs) from[id] = { x: get().designs[id].x, y: get().designs[id].y }
  let moved = false
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return
    moved = true
    const p = toWorld(ev), dx = Math.round(p.x - p0.x), dy = Math.round(p.y - p0.y)
    const cur = get()
    const items = { ...cur.items }
    if (opts.rotate) {
      const b = start[it.id], cx = b.x + b.w / 2, cy = b.y + b.h / 2
      let a = (b.rot || 0) + (Math.atan2(p.y - cy, p.x - cx) - Math.atan2(p0.y - cy, p0.x - cx)) / RAD
      a = ev.shiftKey ? Math.round(a / 15) * 15 : Math.round(a)
      a = ((a % 360) + 540) % 360 - 180
      items[it.id] = { ...items[it.id], rot: a || undefined }
    } else if (opts.resize) {
      const b = start[it.id], r = (b.rot || 0) * RAD, cos = Math.cos(r), sin = Math.sin(r)
      const sx = opts.resize.includes('e') ? 1 : -1, sy = opts.resize.includes('s') ? 1 : -1
      const rx = p.x - p0.x, ry = p.y - p0.y
      const lx = rx * cos + ry * sin, ly = -rx * sin + ry * cos // the drag, measured along the item's own sides
      const keep = it.kind === 'image' || it.kind === 'video' || ev.shiftKey
      let w = Math.max(80, b.w + sx * lx), h = Math.max(50, b.h + sy * ly)
      if (keep) { const k = Math.max(w / b.w, h / b.h); w = Math.max(80, b.w * k); h = (w * b.h) / b.w }
      w = Math.round(w); h = Math.round(h)
      const ex = (sx * (w - b.w)) / 2, ey = (sy * (h - b.h)) / 2 // the middle moves half the growth, turned with the item
      const mx = b.x + b.w / 2 + ex * cos - ey * sin, my = b.y + b.h / 2 + ex * sin + ey * cos
      items[it.id] = { ...items[it.id], x: Math.round(mx - w / 2), y: Math.round(my - h / 2), w, h }
    } else {
      for (const id of g.items) if (items[id]) items[id] = { ...items[id], x: start[id].x + dx, y: start[id].y + dy }
    }
    const designs = g.designs.length ? { ...cur.designs } : cur.designs
    for (const id of g.designs) designs[id] = { ...designs[id], x: from[id].x + dx, y: from[id].y + dy }
    set({ items, designs })
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (!moved) { if (!e.shiftKey && ids.length > 1) selectItems([it.id]); return } // a plain click in a group picks that one
    const p = toWorld(ev)
    const over = it.kind === 'image' && !opts.resize && !opts.rotate && g.items.every((i) => i === it.id || get().items[i]?.attach === it.id) ? designAt(p) : null
    if (over) { dropIntoDesign(it.id, over, p).then((ok) => { if (!ok) commitMove(g.items, g.designs, from) }); return }
    commitMove(g.items, g.designs, from)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Where the line from a box's centre towards `t` leaves the box. */
function edge(b: Box, t: Pt, gap: number): Pt {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const dx = t.x - cx, dy = t.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const k = Math.min(dx ? (b.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (b.h / 2 + gap) / Math.abs(dy) : Infinity)
  return { x: cx + dx * k, y: cy + dy * k }
}

function Arrows({ items, z, sel }: { items: Item[]; z: number; sel: string[] }) {
  useStore((s) => s.designs) // arrows to design frames follow them
  return (
    <svg className="it-arrows" width="1" height="1">
      {items.map((a) => {
        const A = boxFor(a.from!), B = boxFor(a.to!)
        if (!A || !B) return null
        const p = edge(A, { x: B.x + B.w / 2, y: B.y + B.h / 2 }, 8 / z), q = edge(B, { x: A.x + A.w / 2, y: A.y + A.h / 2 }, 10 / z)
        const ang = Math.atan2(q.y - p.y, q.x - p.x), hl = 14 / z, hw = 0.45
        const head = `M${q.x},${q.y} L${q.x - hl * Math.cos(ang - hw)},${q.y - hl * Math.sin(ang - hw)} L${q.x - hl * Math.cos(ang + hw)},${q.y - hl * Math.sin(ang + hw)} Z`
        const on = sel.includes(a.id)
        return (
          <g key={a.id} className={`it-arrow${on ? ' on' : ''}`}>
            <path d={`M${p.x},${p.y} L${q.x},${q.y}`} className="hit" onPointerDown={(e) => press(e, a)} />
            <path d={`M${p.x},${p.y} L${q.x},${q.y}`} className="line" />
            <path d={head} className="head" />
            {a.text ? <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 8 / z} style={{ fontSize: 13 / z }}>{a.text}</text> : null}
          </g>
        )
      })}
    </svg>
  )
}

/** The text of a box while it is being typed in. Plain text; saved as you pause and when you leave. */
function Editor({ it, seed }: { it: Item; seed?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = (final: boolean) => {
    const el = ref.current
    if (!el) return
    const text = el.innerText.replace(/\n$/, '')
    const cur = get().items[it.id]
    if (!cur) return
    const need = it.kind === 'box' ? Math.max(cur.h, Math.ceil(el.scrollHeight)) : it.kind === 'text' ? Math.max(40, Math.ceil(el.scrollHeight)) : cur.h
    const w = it.kind === 'text' ? Math.max(cur.w, Math.ceil(el.scrollWidth)) : cur.w
    if (text !== (cur.text || '') || need !== cur.h || w !== cur.w) itemOp([{ ...cur, text, h: need, w }])
    if (final && get().iedit?.id === it.id) set({ iedit: null })
  }
  useLayoutEffect(() => {
    const el = ref.current!
    el.innerText = seed ?? it.text ?? ''
    el.focus()
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r)
    if (seed) save(false)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="it-text editing" contentEditable="plaintext-only" suppressContentEditableWarning
      onPointerDown={(e) => e.stopPropagation()}
      onInput={() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => save(false), 500) }}
      onBlur={() => save(true)}
      onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); (e.target as HTMLElement).blur() } }} />
  )
}

function ItemView({ it, on, edit, seed, board, z }: { it: Item; on: boolean; edit: boolean; seed?: string; board: string; z: number }) {
  const grows = it.kind === 'text' || it.kind === 'box'
  const box = useRef<HTMLDivElement>(null)
  // a box is never shorter than its text: the board keeps the real height so arrows meet its edge
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !grows) return
    const fit = () => { const cur = get().items[it.id]; const h = Math.ceil(el.offsetHeight); if (cur && h > cur.h + 1) set({ items: { ...get().items, [it.id]: { ...cur, h } } }) }
    fit()
    const ro = new ResizeObserver(fit); ro.observe(el)
    return () => ro.disconnect()
  }, [it.id, grows])
  const flip = it.fx || it.fy ? `${it.fx ? -1 : 1} ${it.fy ? -1 : 1}` : undefined
  const style = { left: it.x, top: it.y, width: it.w, rotate: it.rot ? `${it.rot}deg` : undefined, scale: flip, height: grows ? undefined : it.h, minHeight: grows ? it.h : undefined, outlineWidth: on ? 2 / z : 0, ...(it.fs ? { '--fs': `${it.fs}px`, padding: `${Math.round(it.fs * 0.45)}px ${Math.round(it.fs * 0.6)}px` } : {}) } as React.CSSProperties
  const media = `/b/${encodeURIComponent(board)}/${(it.src || '').split('/').map(encodeURIComponent).join('/')}`
  const dbl = (e: React.MouseEvent) => {
    if (!free()) return
    e.stopPropagation()
    if (it.kind === 'box' || it.kind === 'text') startEdit(it.id)
    else if (it.kind === 'link' && it.url) window.open(it.url, '_blank', 'noopener')
    else if (it.kind === 'image') startCrop({ kind: 'item', id: it.id })
    else if (it.kind === 'file' && it.src) openFile(it.src)
  }
  if (it.kind === 'section') {
    return (
      <div data-iid={it.id} className={`it it-section${on ? ' on' : ''}`} style={style} onPointerDown={(e) => press(e, it)}>
        <div className="it-section-title" style={{ fontSize: 13 / z, top: -22 / z }} onPointerDown={(e) => press(e, it)} onDoubleClick={(e) => { e.stopPropagation(); startEdit(it.id) }}>
          {edit ? <Editor it={it} /> : it.text || 'Section'}
        </div>
      </div>
    )
  }
  return (
    <div ref={box} data-iid={it.id} className={`it it-${it.kind === 'text' ? 'label' : it.kind}${it.color ? ` c-${it.color}` : ''}${on ? ' on' : ''}${!it.text && it.kind === 'box' && !edit ? ' empty' : ''}`} style={style}
      onPointerDown={(e) => { if (it.kind === 'video' && on && (e.target as HTMLElement).tagName === 'VIDEO') { e.stopPropagation(); return } press(e, it) }}
      onDoubleClick={dbl}>
      {(it.kind === 'box' || it.kind === 'text') && (edit ? <Editor it={it} seed={seed} /> : <div className="it-text">{it.text}</div>)}
      {it.kind === 'image' && <img src={media} draggable={false} alt="" />}
      {it.kind === 'video' && <>
        <div className="it-grab" style={{ fontSize: 12 / z, height: 26 / z, top: -28 / z }}>▶ {it.text || 'video'}</div>
        <video src={media} controls={on} preload="metadata" playsInline />
      </>}
      {it.kind === 'file' && <FileCard it={it} board={board} />}
      {it.kind === 'link' && <>
        <div className="it-link-url">{it.text || it.url}</div>
        <div className="it-link-host">{(() => { try { return new URL(it.url || '').hostname } catch { return it.url } })()}</div>
        <a className="it-link-open" href={it.url} target="_blank" rel="noopener" onPointerDown={(e) => e.stopPropagation()} title="Open link">↗</a>
      </>}
    </div>
  )
}

const fmtSize = (n?: number) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`)
const FILE_TINT: Record<string, string> = { csv: 'sheet', tsv: 'sheet', xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', numbers: 'sheet', pdf: 'pdf', doc: 'doc', docx: 'doc', pages: 'doc', txt: 'doc', md: 'doc', ppt: 'deck', pptx: 'deck', key: 'deck', zip: 'zip' }
type Sheet = { rows: string[][]; total: number; sheet?: string; sheets?: number }
/** A file on the board: its kind, name and size, and for a spreadsheet the first rows. Double-click opens it in its app. */
function FileCard({ it, board }: { it: Item; board: string }) {
  const ext = ((it.src || it.text || '').split('.').pop() || '').toLowerCase()
  const sheet = SHEET.test(it.src || '')
  const [pv, setPv] = useState<Sheet | null>(null)
  useEffect(() => {
    if (!sheet || !it.src) return
    let gone = false
    fetch(`/api/file-preview?board=${encodeURIComponent(board)}&src=${encodeURIComponent(it.src)}`).then((r) => r.json()).then((j) => { if (!gone && Array.isArray(j.rows)) setPv(j) }).catch(() => {})
    return () => { gone = true }
  }, [board, it.src, sheet])
  const facts = [fmtSize(it.bytes), pv?.total ? `${pv.total.toLocaleString()} rows` : '', pv?.sheets && pv.sheets > 1 ? `${pv.sheets} sheets` : ''].filter(Boolean).join(' · ')
  return <>
    <div className="it-file-head">
      <span className={`it-file-badge f-${FILE_TINT[ext] || 'other'}`}>{(ext || 'file').slice(0, 4).toUpperCase()}</span>
      <div className="it-file-meta"><div className="it-file-name">{it.text || it.src?.split('/').pop()}</div>{facts && <div className="it-file-size">{facts}</div>}</div>
      <button className="it-file-open" title="Open in its app" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (it.src) openFile(it.src) }}>↗</button>
    </div>
    {pv && pv.rows.length > 0 && (
      <div className="it-file-table">
        <table><tbody>{pv.rows.map((r, i) => <tr key={i}>{r.map((c, j) => i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>)}</tr>)}</tbody></table>
      </div>
    )}
  </>
}

/** Controls around one selected item: + on each side of a step box, + Note under media, a resize grip. */
function Chrome({ it, z, editing }: { it: Item; z: number; editing: boolean }) {
  const btn = 30 / z, off = 34 / z
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2
  const plus = it.kind === 'box' && !it.attach && !editing
  const at: Record<string, Pt> = { up: { x: cx, y: it.y - off }, down: { x: cx, y: it.y + it.h + off }, left: { x: it.x - off, y: cy }, right: { x: it.x + it.w + off, y: cy } }
  return (
    <>
      {plus && (Object.keys(at) as (keyof typeof at)[]).map((d) => (
        <button key={d} className="it-plus" title="Add the next step" style={{ left: at[d].x - btn / 2, top: at[d].y - btn / 2, width: btn, height: btn, fontSize: 20 / z }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }} onClick={(e) => { e.stopPropagation(); addNext(it.id, d as 'up') }}>+</button>
      ))}
      {it.kind === 'image' && !editing && (
        <div className="it-ai" style={{ left: it.x, top: it.y - 12 / z, transform: `translateY(-100%) scale(${1 / z})` }}><AiButtons target={{ kind: 'item', id: it.id }} compact /></div>
      )}
      {(it.kind === 'image' || it.kind === 'video') && (
        <button className="it-note" style={{ left: it.x, top: it.y + it.h + 14 / z, fontSize: 13 / z, padding: `${5 / z}px ${10 / z}px`, borderRadius: 6 / z }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault() }} onClick={(e) => { e.stopPropagation(); addNote(it.id) }}>+ Note</button>
      )}
      {it.kind !== 'arrow' && !editing && (
        <div className="it-frame" style={{ left: it.x, top: it.y, width: it.w, height: it.h, rotate: it.rot ? `${it.rot}deg` : undefined }}>
          {turnable(it) && CORNERS.map((c) => (
            <div key={`r${c}`} className="it-rot" title="Drag to rotate (Shift: 15° steps)"
              style={{ width: 26 / z, height: 26 / z, left: c.includes('w') ? -26 / z : it.w, top: c.includes('n') ? -26 / z : it.h }}
              onPointerDown={(e) => press(e, it, { rotate: true })} />
          ))}
          {CORNERS.map((c) => (
            <div key={c} className={`it-grip g-${c}`} style={{ left: (c.includes('w') ? 0 : it.w) - 7 / z, top: (c.includes('n') ? 0 : it.h) - 7 / z, width: 14 / z, height: 14 / z, borderWidth: 2 / z }}
              onPointerDown={(e) => press(e, it, { resize: c })} />
          ))}
        </div>
      )}
    </>
  )
}

/** Sections go under the design frames; everything else is drawn by <ItemsTop> above them. */
export function ItemsBelow() {
  const items = useStore((s) => s.items)
  const isel = useStore((s) => s.isel)
  const iedit = useStore((s) => s.iedit)
  const board = useStore((s) => s.board)
  const z = useStore((s) => s.view.z)
  const list = Object.values(items).filter((i) => i.kind === 'section').sort((a, b) => b.w * b.h - a.w * a.h)
  return <>{list.map((it) => <ItemView key={it.id} it={it} on={isel.includes(it.id)} edit={iedit?.id === it.id} board={board} z={z} />)}</>
}
export function ItemsTop() {
  const items = useStore((s) => s.items)
  const isel = useStore((s) => s.isel)
  const iedit = useStore((s) => s.iedit)
  const board = useStore((s) => s.board)
  const z = useStore((s) => s.view.z)
  const all = Object.values(items)
  const arrows = all.filter((i) => i.kind === 'arrow')
  const rest = all.filter((i) => i.kind !== 'arrow' && i.kind !== 'section')
  // while a picture is being expanded only its expand handles show: the resize grips would sit right on top of them
  const expanding = useAi((s) => !!s.expand || !!s.crop)
  const one = isel.length === 1 && !expanding ? items[isel[0]] : null
  // a click on the bare canvas ends typing (the canvas blurs whatever has focus)
  useEffect(() => { if (iedit && !items[iedit.id]) set({ iedit: null }) }, [iedit, items])
  return (
    <>
      <Arrows items={arrows} z={z} sel={isel} />
      {rest.map((it) => <ItemView key={it.id} it={it} on={isel.includes(it.id)} edit={iedit?.id === it.id} seed={iedit?.id === it.id ? iedit.seed : undefined} board={board} z={z} />)}
      {one && one.kind !== 'section' && <Chrome it={one} z={z} editing={iedit?.id === one.id} />}
      {one && one.kind === 'section' && <Chrome it={one} z={z} editing={false} />}
    </>
  )
}
