import { clipText, copy, deleteSelection, duplicate, editSelected, finishEditing, fitAll, fitSelection, insertImages, nudge, paste, redo, selectParent, undo, undoStyle, zOrder, zoomTo } from './commands'
import { get, select, set, toast, type Tool } from './store'
import { addLink, addMedia, duplicateItems, looksLikeUrl, mediaFiles, nudgeItems, removeItems, selectItems, startEdit, viewCenter } from './items'

const TOOL_KEYS: Record<string, Tool> = { v: 'move', h: 'hand', f: 'frame', t: 'text', r: 'rect', o: 'ellipse', c: 'note', b: 'step', s: 'section' }
// Typing means a text field. A dropdown or colour swatch that still has focus after a choice must not swallow ⌘Z, ⌫ and the arrows.
const NOT_TEXT = new Set(['color', 'checkbox', 'radio', 'range', 'file', 'button', 'submit'])
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !NOT_TEXT.has((t as HTMLInputElement).type)))

/** Keys for selected planning objects. Runs before the design shortcuts and keeps them from acting on a design. */
function itemKeys(e: KeyboardEvent) {
  const s = get()
  if (typing(e.target) || s.ask || s.editing || !s.isel.length) return
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase()
  const one = s.isel.length === 1 ? s.items[s.isel[0]] : null
  const take = () => { e.preventDefault(); e.stopImmediatePropagation() }
  if (k === 'backspace' || k === 'delete') { if (!e.repeat) removeItems(s.isel); return take() }
  if (k === 'escape') { selectItems([]); return take() }
  if (k === 'enter' && one && one.kind !== 'arrow' && (one.kind === 'box' || one.kind === 'text' || one.kind === 'section')) { startEdit(one.id); return take() }
  if (k.startsWith('arrow') && !mod) { const d = e.shiftKey ? 50 : 10; nudgeItems(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0); return take() }
  if (mod && k === 'd') { duplicateItems(); return take() }
  if (mod && (k === 'c' || k === 'x')) return take() // design copy/cut must not act on a design that is not selected
  // just made a box (or picked an empty one) and started typing: the key goes into it
  if (!mod && !e.altKey && e.key.length === 1 && one && (one.kind === 'box' || one.kind === 'text') && !one.text) { startEdit(one.id, e.key); return take() }
}

export function installKeys() {
  window.addEventListener('keydown', itemKeys, true)
  const down = (e: KeyboardEvent) => {
    if (typing(e.target) && !get().ask) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return }
    const s = get()
    if (s.ask) { if (e.key === 'Escape') s.ask.resolve(false); return } // a question is open: nothing else fires
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    const done = () => e.preventDefault()
    // copy is being edited (focus may be on the panel): no shortcut may delete or move it. ⌘Z takes back the last restyle of the selected words.
    if (s.editing) { if (e.key === 'Escape') { finishEditing(); done() } else if (mod && k === 'z' && !e.shiftKey) { undoStyle(); done() } return }
    if (e.code === 'Space') { if (!s.space) set({ space: true }); return done() }
    if (mod && k === 'z') { e.shiftKey ? redo() : undo(); return done() }
    if (mod && k === 'c') { copy(); return done() }
    if (mod && k === 'x') { if (s.sel.sids.length) { copy(); deleteSelection() } return done() } // never the whole design
    if (mod && k === 'd') { duplicate(); return done() }
    if (mod && k === '0') { zoomTo(1); return done() }
    if (mod && (k === '=' || k === '+')) { zoomTo(s.view.z * 1.25); return done() }
    if (mod && k === '-') { zoomTo(s.view.z / 1.25); return done() }
    if (mod && k === ']') { zOrder('forward'); return done() }
    if (mod && k === '[') { zOrder('backward'); return done() }
    if (mod) return
    if (e.shiftKey && e.code === 'Digit1') { fitAll(); return done() }
    if (e.shiftKey && e.code === 'Digit2') { fitSelection(); return done() }
    if (k === ']') { zOrder('front'); return done() }
    if (k === '[') { zOrder('back'); return done() }
    if (k === '+' || k === '=') { zoomTo(s.view.z * 1.25); return done() }
    if (k === '-') { zoomTo(s.view.z / 1.25); return done() }
    if (k === 'backspace' || k === 'delete') { if (!e.repeat) deleteSelection(); return done() } // a held key deletes one thing, not the next and then the design
    if (k === 'escape') { if (s.openComment) set({ openComment: null }); else if (s.tool !== 'move') set({ tool: 'move' }); else if (s.sel.sids.length) selectParent(); else select(null); return done() }
    if (k === 'enter') { editSelected(); return done() }
    if (k.startsWith('arrow')) {
      const d = e.shiftKey ? 10 : 1
      nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0)
      return done()
    }
    if (!e.shiftKey && !e.altKey && TOOL_KEYS[k]) { set({ tool: TOOL_KEYS[k] }); return done() }
  }
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') set({ space: false }) })
  window.addEventListener('blur', () => set({ space: false }))
  const images = (dt: DataTransfer | null) => [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'))
  const toSelected = (files: File[]) => {
    const s = get()
    const d = s.sel.design ? s.designs[s.sel.design] : null
    if (d) insertImages(d.id, files, { x: d.x + d.w / 2, y: d.y + d.h / 2 })
    else insertImages(null, files, { x: (s.size.w / 2 - s.view.x) / s.view.z, y: (s.size.h / 2 - s.view.y) / s.view.z }) // nothing selected: onto the board, in the middle of the view
  }
  window.addEventListener('paste', (e) => {
    if (typing(e.target) || get().editing) return
    const files = images(e.clipboardData)
    e.preventDefault()
    const pasted = e.clipboardData?.getData('text/plain') || ''
    if (!files.length && looksLikeUrl(pasted) && !get().sel.sids.length) { addLink(pasted); return } // a link pasted onto the board
    if (files.length && !get().sel.design) { addMedia(mediaFiles(files), viewCenter()); return } // a screenshot pasted onto the bare board
    // an element copied here (⌘C) wins over a screenshot still sitting on the clipboard from earlier
    const text = e.clipboardData?.getData('text/plain') || ''
    if (files.length && !(text && text === clipText())) toSelected(files)
    else paste()
  })
  // A file dropped beside the canvas (on a panel, the toolbar) would make the browser open it in place of Studio.
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return // the canvas took it
    e.preventDefault()
    const files = images(e.dataTransfer)
    if (files.length) toSelected(files) // a near miss still lands the picture
  })
}
