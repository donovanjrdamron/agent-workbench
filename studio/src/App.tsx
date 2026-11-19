import { useEffect, useRef, useState } from 'react'
import { Canvas } from './canvas/Canvas'
import { fitAll, placeBelow, tidy } from './commands'
import { connect, refreshBoards } from './net'
import { Left } from './panels/Left'
import { Props } from './panels/Props'
import { Toolbar } from './panels/Toolbar'
import { AgentPanel } from './panels/Agent'
import { get, useStore } from './store'

export function Editor() {
  const board = useStore((s) => s.board)
  const count = useStore((s) => s.order.length)
  const boards = useStore((s) => s.boards)
  const connected = useStore((s) => s.connected)
  const toastMsg = useStore((s) => s.toast)
  const asking = useStore((s) => s.ask)
  const [fitted, setFitted] = useState('')
  const [ready, setReady] = useState(false)
  const known = useRef<{ board: string; ids: Set<string> } | null>(null)

  useEffect(() => {
    (async () => {
      const list = await refreshBoards()
      const want = new URLSearchParams(location.search).get('board')
      const pick = list.find((b) => b.name === want) || list[list.length - 1]
      if (pick) connect(pick.name)
      setReady(true)
    })()
  }, [])
  useEffect(() => { if (board && count && fitted !== board) { setFitted(board); requestAnimationFrame(fitAll) } }, [board, count, fitted])
  // Once real sizes are known, untangle frames that ended up on top of each other. Never ones they arranged himself:
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
        {board ? <Canvas /> : <div className="loading">{ready && !boards.length ? 'No boards yet. Click + (top left) and point it at a folder of HTML designs.' : 'Loading…'}</div>}
        <Toolbar />
        {board && <AgentPanel />}
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
