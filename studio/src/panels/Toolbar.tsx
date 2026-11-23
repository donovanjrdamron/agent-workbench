import { fitAll, redo, undo, zoomTo } from '../commands'
import { set, useStore, type Tool } from '../store'
import { Icon } from '../ui'

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'move', icon: 'move', label: 'Move (V)' },
  { tool: 'hand', icon: 'hand', label: 'Hand (H)' },
  { tool: 'frame', icon: 'frame', label: 'Frame (F): drag anywhere to draw one' },
  { tool: 'section', icon: 'section', label: 'Section (S): drag to mark out part of the plan' },
  { tool: 'text', icon: 'text', label: 'Add text (T)' },
  { tool: 'rect', icon: 'rect', label: 'Add box (R)' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Add circle (O)' },
  { tool: 'note', icon: 'note', label: 'Comment for the agent (C)' },
]
const PLAN: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'step', icon: 'step', label: 'Step box (B): click to add, then use + to chain the next step' },
]

export function Toolbar() {
  const tool = useStore((s) => s.tool)
  const z = useStore((s) => s.view.z)
  const scaleMode = useStore((s) => s.scaleMode)
  return (
    <div className="toolbar">
      {TOOLS.map((t) => <button key={t.tool} className={tool === t.tool && !(t.tool === 'move' && scaleMode) ? 'active' : ''} title={t.label} onClick={() => set({ tool: t.tool, scaleMode: false })}><Icon name={t.icon} size={18} /></button>).flatMap((b, i) => i === 0 ? [b, <button key="scale" className={scaleMode ? 'active' : ''} title="Scale (K): drag a corner to scale anything like a picture: text, spacing, borders, everything inside" onClick={() => set({ tool: 'move', scaleMode: !scaleMode })}><Icon name="scale" size={18} /></button>] : [b])}
      <span className="sep" />
      {PLAN.map((t) => <button key={t.tool} className={tool === t.tool ? 'active' : ''} title={t.label} onClick={() => set({ tool: t.tool })}><Icon name={t.icon} size={18} /></button>)}
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
