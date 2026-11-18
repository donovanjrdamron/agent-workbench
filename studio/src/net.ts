import type { Board, Design, Edit } from '../shared/types'
import { markReloading, rememberSelection } from './dom'
import { bump, clientId, get, set, toast, useStore } from './store'

let ws: WebSocket | null = null
let current = ''
let resync = false // the socket has just (re)connected: the next board message says what was missed
const failed = new Set<string>() // designs showing edits that never reached the server

/** Never rejects. When the server cannot be reached the answer is { ok: false, offline: true }. */
const api = async (url: string, body?: unknown) => {
  try {
    const r = await fetch(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
    return await r.json()
  } catch { return { ok: false, offline: true, error: 'Studio is not answering' } }
}

/** Point a design's iframe at another version. Until that has loaded, sids from the old document cannot be trusted. */
const reloadTo = (loaded: Record<string, string>, id: string, rev: string) => { if (loaded[id] !== rev) markReloading(id); return { ...loaded, [id]: rev } }

export async function refreshBoards() {
  const r = await api('/api/boards')
  const boards: { name: string; root: string; exists: boolean }[] = r.boards || []
  set({ boards })
  return boards
}

function applyBoard(b: Board) {
  const s = get()
  const designs: Record<string, Design> = {}
  const loaded: Record<string, string> = {}
  const same = s.board === b.name
  for (const d of b.designs) {
    // after a reconnect: a design that changed while we were away (the agent saved, the server restarted) loads again
    const missed = same && resync && !!s.designs[d.id] && s.designs[d.id].rev !== d.rev
    if (missed) { rememberSelection(d.id); markReloading(d.id) }
    designs[d.id] = d
    loaded[d.id] = same && s.loaded[d.id] && !missed ? s.loaded[d.id] : d.rev
  }
  resync = false
  set({ board: b.name, root: b.root, designs, order: b.designs.map((d) => d.id), loaded, comments: b.comments, ...(same ? {} : { sel: { design: null, sids: [] }, hover: null, editing: null }) })
}

export function connect(board: string) {
  current = board
  if (ws) { ws.onclose = null; ws.close() }
  const sock = new WebSocket(`ws://${location.host}/ws?board=${encodeURIComponent(board)}&client=${clientId}`)
  ws = sock
  sock.onopen = () => {
    resync = true
    // edits that could not be sent are still showing in those designs: load what is really in the files
    const s = get()
    let loaded = s.loaded
    for (const id of failed) if (s.designs[id]) loaded = reloadTo(loaded, id, `${s.designs[id].rev}-r${Date.now()}`)
    failed.clear()
    set({ connected: true, loaded })
    sendPresence()
  }
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'board') applyBoard(msg.board)
    else if (msg.type === 'design') {
      const d: Design = msg.design
      const s = get()
      const mine = msg.origin === clientId && !msg.reload
      // someone else changed the file (the agent, an undo): elements may have shifted, so note what is selected by what it is
      const foreign = msg.origin !== clientId
      // An undo can bring the file back to the very version this iframe was loaded from, while the iframe still shows
      // the style changes made since (those never reload it). Same rev or not, it has to load again.
      const rev = foreign && msg.reload && s.loaded[d.id] === d.rev ? `${d.rev}-r${Date.now()}` : d.rev
      if (foreign && s.loaded[d.id] !== rev) rememberSelection(d.id)
      set({ designs: { ...s.designs, [d.id]: { ...d, x: s.designs[d.id]?.x ?? d.x, y: s.designs[d.id]?.y ?? d.y } }, ...(mine ? {} : { loaded: reloadTo(s.loaded, d.id, rev) }) })
    } else if (msg.type === 'comments') set({ comments: msg.comments })
    else if (msg.type === 'error') toast(msg.error)
  }
  sock.onclose = () => { set({ connected: false }); if (current === board) setTimeout(() => current === board && connect(board), 1000) }
  const url = new URL(location.href)
  url.searchParams.set('board', board)
  history.replaceState(null, '', url)
}

function sendPresence() {
  const s = get()
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'presence', design: s.sel.design, sids: s.sel.sids }))
}
let last = ''
useStore.subscribe((s) => { const k = s.sel.design + '|' + s.sel.sids.join(','); if (k !== last) { last = k; sendPresence() } })

// One write at a time per design, each carrying the rev the previous one produced.
const chains = new Map<string, Promise<unknown>>()
export function sendEdits(design: string, edits: Edit[]): Promise<{ ok: boolean; reload?: boolean; newSid?: number | null; error?: string; offline?: boolean; stale?: boolean }> {
  const shown = get().loaded[design]
  const run = async () => {
    const s = get()
    // Queued behind an edit that reloaded the design, or the agent saved meanwhile: these sids were read from a
    // document that is gone and may name other elements now. The rev below would be the new one, so the server
    // could not tell. Drop them.
    if (s.loaded[design] !== shown) return { ok: false, stale: true }
    const r = await api('/api/edit', { board: s.board, design, rev: s.designs[design]?.rev, edits, by: 'user', origin: clientId })
    if (r.offline) { failed.add(design); toast('Not saved: Studio is not answering. Your last change was dropped.'); return r }
    if (r.ok) {
      const cur = get()
      if (cur.designs[design]) set({ designs: { ...cur.designs, [design]: { ...cur.designs[design], rev: r.rev } }, ...(r.reload ? { loaded: reloadTo(cur.loaded, design, r.rev) } : {}) })
    } else {
      toast(r.error || 'Edit failed')
      const b = await api(`/api/board?board=${encodeURIComponent(s.board)}`)
      const d = ((b.designs || []) as Design[]).find((x) => x.id === design)
      if (d) { rememberSelection(design); set({ designs: { ...get().designs, [design]: d }, loaded: reloadTo(get().loaded, design, d.rev + '-r' + Date.now()) }) }
    }
    return r
  }
  const next = (chains.get(design) || Promise.resolve()).then(run, run)
  chains.set(design, next)
  return next
}
/** Resolves once every write queued so far (for this design, or for all) has been answered. */
export const settled = (design: string) => (chains.get(design) ?? Promise.resolve()).then(() => {}, () => {})
export const settledAll = () => Promise.all([...chains.values()].map((p) => p.then(() => {}, () => {})))

export const deleteDesign = (design: string) => api('/api/delete-design', { board: get().board, design, by: 'user' })
export const revertDesign = (design: string) => api('/api/revert', { board: get().board, design })
/** Pass `from` (the positions before the move) to make the move undoable. */
export const saveLayout = (designs: Partial<Design>[], from?: Partial<Design>[]) => api('/api/layout', { board: get().board, designs, from })
export const history_ = async (dir: 'undo' | 'redo') => {
  const r = await api(`/api/${dir}`, { board: get().board })
  if (!r.ok) { toast(r.error); return }
  toast(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${r.what || 'change'}`)
  // what was selected stays selected (the reload finds it again); only a step on another design moves the selection there
  const s = get()
  if (r.design && s.designs[r.design] && r.design !== s.sel.design) set({ sel: { design: r.design, sids: [] } })
  bump()
}
export const commentOp = (body: Record<string, unknown>) => api('/api/comments', { board: get().board, ...body })
export const newDesign = (name: string, size: string) => api('/api/new', { board: get().board, name, size })
export const addBoard = (name: string, root: string) => api('/api/boards', { name, root })
export const exportDesign = (design: string, scale: number, format: string) => api('/api/export', { board: get().board, design, scale, format })

export async function upload(design: string, file: Blob, name: string): Promise<string> {
  const r = await fetch(`/api/upload?board=${encodeURIComponent(get().board)}&design=${encodeURIComponent(design)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: file }).then((r) => r.json())
  if (!r.src) throw new Error(r.error || 'upload failed')
  return r.src
}
