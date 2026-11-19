import { useRef } from 'react'
import { fitAll, redo, undo, zoomTo } from '../commands'
import { addLink, addMedia, looksLikeUrl, viewCenter } from '../items'
import { set, useStore, type Tool } from '../store'
import { Icon } from '../ui'

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'move', icon: 'move', label: 'Move (V)' },
  { tool: 'hand', icon: 'hand', label: 'Hand (H)' },
  { tool: 'frame', icon: 'frame', label: 'Frame (F): drag anywhere to draw one' },
  { tool: 'text', icon: 'text', label: 'Add text (T)' },
  { tool: 'rect', icon: 'rect', label: 'Add box (R)' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Add circle (O)' },
  { tool: 'note', icon: 'note', label: 'Comment for the agent (C)' },
]
const PLAN: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'step', icon: 'step', label: 'Step box (B): click to add, then use + to chain the next step' },
  { tool: 'section', icon: 'section', label: 'Section (S): drag to mark out part of the plan' },
]

export function Toolbar() {
  const tool = useStore((s) => s.tool)
  const z = useStore((s) => s.view.z)
  const file = useRef<HTMLInputElement>(null)
  return (
    <div className="toolbar">
      {TOOLS.map((t) => <button key={t.tool} className={tool === t.tool ? 'active' : ''} title={t.label} onClick={() => set({ tool: t.tool })}><Icon name={t.icon} size={18} /></button>)}
      <span className="sep" />
      {PLAN.map((t) => <button key={t.tool} className={tool === t.tool ? 'active' : ''} title={t.label} onClick={() => set({ tool: t.tool })}><Icon name={t.icon} size={18} /></button>)}
      <button title="Add a video or picture to the plan (or drop one on the board)" onClick={() => file.current?.click()}><Icon name="media" size={18} /></button>
      <button title="Add a link (or paste one on the board)" onClick={() => { const u = prompt('Link'); if (u) addLink(looksLikeUrl(u) ? u : `https://${u.trim()}`) }}><Icon name="link" size={18} /></button>
      <input ref={file} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) addMedia(f, viewCenter()) }} />
      <span className="sep" />
      <button title="Undo (⌘Z)" onClick={undo}><Icon name="undo" size={18} /></button>
      <button title="Redo (⇧⌘Z)" onClick={redo}><Icon name="redo" size={18} /></button>
      <span className="sep" />
      <button title="Zoom out (−)" onClick={() => zoomTo(z / 1.25)}><Icon name="minus" size={16} /></button>
      <button className="zoom" title="Zoom to fit (⇧1)" onClick={fitAll}>{Math.round(z * 100)}%</button>
      <button title="Zoom in (+)" onClick={() => zoomTo(z * 1.25)}><Icon name="plus" size={16} /></button>
    </div>
  )
}
