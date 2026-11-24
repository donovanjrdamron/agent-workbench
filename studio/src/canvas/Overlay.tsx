import { boxOf, elOf, isPage, rawBox } from '../dom'
import { rename } from '../commands'
import { commentOp } from '../net'
import { set, useStore } from '../store'
import { useAi } from '../ai'
import { copyRef, frameRef } from '../refs'
import type { Design } from '../../shared/types'
import type { Comment } from '../../shared/types'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CORNERS = ['nw', 'ne', 'se', 'sw']
/** How far an element is turned with the `rotate` property (what the Rotate field and the corner drag set). */
export function rotOf(el: Element): number {
  const r = getComputedStyle(el).rotate
  return r && r !== 'none' ? parseFloat(r.split(' ').pop()!) || 0 : 0
}
/** The handle that sits where `h` would be once the box is turned `deg`: dragging it outwards always grows. */
const turned = (h: string, deg: number) => HANDLES[(HANDLES.indexOf(h) + Math.round(deg / 45) + 8) % 8]

export function shortName(id: string): string {
  if (id.startsWith('loose/')) return id.slice(6).replace(/-\d+\.html$/i, '')
  const m = id.match(/([^/]+)\/index(-9x16)?\.html$/i)
  if (m) return m[1] + (m[2] ? ' · 9:16' : '')
  return id.replace(/\.html$/i, '').split('/').slice(-2).join('/')
}

/** What a design is called on the board: the name the user gave it, else its file name. */
export const nameOf = (d: Design | undefined, id: string) => d?.title || shortName(id)

function Pin({ c, index }: { c: Comment; index: number }) {
  const d = useStore((s) => s.designs[c.design])
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openComment === c.id)
  if (!d) return null
  const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onDoubleClick: (e: React.MouseEvent) => e.stopPropagation() }
  return (
    <div className={`pin${c.resolved ? ' resolved' : ''}${open ? ' open' : ''}${c.author === 'agent' ? ' agent' : ''}`} style={{ left: (d.x + c.x) * view.z + view.x, top: (d.y + c.y) * view.z + view.y }}>
      <button className="pin-dot" title={c.text || 'Comment'} onPointerDown={(e) => { e.stopPropagation(); set({ openComment: open ? null : c.id }) }}>{c.author === 'agent' ? 'AI' : index + 1}</button>
      {open && (
        <div className="bubble" {...stop}>
          <p className="hint">On {c.target || 'the design'}</p>
          <textarea autoFocus={!c.text} defaultValue={c.text} placeholder="Tell the agent what to change here…" rows={3}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== c.text) commentOp({ design: c.design, update: { id: c.id, text: v } }) }} />
          {c.replies.map((r, i) => <p key={i} className={`reply ${r.by}`}><b>{r.by === 'agent' ? 'Agent' : 'You'}</b> {r.text}</p>)}
          <input className="reply-input" placeholder="Reply…" onKeyDown={(e) => { const el = e.target as HTMLInputElement; if (e.key === 'Enter' && el.value.trim()) { commentOp({ design: c.design, update: { id: c.id }, reply: { by: 'user', text: el.value.trim() } }); el.value = '' } }} />
          <div className="row">
            <button className="link" onClick={() => commentOp({ design: c.design, update: { id: c.id, resolved: !c.resolved } })}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
            <button className="link danger" onClick={() => { commentOp({ remove: c.id }); set({ openComment: null }) }}>Delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function Overlay() {
  const designs = useStore((s) => s.designs)
  const order = useStore((s) => s.order)
  const sel = useStore((s) => s.sel)
  const hover = useStore((s) => s.hover)
  const view = useStore((s) => s.view)
  const guides = useStore((s) => s.guides)
  const marquee = useStore((s) => s.marquee)
  const editing = useStore((s) => s.editing)
  const tool = useStore((s) => s.tool)
  const comments = useStore((s) => s.comments)
  const renaming = useStore((s) => s.renaming)
  const drop = useStore((s) => s.drop)
  const dsel = useStore((s) => s.dsel)
  const expanding = useAi((s) => !!s.expand || !!s.crop)
  useStore((s) => s.tick)
  const z = view.z
  const sx = (x: number) => x * z + view.x
  const sy = (y: number) => y * z + view.y
  const box = (b: { x: number; y: number; w: number; h: number }) => ({ left: sx(b.x), top: sy(b.y), width: b.w * z, height: b.h * z })

  const els = sel.design ? sel.sids.map((s) => elOf(sel.design, s)).filter(Boolean) as HTMLElement[] : []
  const hoverEl = hover && hover.sid != null && !(hover.design === sel.design && sel.sids.includes(hover.sid)) ? elOf(hover.design, hover.sid) : null
  // an ad clips whatever hangs over its edge, so the box should stop there too
  const clip = (b: { x: number; y: number; w: number; h: number }, id: string) => {
    const d = designs[id]
    if (!d || isPage(id)) return b
    const x0 = Math.max(b.x, d.x), y0 = Math.max(b.y, d.y), x1 = Math.min(b.x + b.w, d.x + d.w), y1 = Math.min(b.y + b.h, d.y + d.h)
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : b
  }
  // trimmed to the frame, unless most of the piece is outside it: then the whole box shows, so it can be grabbed and dragged back in
  const single = els.length === 1 ? (() => { const raw = rawBox(sel.design!, els[0]), c = clip(boxOf(sel.design!, els[0]), sel.design!); return c.w * c.h < raw.w * raw.h * 0.5 ? raw : c })() : null
  // a turned piece gets a turned box, the size of the piece itself, as in Figma
  const rot = els.length === 1 ? rotOf(els[0]) : 0
  const tilt = (() => {
    if (!single || !rot) return null
    const a = rawBox(sel.design!, els[0]), w = els[0].offsetWidth || a.w, h = els[0].offsetHeight || a.h
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2
    return { left: sx(cx - w / 2), top: sy(cy - h / 2), width: w * z, height: h * z, rotate: `${rot}deg`, w, h }
  })()
  const turnOk = !editing && !expanding && tool === 'move'
  // On a thin or tiny box the handles would cover all of it, and every drag would resize instead of move. Leave the
  // middle free: no side handles along a short side, and one corner only when both sides are short.
  const thinW = !!single && single.w * z < 16, thinH = !!single && single.h * z < 16
  const handles = thinW && thinH ? ['se'] : HANDLES.filter((h) => !(thinH && (h === 'n' || h === 's')) && !(thinW && (h === 'e' || h === 'w')))

  return (
    <div className="overlay">
      {order.map((id) => {
        const d = designs[id]
        if (!d) return null
        const active = sel.design === id || hover?.design === id
        return (
          <div key={id}>
            {renaming === id
              ? <input className="frame-label editing" autoFocus defaultValue={nameOf(d, id)} style={{ left: sx(d.x), top: sy(d.y) - 24 }}
                  onFocus={(e) => e.currentTarget.select()} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = nameOf(d, id); e.currentTarget.blur() } }}
                  onBlur={(e) => rename(id, e.currentTarget.value)} />
              : (!d.loose || sel.design === id || dsel.includes(id)) && <div className={`frame-label${active || dsel.includes(id) ? ' active' : ''}`} data-label={id} title="Drag to move. Double-click to rename." style={{ left: sx(d.x), top: sy(d.y) - 22, maxWidth: Math.max(70, d.w * z - 24) }}>{nameOf(d, id)}{d.dirty && !d.loose ? ' •' : ''}</div>}
            {renaming !== id && (!d.loose || sel.design === id || dsel.includes(id)) && d.w * z > 48 && (
              <button className={`frame-copy${active || dsel.includes(id) ? ' active' : ''}`} title="Copy this frame for the AI (its name and file path)" style={{ left: sx(d.x) + d.w * z - 18, top: sy(d.y) - 21 }}
                onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); copyRef(frameRef(id)) }}>
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" /></svg>
              </button>
            )}
            {hover?.design === id && sel.design !== id && <div className="hover-outline" style={box(d)} />}
            {drop?.to === id && <div className="drop-outline" style={box(d)} />}
            {dsel.includes(id) && <div className="design-outline" style={box(d)} />}
            {sel.design === id && !sel.sids.length && (
              <div className="design-outline" style={box(d)}>
                {!editing && tool === 'move' && !isPage(id) && d.loose && CORNERS.map((c) => <div key={`r${c}`} className={`rot r-${c}`} data-rotate={c} title="Drag to rotate (Shift: 15° steps)" />)}
                {!editing && tool === 'move' && !isPage(id) && (d.loose ? HANDLES.map((h) => <div key={h} className={`handle h-${h}`} data-handle={h} />) : ['e', 's', 'se'].map((h) => <div key={h} className={`handle h-${h}`} data-fhandle={h} />))}
              </div>
            )}
          </div>
        )
      })}
      {drop && sel.design && els.map((el, i) => { const b = rawBox(sel.design!, el); return el.tagName === 'IMG' ? <img key={i} className="drag-ghost" src={(el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src} style={box(b)} alt="" /> : <div key={i} className="drag-ghost" style={box(b)} /> })}
      {hoverEl && <div className="hover-outline" style={box(clip(boxOf(hover!.design, hoverEl), hover!.design))} />}
      {els.length > 1 && els.map((el, i) => <div key={i} className="sel-outline" style={box(clip(boxOf(sel.design!, el), sel.design!))} />)}
      {single && !expanding && (
        <div className="sel-box" style={tilt ? { left: tilt.left, top: tilt.top, width: tilt.width, height: tilt.height, rotate: tilt.rotate } : box(single)}>
          {turnOk && CORNERS.map((c) => <div key={`r${c}`} className={`rot r-${c}`} data-rotate={c} title="Drag to rotate (Shift: 15° steps)" />)}
          {turnOk && handles.map((h) => <div key={h} className={`handle h-${h}`} data-handle={turned(h, rot)} />)}
          {!editing && <div className="size-badge" style={rot ? { rotate: `${-rot}deg` } : undefined}>{Math.round(tilt ? tilt.w : single.w)} × {Math.round(tilt ? tilt.h : single.h)}{rot ? ` · ${Math.round(rot * 10) / 10}°` : ''}</div>}
        </div>
      )}
      {guides.map((g, i) => g.axis === 'x'
        ? <div key={i} className="guide" style={{ left: sx(g.pos), top: sy(g.from), width: 1, height: (g.to - g.from) * z }} />
        : <div key={i} className="guide" style={{ left: sx(g.from), top: sy(g.pos), height: 1, width: (g.to - g.from) * z }} />)}
      {marquee && <div className="marquee" style={box(marquee)} />}
      {comments.map((c, i) => <Pin key={c.id} c={c} index={i} />)}
    </div>
  )
}
