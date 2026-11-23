import { useState } from 'react'
import { finishEditing, focusDesign, moveLayer, paintOrder, selectFresh, sidAfter, tidy, toggleHidden } from '../commands'
import { elOf } from '../dom'
import { frames, isRoot, isTextLeaf, label, sidOf } from '../dom'
import { addBoard, connect, newDesign, refreshBoards } from '../net'
import { BoardMenu } from './BoardMenu'
import { get, select, set, toast, useStore } from '../store'
import { nameOf } from '../canvas/Overlay'
import { Icon } from '../ui'

const SKIP = new Set(['SCRIPT', 'STYLE', 'BR', 'LINK', 'META', 'TITLE', 'HEAD'])
const ICON: Record<string, string> = { IMG: 'image', svg: 'pen', P: 'text', H1: 'text', H2: 'text', H3: 'text', SPAN: 'text', EM: 'text', B: 'text', A: 'text' }

let dragging: { design: string; sid: number } | null = null
/** Children as layers: the one painted in front comes first, like any layers panel. */
const layersOf = (parent: Element) => paintOrder(parent).filter((c) => !SKIP.has(c.tagName)).reverse()

function Row({ design, el, depth }: { design: string; el: HTMLElement; depth: number }) {
  const sid = sidOf(el)
  const [drop, setDrop] = useState<'above' | 'below' | null>(null)
  const selected = useStore((s) => s.sel.design === design && s.sel.sids.includes(sid))
  const hovered = useStore((s) => s.hover?.design === design && s.hover.sid === sid)
  const hidden = getComputedStyle(el).display === 'none'
  const kids = el.tagName === 'svg' ? [] : layersOf(el)
  // a block of copy is one layer: its inline tags (a struck price, restyled words) are part of the text, not pieces of their own
  const textish = !kids.length || isTextLeaf(el)
  return (
    <>
      <div
        className={`layer${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}${hidden ? ' dim' : ''}${drop ? ` drop-${drop}` : ''}`} style={{ paddingLeft: 10 + depth * 12 }}
        title="Drag up or down to change what sits in front"
        draggable
        onDragStart={(e) => { dragging = { design, sid }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(sid)) }}
        onDragEnd={() => { dragging = null; setDrop(null) }}
        onDragOver={(e) => {
          const from = dragging && dragging.design === design ? elOf(design, dragging.sid) : null
          if (!from || from === el || from.parentElement !== el.parentElement) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDrop(e.clientY < r.top + r.height / 2 ? 'above' : 'below')
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault()
          const from = dragging && dragging.design === design ? elOf(design, dragging.sid) : null
          if (from && drop) { moveLayer(design, from, el, drop === 'above' ? 'front' : 'behind'); select(design, [sidOf(from)]) }
          dragging = null; setDrop(null)
        }}
        onClick={(e) => {
          // ending a text edit renumbers the elements after it: this row's sid is from the document as it was
          const fin = get().editing ? finishEditing() : null
          const s = get().sel
          const add = e.shiftKey || e.metaKey
          if (add && s.design === design && s.sids.includes(sidAfter(fin, design, sid))) select(design, s.sids.filter((x) => x !== sidAfter(fin, design, sid)))
          else selectFresh(fin, design, el, add && s.design === design ? s.sids : [])
        }}
        onMouseEnter={() => set({ hover: { design, sid } })}
        onMouseLeave={() => set({ hover: null })}
      >
        <span className="layer-icon"><Icon name={ICON[el.tagName] || (textish && el.textContent?.trim() ? 'text' : 'rect')} size={13} /></span>
        <span className="layer-name">{label(el)}</span>
        <span className={`layer-actions${hidden ? ' keep' : ''}`}>
          <button title="Show / hide" className={hidden ? 'on' : ''} onClick={(e) => { e.stopPropagation(); toggleHidden(design, el) }}><Icon name={hidden ? 'eyeOff' : 'eye'} size={13} /></button>
        </span>
      </div>
      {!textish && kids.map((k) => <Row key={sidOf(k)} design={design} el={k} depth={depth + 1} />)}
    </>
  )
}

export function Left() {
  const board = useStore((s) => s.board)
  const boards = useStore((s) => s.boards)
  const order = useStore((s) => s.order)
  const active = useStore((s) => s.sel.design)
  const connected = useStore((s) => s.connected)
  const comments = useStore((s) => s.comments)
  const designs = useStore((s) => s.designs)
  useStore((s) => s.tick)
  const root = active ? frames.get(active)?.root : null
  const kids = root ? layersOf(root).filter((c) => !isRoot(active!, c)) : []

  const onNewBoard = async () => {
    const folder = prompt('Folder that holds the HTML designs (full path)')?.trim()
    if (!folder) return
    const name = prompt('Board name', folder.split('/').filter(Boolean).pop())?.trim()
    if (!name) return
    const r = await addBoard(name, folder)
    if (!r.ok) { toast(r.error); return }
    await refreshBoards()
    connect(name)
  }
  const onNewDesign = async () => {
    const name = prompt('Name for the new ad (folder name)')?.trim()
    if (!name) return
    const size = prompt('Size: 4x5, 9x16 or 1x1', '4x5')?.trim() || '4x5'
    const r = await newDesign(name, size)
    if (!r.ok) { toast(r.error); return }
    // show it: the frame lands in the first free slot, which on a big board is far outside the view
    for (let i = 0; i < 60 && !get().designs[r.design]; i++) await new Promise((res) => setTimeout(res, 100))
    if (get().designs[r.design]) focusDesign(r.design)
  }
  return (
    <aside className="panel left">
      <div className="file-bar">
        <span className={`dot${connected ? ' on' : ''}`} title={connected ? 'Live: agent edits to the files show up here' : 'Reconnecting'} />
        <BoardMenu />
        <button className="mini" title="Add a folder of HTML designs" onClick={onNewBoard}><Icon name="plus" size={14} /></button>
      </div>
      <div className="panel-head"><h4>Designs <span className="count">{order.length}</span></h4>
        <span className="row tight">
          <button className="mini" title="Tidy the canvas into rows" onClick={tidy}><Icon name="frame" size={13} /></button>
          <button className="mini" title="New blank ad" onClick={onNewDesign}><Icon name="plus" size={14} /></button>
        </span>
      </div>
      <div className="pages designs">
        {order.map((id) => {
          const open = comments.filter((c) => c.design === id && !c.resolved).length
          return <div key={id} className={`page-row${active === id ? ' active' : ''}`} title={designs[id]?.dirty ? `${id}  (has your hand edits)` : id} onClick={() => focusDesign(id)}><span className="layer-name">{nameOf(designs[id], id)}{designs[id]?.dirty && !designs[id]?.loose ? ' •' : ''}</span>{open > 0 && <span className="badge">{open}</span>}</div>
        })}
        {!order.length && <p className="empty">No HTML files in this folder yet. The agent's files appear here as soon as they are written.</p>}
      </div>
      <div className="panel-head"><h4>Layers</h4><span className="hint">front first · drag to reorder</span></div>
      <div className="layers" onClick={(e) => { if (e.target === e.currentTarget && active) select(active, []) }}>
        {active && kids.map((k) => <Row key={sidOf(k)} design={active} el={k} depth={0} />)}
        {!active && <p className="empty">Click a design to see what it is made of.</p>}
        {active && !root && <p className="empty">Zoom in on this design to load it.</p>}
      </div>
    </aside>
  )
}
