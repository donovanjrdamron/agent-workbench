import { boxOf, elOf, isPage, rawBox } from '../dom'
import { rename } from '../commands'
import { commentOp } from '../net'
import { set, useStore } from '../store'
import type { Design } from '../../shared/types'
import type { Comment } from '../../shared/types'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function shortName(id: string): string {
  if (id.startsWith('loose/')) return id.slice(6).replace(/-\d+\.html$/i, '')
  const m = id.match(/([^/]+)\/index(-9x16)?\.html$/i)
  if (m) return m[1] + (m[2] ? ' · 9:16' : '')
  return id.replace(/\.html$/i, '').split('/').slice(-2).join('/')
}

/** What a design is called on the board: the name he gave it, else its file name. */
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
  const single = els.length === 1 ? clip(boxOf(sel.design!, els[0]), sel.design!) : null
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
              : (!d.loose || sel.design === id) && <div className={`frame-label${active ? ' active' : ''}`} data-label={id} title="Drag to move. Double-click to rename." style={{ left: sx(d.x), top: sy(d.y) - 22, maxWidth: Math.max(70, d.w * z) }}>{nameOf(d, id)}{d.dirty && !d.loose ? ' •' : ''}</div>}
            {hover?.design === id && sel.design !== id && <div className="hover-outline" style={box(d)} />}
            {drop?.to === id && <div className="drop-outline" style={box(d)} />}
            {sel.design === id && !sel.sids.length && (
              <div className="design-outline" style={box(d)}>
                {!editing && tool === 'move' && !isPage(id) && (d.loose ? HANDLES.map((h) => <div key={h} className={`handle h-${h}`} data-handle={h} />) : ['e', 's', 'se'].map((h) => <div key={h} className={`handle h-${h}`} data-fhandle={h} />))}
              </div>
            )}
          </div>
        )
      })}
      {drop && sel.design && els.map((el, i) => { const b = rawBox(sel.design!, el); return el.tagName === 'IMG' ? <img key={i} className="drag-ghost" src={(el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src} style={box(b)} alt="" /> : <div key={i} className="drag-ghost" style={box(b)} /> })}
      {hoverEl && <div className="hover-outline" style={box(clip(boxOf(hover!.design, hoverEl), hover!.design))} />}
      {els.length > 1 && els.map((el, i) => <div key={i} className="sel-outline" style={box(clip(boxOf(sel.design!, el), sel.design!))} />)}
      {single && (
        <div className="sel-box" style={box(single)}>
          {!editing && tool === 'move' && !isPage(sel.design!) && handles.map((h) => <div key={h} className={`handle h-${h}`} data-handle={h} />)}
          {!editing && <div className="size-badge">{Math.round(single.w)} × {Math.round(single.h)}</div>}
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
