// The board switcher: boards kept for good (pinned) on top, then every board in one list you can search, an X on each row that puts it away (no need to
// open it first), the closed ones underneath, and a preview of what is on a board when you hover it.
import { useEffect, useRef, useState } from 'react'
import { closeBoard, connect, openBoard, refreshBoards } from '../net'
import { get, set, toast, useStore } from '../store'
import { Icon } from '../ui'
import { keptBoards, setKept } from '../workboard'

interface Preview {
  name: string; root: string; closed: boolean; exists: boolean
  designCount: number; designs: { id: string; w: number; h: number }[]
  items: { kind: string; x: number; y: number; w: number; h: number; rot?: number; text: string; src?: string }[]
  comments: number; edited: number | null
}
const cache = new Map<string, Promise<Preview | null>>()
const previewOf = (name: string) => {
  let p = cache.get(name)
  if (!p) { p = fetch(`/api/preview?board=${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null); cache.set(name, p) }
  return p
}
const fileUrl = (board: string, rel: string) => `/p/${encodeURIComponent(board)}/${rel.split('/').map(encodeURIComponent).join('/')}`

function ago(t: number | null) {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'edited just now'
  if (m < 60) return `edited ${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `edited ${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `edited ${d}d ago` : `edited ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
function meta(p: Preview | null | undefined) {
  if (!p) return ''
  const notes = p.items.filter((i) => i.kind === 'box' || i.kind === 'text').length, media = p.items.filter((i) => i.kind === 'image' || i.kind === 'video').length
  return [p.designCount && `${p.designCount} design${p.designCount === 1 ? '' : 's'}`, notes && `${notes} note${notes === 1 ? '' : 's'}`, media && `${media} picture${media === 1 ? '' : 's'}`, ago(p.edited)].filter(Boolean).join(' · ')
}
/** The last two folders of where the board lives, which tells boards with similar names apart. */
const where = (root: string) => root.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-3, -1).join(' / ')

/** A design shown small: the real HTML, without its scripts. */
function Thumb({ board, d, w }: { board: string; d: Preview['designs'][number]; w: number }) {
  const k = w / d.w, h = Math.min(d.h * k, w * 1.8)
  return (
    <div className="bp-thumb" style={{ width: w, height: h }}>
      <iframe src={fileUrl(board, d.id)} sandbox="allow-same-origin" loading="lazy" tabIndex={-1} title={d.id}
        style={{ width: d.w, height: d.h, transform: `scale(${k})` }} />
    </div>
  )
}

/** The planning objects as a little map: sections, boxes with their words, the pictures themselves. */
function PlanMap({ board, items }: { board: string; items: Preview['items'] }) {
  if (!items.length) return null
  const x0 = Math.min(...items.map((i) => i.x)), y0 = Math.min(...items.map((i) => i.y))
  const x1 = Math.max(...items.map((i) => i.x + i.w)), y1 = Math.max(...items.map((i) => i.y + i.h))
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0)
  const fs = W / 34 // about 9px on the 300px wide map
  const sections = items.filter((i) => i.kind === 'section').sort((a, b) => b.w * b.h - a.w * a.h)
  const rest = items.filter((i) => i.kind !== 'section')
  return (
    <svg className="bp-map" viewBox={`${x0 - W * 0.02} ${y0 - W * 0.04} ${W * 1.04} ${H + W * 0.06}`} preserveAspectRatio="xMidYMin meet">
      {sections.map((s, i) => <g key={`s${i}`}><rect x={s.x} y={s.y} width={s.w} height={s.h} rx={W / 150} className="m-sec" /><text x={s.x} y={s.y - fs * 0.4} fontSize={fs * 1.1} className="m-title">{s.text}</text></g>)}
      {rest.map((it, i) => {
        const tr = it.rot ? `rotate(${it.rot} ${it.x + it.w / 2} ${it.y + it.h / 2})` : undefined
        if (it.kind === 'image' && it.src) return <image key={i} href={fileUrl(board, it.src)} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio="xMidYMid slice" transform={tr} />
        if (it.kind === 'video') return <g key={i} transform={tr}><rect x={it.x} y={it.y} width={it.w} height={it.h} className="m-vid" /><text x={it.x + it.w / 2} y={it.y + it.h / 2 + fs * 0.4} fontSize={fs * 1.4} textAnchor="middle" className="m-play">▶</text></g>
        const cls = it.kind === 'link' ? 'm-link' : it.kind === 'text' ? 'm-label' : 'm-box'
        const chars = Math.max(4, Math.floor((it.w / fs) * 1.7))
        return (
          <g key={i} transform={tr}>
            {it.kind !== 'text' && <rect x={it.x} y={it.y} width={it.w} height={it.h} rx={W / 200} className={cls} />}
            {it.text && <text x={it.kind === 'text' ? it.x : it.x + it.w / 2} y={it.y + Math.min(it.h / 2, fs * 1.6) + fs * 0.35} fontSize={fs} textAnchor={it.kind === 'text' ? 'start' : 'middle'} className={`${cls}-t`}>{it.text.length > chars ? it.text.slice(0, chars - 1) + '…' : it.text}</text>}
          </g>
        )
      })}
    </svg>
  )
}

function PreviewCard({ name, top, left }: { name: string; top: number; left: number }) {
  const [p, setP] = useState<Preview | null | undefined>(undefined)
  useEffect(() => { let live = true; setP(undefined); previewOf(name).then((r) => live && setP(r)); return () => { live = false } }, [name])
  const headings = p ? p.items.filter((i) => i.kind === 'section' && i.text).map((i) => i.text).slice(0, 6) : []
  return (
    <div className="bp-card" style={{ top: Math.max(8, Math.min(top, window.innerHeight - 460)), left }}>
      <div className="bp-name">{name}</div>
      {p === undefined && <div className="bp-empty">Loading preview…</div>}
      {p === null && <div className="bp-empty">No preview for this board.</div>}
      {p && <>
        <div className="bp-meta">{meta(p) || 'Empty board'}{p.comments ? ` · ${p.comments} open comment${p.comments === 1 ? '' : 's'}` : ''}</div>
        <div className="bp-where" title={p.root}>{where(p.root)}{!p.exists && ' · folder is missing'}</div>
        {headings.length > 0 && <div className="bp-tags">{headings.map((h, i) => <span key={i}>{h}</span>)}</div>}
        {p.items.length > 0 && <PlanMap board={name} items={p.items} />}
        {p.designs.length > 0 && (
          <div className="bp-grid">{p.designs.map((d) => <Thumb key={d.id} board={name} d={d} w={p.designs.length === 1 && !p.items.length ? 300 : 96} />)}</div>
        )}
        {p.designCount > p.designs.length && <div className="bp-more">+ {p.designCount - p.designs.length} more designs</div>}
        {!p.items.length && !p.designs.length && <div className="bp-empty">Nothing on this board yet.</div>}
      </>}
    </div>
  )
}

export function BoardMenu() {
  const board = useStore((s) => s.board)
  const boards = useStore((s) => s.boards)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hover, setHover] = useState<{ name: string; top: number } | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [metas, setMetas] = useState<Record<string, string>>({})
  const [kept, setKeptList] = useState<string[]>([])
  const menu = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    cache.clear() // fresh counts each time the menu opens
    refreshBoards()
    keptBoards().then(setKeptList)
    for (const b of get().boards) previewOf(b.name).then((p) => setMetas((m) => ({ ...m, [b.name]: meta(p) })))
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [open])
  useEffect(() => { if (!open) { setQ(''); setHover(null) } }, [open])

  const match = (n: string) => !q.trim() || q.toLowerCase().split(/\s+/).every((w) => n.toLowerCase().includes(w))
  const pinned = kept.map((k) => boards.find((b) => b.name === k)).filter((b): b is NonNullable<typeof b> => !!b && match(b.name))
  const live = boards.filter((b) => !b.closed && !kept.includes(b.name) && match(b.name)).reverse() // newest first
  const shut = boards.filter((b) => b.closed && b.name !== board && !kept.includes(b.name) && match(b.name)).reverse()
  const pin = async (name: string, keep: boolean) => {
    setKeptList((k) => (keep ? [...k.filter((x) => x !== name), name] : k.filter((x) => x !== name)))
    try { setKeptList(await setKept(name, keep)); toast(keep ? `Pinned "${name}". It stays at the top, and new agents can reuse it.` : `Unpinned "${name}".`) } catch { toast('The work board is not answering, so the pin was not saved.'); keptBoards().then(setKeptList) }
  }

  const choose = (name: string, closed?: boolean) => {
    setOpen(false)
    if (name === board) return
    if (closed) openBoard(name)
    else connect(name)
  }
  const shutOne = async (name: string) => {
    // the list changes at once; the server catches up (and a tab showing that board moves to another one)
    set({ boards: get().boards.map((b) => (b.name === name ? { ...b, closed: true } : b)) })
    cache.delete(name)
    const r = await closeBoard(name)
    if (!r.ok) { toast(r.error || 'Could not close the board'); refreshBoards(); return }
    if (name !== get().board) toast(`Closed "${name}". It is under Closed boards, one click reopens it.`)
  }
  const onRow = (name: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    const top = e.currentTarget.getBoundingClientRect().top
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover({ name, top }), hover ? 60 : 220)
  }
  const left = (menu.current?.getBoundingClientRect().right || 360) + 8

  // (a plain function, not a component: a row must not be remounted under the pointer each time the preview changes)
  const row = (name: string, closed?: boolean) => (
    <div key={name} className={`bm-row${name === board ? ' current' : ''}${closed ? ' closed' : ''}${hover?.name === name ? ' hot' : ''}`} onPointerEnter={onRow(name)} onClick={() => choose(name, closed)}>
      <div className="bm-text">
        <div className="bm-name">{name}</div>
        <div className="bm-meta">{name === board ? 'Open now' : closed ? 'Closed · click to reopen' : metas[name] || ' '}</div>
      </div>
      <button className={`bm-pin${kept.includes(name) ? ' on' : ''}`} title={kept.includes(name) ? 'Unpin' : 'Pin: keep this board at the top for good (ad creatives, a library...). New agents are told to reuse pinned boards.'}
        onClick={(e) => { e.stopPropagation(); pin(name, !kept.includes(name)) }}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill={kept.includes(name) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M9.8 1.8 14.2 6.2 12.6 6.9 10 9.5 10.3 12.4 9 13.7 6.6 11.3 3 14.9 1.1 13 4.7 9.4 2.3 7 3.6 5.7 6.5 6 9.1 3.4z" /></svg>
      </button>
      {!closed && !kept.includes(name) && (
        <button className="bm-x" title="Close this board. Nothing is deleted: it moves to Closed boards and reopens with one click."
          onClick={(e) => { e.stopPropagation(); shutOne(name) }}><Icon name="x" size={13} /></button>
      )}
    </div>
  )

  return (
    <>
      <button className="board-btn" title="Switch, find or close boards" onClick={() => setOpen(!open)}>
        <span className="board-btn-name">{board || 'Choose a board'}</span>
        <span className={`board-btn-caret${open ? ' up' : ''}`}><Icon name="chevron" size={11} /></span>
      </button>
      {open && <>
        <div className="bm-scrim" onPointerDown={() => setOpen(false)} />
        <div className="board-menu" ref={menu} onPointerLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }}>
          <input className="bm-search" autoFocus placeholder={`Find a board (${boards.length})`} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { const first = pinned[0] || live[0] || shut[0]; if (first) choose(first.name, first.closed) } }} />
          <div className="bm-list">
            {pinned.length > 0 && <div className="bm-head">Pinned <span>{pinned.length}</span></div>}
            {pinned.map((b) => row(b.name, b.closed))}
            {live.length > 0 && <div className="bm-head">Open boards <span>{live.length}</span></div>}
            {live.map((b) => row(b.name))}
            {shut.length > 0 && (
              <div className="bm-head toggle" onClick={() => setShowClosed(!showClosed)}>
                <span className={`twist${showClosed || q ? ' open' : ''}`}><Icon name="chevron" size={10} /></span>Closed boards <span>{shut.length}</span>
              </div>
            )}
            {(showClosed || q.trim()) && shut.map((b) => row(b.name, true))}
            {!pinned.length && !live.length && !shut.length && <div className="bm-none">No board matches "{q}".</div>}
          </div>
        </div>
        {hover && <PreviewCard name={hover.name} top={hover.top - 10} left={left} />}
      </>}
    </>
  )
}
