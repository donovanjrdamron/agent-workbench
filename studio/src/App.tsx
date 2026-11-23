import { useEffect, useRef, useState } from 'react'
import { Canvas } from './canvas/Canvas'
import { fitAll, placeBelow, tidy, zoomToBox } from './commands'
import { connect, openBoard, refreshBoards } from './net'
import { Left } from './panels/Left'
import { Props } from './panels/Props'
import { Toolbar } from './panels/Toolbar'
import { AiDialog } from './panels/AiDialog'
import { ContextMenu } from './canvas/ContextMenu'
import { AgentPanel } from './panels/Agent'
import { get, useStore } from './store'
import { REVIEW } from './mode'
import { ReviewApp } from './review/Review'

/** On the phone (review mode) the board is for looking and commenting only. */
export function Editor() { return REVIEW ? <ReviewApp /> : <Desk /> }

function Desk() {
  const board = useStore((s) => s.board)
  const count = useStore((s) => s.order.length)
  const boards = useStore((s) => s.boards)
  const connected = useStore((s) => s.connected)
  const toastMsg = useStore((s) => s.toast)
  const asking = useStore((s) => s.ask)
  const [fitted, setFitted] = useState('')
  const [ready, setReady] = useState(false)
  const known = useRef<{ board: string; ids: Set<string> } | null>(null)
  // the browser tab names the board, so several Studio tabs can be told apart
  useEffect(() => { document.title = board ? `${board} · Studio` : 'Studio' }, [board])

  useEffect(() => {
    (async () => {
      const list = await refreshBoards()
      // a board merged into a permanent board: its old link opens the permanent one
      const asked = new URLSearchParams(location.search).get('board')
      const aliases: Record<string, string> = asked ? await fetch('/api/boards').then((r) => r.json()).then((j) => j.aliases || {}).catch(() => ({})) : {}
      const want = (asked && aliases[asked]) || asked
      if (want !== asked) { const u = new URL(location.href); u.searchParams.set('board', want!); history.replaceState(null, '', u) }
      // a link to a closed board reopens it; otherwise the newest open board
      const pick = list.find((b) => b.name === want) || list.filter((b) => !b.closed).pop()
      if (pick?.closed) await openBoard(pick.name)
      else if (pick) connect(pick.name)
      setReady(true)
    })()
  }, [])
  // ?focus=<folder>: a task on a permanent board opens on its own section
  useEffect(() => {
    if (!board || !count || fitted === board) return
    setFitted(board)
    requestAnimationFrame(() => {
      const focus = new URLSearchParams(location.search).get('focus')
      const sec = focus ? Object.values(get().items).find((i) => i.kind === 'section' && i.text === focus) : undefined
      if (sec) zoomToBox(sec); else fitAll()
    })
  }, [board, count, fitted])
  // Once real sizes are known, untangle frames that ended up on top of each other. Never ones the user arranged himself:
  // a board is only tidied as a whole while every frame still sits where the server first put it; after that, only
  // a design that has just arrived on top of another one is moved (below the rest).
  useEffect(() => {
    if (!board) return
    const t = setTimeout(() => {
      const s = get()
      const ds = Object.values(s.designs)
      const before = known.current?.board === board ? known.current.ids : null
      known.current = { board, ids: new Set(s.order) }
      if (before) { placeBelow(s.order.filter((id) => !before.has(id))); return }
      const clash = ds.some((a) => ds.some((b) => a !== b && a.x < b.x + b.w + 40 && a.x + a.w + 40 > b.x && a.y < b.y + b.h + 40 && a.y + a.h + 40 > b.y))
      if (clash && ds.every((d) => d.x % 1180 === 0 && d.y % 2120 === 0)) tidy() // (the server's first-placement grid)
    }, 3500)
    return () => clearTimeout(t)
  }, [board, count])

  return (
    <div className="app">
      <Left />
      <main className="stage">
        {board ? <Canvas /> : <div className="loading">{ready && !boards.length ? 'No boards yet. Click + (top left) and point it at a folder of HTML designs.' : ready && boards.every((b) => b.closed) ? 'Every board is closed. Reopen one under Closed boards (top left).' : 'Loading…'}</div>}
        <Toolbar />
        {board && <AgentPanel />}
        <AiDialog />
        <ContextMenu />
        {board && !connected && <div className="offline">Studio is not answering. Nothing you change is saved until it is back.</div>}
        {toastMsg && <div className="toast">{toastMsg}</div>}
        {asking && (
          <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) asking.resolve(false) }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h3>{asking.title}</h3>
              <p>{asking.body}</p>
              <div className="row">
                <button className="ghost" autoFocus onClick={() => asking.resolve(false)}>Cancel</button>
                <button className={asking.danger ? 'primary danger' : 'primary'} onClick={() => asking.resolve(true)}>{asking.ok}</button>
              </div>
            </div>
          </div>
        )}
      </main>
      <Props />
    </div>
  )
}
