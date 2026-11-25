// Right-click menus, as in Figma: right-click selects what is under the pointer (keeping a selection it is part of)
// and offers everything you can do to it, with the shortcut beside each action.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { runTool, useAi } from '../ai'
import { addBoardComment, addComment, copy, copyFrames, createFrame, duplicateFrames, pasteFrames, removeDesigns, deleteSelection, duplicate, editSelected, fitAll, fitSelection, focusDesign, paste, removeDesign, revert, selectParent, style, tidy, toggleHidden, zOrder, zoomTo } from '../commands'
import { designAt, elOf, isPage, isTextLeaf, pick, piecesOf, sidOf } from '../dom'
import { addNote, addSection, addStep, addText, copyItems, duplicateItems, flipItems, pasteItems, removeItems, selectAllItems, selectItems, startEdit } from '../items'
import { exportDesign, itemOp } from '../net'
import { copyRef, elementRef, frameRef, itemRef } from '../refs'
import { get, select, set, toast } from '../store'
import { startExpand } from './Expand'
import { startCrop } from './Crop'
import { startSlicing } from './Slices'
import { copyImage, openGrade } from '../grade'
import { rotOf } from './Overlay'

type Entry = { label: string; keys?: string; run: () => void; disabled?: boolean; danger?: boolean } | 'sep'
export const useMenu = create<{ at: { x: number; y: number }; entries: Entry[] } | null>(() => null)

// Show the file in Finder: a picture (its src, relative to the design or the board) or a design's own HTML file
const reveal = (design: string, src?: string) =>
  fetch('/api/reveal-file', { method: 'POST', body: JSON.stringify({ board: get().board, design: design || undefined, src }) })
    .then((r) => r.json()).then((j) => { if (j.error) toast(j.error) }).catch(() => toast("Couldn't reach Studio"))
// every picture: grade it with a brand preset (live, adjustable), or copy it to paste anywhere
const picEntries = (t: Parameters<typeof openGrade>[0]): Entry[] => [{ label: 'Brand grade…', run: () => openGrade(t) }, { label: 'Copy image', run: () => copyImage(t) }, 'sep']
const revealEntry = (design: string, src?: string): Entry[] => [{ label: 'Reveal in Finder', run: () => reveal(design, src) }, 'sep']
const flipEls = (design: string, els: HTMLElement[], axis: 'x' | 'y') => {
  for (const el of els) {
    const sc = getComputedStyle(el).scale, [a, b] = sc && sc !== 'none' ? sc.split(' ').map(Number) : [1, 1]
    const fx = axis === 'x' ? -a : a, fy = axis === 'y' ? -(b ?? a) : (b ?? a)
    style(design, [el], { scale: fx === 1 && fy === 1 ? null : `${fx} ${fy}` }, true)
  }
}
const turnEls = (design: string, els: HTMLElement[]) => { for (const el of els) { const a = ((rotOf(el) + 90 + 180) % 360) - 180; style(design, [el], { rotate: a ? `${a}deg` : null }, true) } }
const aiEntries = (target: Parameters<typeof runTool>[1]): Entry[] => [
  { label: 'Crop', keys: 'double-click', run: () => startCrop(target) },
  'sep',
  { label: 'Remove background', run: () => runTool('removebg', target) },
  { label: 'Edit with AI…', run: () => useAi.setState({ open: { tool: 'edit', target } }) },
  { label: 'Expand (drag the edges)', run: () => startExpand(target) },
  { label: 'Erase…', run: () => useAi.setState({ open: { tool: 'erase', target } }) },
  { label: 'Upscale to 4K', run: () => runTool('upscale', target) },
]

function frameMenu(design: string, p: { x: number; y: number }): Entry[] {
  const d = get().designs[design]
  // a loose picture on the board: reveal the picture itself; any other frame: its HTML file
  const lone = d?.loose ? piecesOf(design) : []
  const under = pick(design, p, true) // (a big picture counts as the frame's background, but it is still the one you clicked)
  const picEl = lone.length === 1 && lone[0].tagName === 'IMG' ? lone[0] : under?.tagName === 'IMG' ? under : null
  const img = picEl?.getAttribute('src') || null
  return [
    ...(img ? [{ label: 'Reveal in Finder', run: () => reveal(design, img) } as Entry, { label: 'Reveal the HTML file', run: () => reveal(design) } as Entry, ...picEntries({ kind: 'el', design, sid: sidOf(picEl!) })] : revealEntry(design)),
    { label: 'Copy', keys: '⌘C', run: () => copyFrames([design]) },
    { label: 'Duplicate', keys: '⌘D', run: () => duplicateFrames([design]) },
    { label: 'Paste into frame', keys: '⌘V', run: () => paste() },
    'sep',
    { label: 'Copy link for AI', run: () => copyRef(frameRef(design)) },
    { label: 'Copy file path', run: () => copyRef(`${get().root}/${design}`) },
    { label: 'Select everything inside', keys: '⌘A', run: () => select(design, piecesOf(design).map(sidOf)), disabled: d?.loose },
    { label: 'Comment here', keys: 'C', run: () => addComment(design, p, null) },
    'sep',
    { label: 'Rename', run: () => set({ renaming: design }) },
    { label: 'Zoom to frame', keys: '⇧2', run: () => focusDesign(design) },
    { label: 'Export PNG (2x)', run: () => exportDesign(design, 2, 'png').then((r) => toast(r.ok === false ? r.error || 'Export failed' : `Exported${r.file ? ` to ${r.file}` : ''}`)) },
    { label: 'Export JPG (2x)', run: () => exportDesign(design, 2, 'jpg').then((r) => toast(r.ok === false ? r.error || 'Export failed' : `Exported${r.file ? ` to ${r.file}` : ''}`)) },
    { label: 'Slice for export…', run: () => startSlicing(design) },
    'sep',
    ...(d?.dirty ? [{ label: 'Revert my edits', run: () => revert(design) } as Entry] : []),
    { label: 'Delete design', keys: '⌫', danger: true, run: () => removeDesign(design) },
  ]
}

function framesMenu(ids: string[]): Entry[] {
  const n = ids.length
  return [
    { label: `Copy ${n} frames`, keys: '⌘C', run: () => copyFrames(ids) },
    { label: `Duplicate ${n} frames`, keys: '⌘D', run: () => duplicateFrames(ids) },
    { label: `Copy links for AI (${n})`, run: () => copyRef(ids.map(frameRef).join('\n')) },
    { label: 'Zoom to selection', keys: '⇧2', run: () => fitSelection() },
    { label: `Export ${n} as PNG (2x)`, run: async () => { toast(`Exporting ${n} designs…`); let ok = 0; for (const id of ids) if ((await exportDesign(id, 2, 'png')).ok !== false) ok++; toast(`Exported ${ok} of ${n}.`) } },
    'sep',
    { label: `Delete ${n} designs`, keys: '⌫', danger: true, run: () => removeDesigns(ids) },
  ]
}

function pieceMenu(design: string, els: HTMLElement[], p: { x: number; y: number }): Entry[] {
  const one = els.length === 1 ? els[0] : null
  return [
    ...(one?.tagName === 'IMG' && one.getAttribute('src') ? [{ label: 'Reveal in Finder', run: () => reveal(design, one.getAttribute('src')!) } as Entry, ...picEntries({ kind: 'el', design, sid: sidOf(one) })] : []),
    { label: 'Copy', keys: '⌘C', run: () => copy() },
    { label: 'Cut', keys: '⌘X', run: () => { copy(); deleteSelection() } },
    { label: 'Paste', keys: '⌘V', run: () => paste() },
    { label: 'Duplicate', keys: '⌘D', run: () => duplicate() },
    { label: 'Delete', keys: '⌫', danger: true, run: () => deleteSelection() },
    'sep',
    { label: 'Bring to front', keys: ']', run: () => zOrder('front') },
    { label: 'Bring forward', keys: '⌘]', run: () => zOrder('forward') },
    { label: 'Send backward', keys: '⌘[', run: () => zOrder('backward') },
    { label: 'Send to back', keys: '[', run: () => zOrder('back') },
    'sep',
    { label: 'Flip horizontal', keys: '⇧H', run: () => flipEls(design, els, 'x') },
    { label: 'Flip vertical', keys: '⇧V', run: () => flipEls(design, els, 'y') },
    { label: 'Rotate 90°', run: () => turnEls(design, els) },
    { label: 'Hide', run: () => els.forEach((el) => toggleHidden(design, el)) },
    'sep',
    ...(one && isTextLeaf(one) ? [{ label: 'Edit text', keys: 'Enter', run: () => editSelected() } as Entry] : []),
    { label: 'Select parent', keys: 'Esc', run: () => selectParent() },
    ...(one?.tagName === 'IMG' ? aiEntries({ kind: 'el', design, sid: sidOf(one) }) : []),
    'sep',
    { label: 'Copy link for AI', run: () => copyRef(els.map((el) => elementRef(design, el)).join('\n')) },
    { label: 'Comment here', keys: 'C', run: () => addComment(design, p, one) },
    { label: 'Zoom to selection', keys: '⇧2', run: () => fitSelection() },
  ]
}

function itemMenu(ids: string[]): Entry[] {
  const s = get()
  const one = ids.length === 1 ? s.items[ids[0]] : null
  const turnable = ids.map((i) => s.items[i]).filter((i) => i && i.kind !== 'arrow' && i.kind !== 'section')
  return [
    ...(one && (one.kind === 'image' || one.kind === 'video') && one.src ? [{ label: 'Reveal in Finder', run: () => reveal('', one.src!) } as Entry, ...(one.kind === 'image' ? picEntries({ kind: 'item', id: one.id }) : ['sep' as const])] : []),
    { label: 'Copy', keys: '⌘C', run: () => copyItems() },
    { label: 'Cut', keys: '⌘X', run: () => copyItems(true) },
    { label: 'Paste', keys: '⌘V', run: () => { if (!pasteItems()) toast('Nothing copied yet') } },
    { label: 'Duplicate', keys: '⌘D', run: () => duplicateItems() },
    { label: 'Delete', keys: '⌫', danger: true, run: () => removeItems(ids) },
    'sep',
    ...(one && (one.kind === 'box' || one.kind === 'text' || one.kind === 'section') ? [{ label: one.kind === 'section' ? 'Rename section' : 'Edit text', keys: 'Enter', run: () => startEdit(one.id) } as Entry] : []),
    ...(one && (one.kind === 'image' || one.kind === 'video') ? [{ label: 'Add note', run: () => addNote(one.id) } as Entry] : []),
    ...(one && one.kind !== 'arrow' ? [{ label: 'Comment here', keys: 'C', run: () => addBoardComment({ x: one.x + Math.min(one.w, 40), y: one.y + Math.min(one.h, 40) }) } as Entry] : []),
    ...(one?.kind === 'link' && one.url ? [{ label: 'Open link', run: () => window.open(one.url, '_blank', 'noopener') } as Entry] : []),
    { label: 'Flip horizontal', keys: '⇧H', run: () => flipItems('x'), disabled: !turnable.length },
    { label: 'Flip vertical', keys: '⇧V', run: () => flipItems('y'), disabled: !turnable.length },
    { label: 'Rotate 90°', run: () => itemOp(turnable.map((i) => ({ ...i, rot: ((((i.rot || 0) + 90 + 180) % 360) - 180) || undefined }))), disabled: !turnable.length },
    ...(one?.kind === 'image' ? aiEntries({ kind: 'item', id: one.id }) : []),
    'sep',
    { label: 'Copy link for AI', run: () => copyRef(ids.map(itemRef).filter(Boolean).join('\n')) },
    { label: 'Zoom to selection', keys: '⇧2', run: () => fitSelection() },
  ]
}

function boardMenu(p: { x: number; y: number }): Entry[] {
  return [
    { label: 'Paste here', keys: '⌘V', run: () => { pasteFrames().then((done) => { if (!done && !pasteItems()) paste() }) } },
    'sep',
    { label: 'Add step box here', keys: 'B', run: () => addStep(p) },
    { label: 'Add text here', run: () => addText(p) },
    { label: 'Add section here', keys: 'S', run: () => addSection({ x: p.x, y: p.y, w: 2400, h: 1400 }) },
    { label: 'New 4:5 ad here', keys: 'F', run: () => createFrame({ x: p.x, y: p.y, w: 1080, h: 1350 }) },
    'sep',
    { label: 'Select all planning', keys: '⌘A', run: () => selectAllItems() },
    { label: 'Tidy designs into rows', run: () => tidy() },
    { label: 'Zoom to fit', keys: '⇧1', run: () => fitAll() },
    { label: 'Zoom to 100%', keys: '⌘0', run: () => zoomTo(1) },
  ]
}

/** Right-click on the canvas: pick what is under the pointer the way a click would, then show its menu. */
export function openMenu(e: React.MouseEvent, p: { x: number; y: number }) {
  e.preventDefault()
  const s = get()
  if (s.editing || s.tool !== 'move') return
  const t = e.target as HTMLElement
  const iid = t.closest<HTMLElement>('[data-iid]')?.dataset.iid
  let entries: Entry[]
  if (iid && s.items[iid]) {
    const ids = s.isel.includes(iid) ? s.isel : [iid]
    if (ids !== s.isel) selectItems(ids)
    entries = itemMenu(ids)
  } else {
    const lab = t.closest<HTMLElement>('[data-label]')?.dataset.label
    const design = lab || designAt(p)
    if (design && s.dsel.length > 1 && s.dsel.includes(design)) entries = framesMenu(s.dsel)
    else if (!design) { entries = boardMenu(p) } else {
      // inside the frame that is already selected: the piece under the pointer (or the selection it belongs to)
      const el = !lab && s.sel.design === design ? pick(design, p, e.metaKey || e.ctrlKey) : null
      const cur = s.sel.design === design ? s.sel.sids.map((x) => elOf(design, x)).filter(Boolean) as HTMLElement[] : []
      const inSel = el ? cur.find((c) => c === el || c.contains(el)) : null
      if (el || inSel) {
        if (!inSel) select(design, [sidOf(el!)])
        const els = inSel ? cur : [el!]
        entries = pieceMenu(design, els, p)
      } else {
        if (s.sel.design !== design || s.sel.sids.length) select(design, [])
        entries = frameMenu(design, p)
      }
    }
  }
  // no separators at the ends or twice in a row
  entries = entries.filter((x, i, a) => x !== 'sep' || (i > 0 && i < a.length - 1 && a[i - 1] !== 'sep'))
  useMenu.setState({ at: { x: e.clientX, y: e.clientY }, entries })
}

export function ContextMenu() {
  const m = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!m || !ref.current) { setPos(null); return }
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.min(m.at.x, window.innerWidth - r.width - 8), y: Math.max(8, Math.min(m.at.y, window.innerHeight - r.height - 8)) })
  }, [m])
  useEffect(() => {
    if (!m) return
    const close = () => useMenu.setState(null, true)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close() } }
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', down, true); window.removeEventListener('wheel', close, true); window.removeEventListener('blur', close) }
  }, [m])
  if (!m) return null
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos?.x ?? m.at.x, top: pos?.y ?? m.at.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {m.entries.map((x, i) => x === 'sep' ? <div key={i} className="ctx-sep" /> : (
        <button key={i} className={`ctx-item${x.danger ? ' danger' : ''}`} disabled={x.disabled}
          onClick={() => { useMenu.setState(null, true); x.run() }}>
          <span>{x.label}</span>{x.keys && <span className="ctx-keys">{x.keys}</span>}
        </button>
      ))}
    </div>
  )
}
