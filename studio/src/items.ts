// Planning objects on the board: step boxes chained with arrows, text, sections, pictures and videos with notes,
// links. They live in the board's state, not in any HTML file, so they never get in the way of a design.
import type { Item, ItemKind } from '../shared/types'
import { insert, local } from './commands'
import { isPage } from './dom'
import { commentOp, itemOp, saveLayout, uploadMedia } from './net'
import { get, set, toast, type Box } from './store'

export const BOX = { w: 420, h: 180 }
const GAP = 140
const NOTE = { w: 480, h: 150 }
export const newId = (k: string) => `${k[0]}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function viewCenter() {
  const s = get()
  return { x: (s.size.w / 2 - s.view.x) / s.view.z, y: (s.size.h / 2 - s.view.y) / s.view.z }
}
export function selectItems(ids: string[]) {
  set({ isel: ids, dsel: [], sel: { design: null, sids: [] }, openComment: null, ...(get().iedit && !ids.includes(get().iedit!.id) ? { iedit: null } : {}) })
}
export function startEdit(id: string, seed?: string) {
  selectItems([id])
  set({ iedit: { id, seed } })
}

export async function addItem(kind: ItemKind, box: Box, extra: Partial<Item> = {}, edit = false) {
  const it: Item = { id: newId(kind), kind, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), ...extra }
  itemOp([it])
  set({ tool: 'move' })
  if (edit) startEdit(it.id)
  else selectItems([it.id])
  return it
}
/** A step box centred on `p`. */
export const addStep = (p: { x: number; y: number }) => addItem('box', { x: p.x - BOX.w / 2, y: p.y - BOX.h / 2, ...BOX }, { text: '' }, true)
export const addText = (p: { x: number; y: number }) => addItem('text', { x: p.x, y: p.y - 30, w: 520, h: 60 }, { text: '' }, true)
export const addSection = (box: Box) => addItem('section', box, { text: `Section ${Object.values(get().items).filter((i) => i.kind === 'section').length + 1}` })

/** Box of anything an arrow can point at: an item or a design frame. */
export function boxFor(id: string): Box | null {
  const s = get()
  const it = s.items[id]
  if (it) return it
  const d = s.designs[id]
  return d ? { x: d.x, y: d.y, w: d.w, h: d.h } : null
}

/** The + on a side of a box: a new box next to it, joined by an arrow, ready to type in. */
export function addNext(fromId: string, dir: 'up' | 'down' | 'left' | 'right') {
  const s = get()
  const a = s.items[fromId]
  if (!a) return
  const w = a.kind === 'box' ? a.w : BOX.w, h = a.kind === 'box' ? a.h : BOX.h
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2
  let x = cx - w / 2, y = cy - h / 2
  if (dir === 'right') x = a.x + a.w + GAP
  if (dir === 'left') x = a.x - GAP - w
  if (dir === 'down') y = a.y + a.h + GAP
  if (dir === 'up') y = a.y - GAP - h
  // don't land on a box that is already there: keep stepping out the same way
  const boxes = Object.values(s.items).filter((i) => i.kind === 'box' || i.kind === 'text')
  const hit = (bx: number, by: number) => boxes.some((o) => bx < o.x + o.w && bx + w > o.x && by < o.y + o.h && by + h > o.y)
  for (let i = 0; i < 12 && hit(x, y); i++) { if (dir === 'right' || dir === 'left') y += h + 60; else x += w + 60 }
  const b: Item = { id: newId('box'), kind: 'box', x: Math.round(x), y: Math.round(y), w, h, text: '' }
  const arrow: Item = { id: newId('arrow'), kind: 'arrow', x: 0, y: 0, w: 0, h: 0, from: a.id, to: b.id }
  const put = [b, arrow, ...growSections(a, b)]
  itemOp(put)
  startEdit(b.id)
}

/** A section that holds `inside` grows to keep `add` in it too. */
function growSections(inside: Box, add: Box): Item[] {
  const cx = inside.x + inside.w / 2, cy = inside.y + inside.h / 2, pad = 60
  return Object.values(get().items).filter((s) => s.kind === 'section' && cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h).map((s) => {
    const x0 = Math.min(s.x, add.x - pad), y0 = Math.min(s.y, add.y - pad)
    const x1 = Math.max(s.x + s.w, add.x + add.w + pad), y1 = Math.max(s.y + s.h, add.y + add.h + pad)
    return { ...s, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }).filter((s, i, all) => { const o = get().items[s.id]; return o && (o.x !== s.x || o.y !== s.y || o.w !== s.w || o.h !== s.h) && all.indexOf(s) === i })
}

/** "+ Note" on a picture or video: a note just under it that travels with it. */
export function addNote(mediaId: string) {
  const m = get().items[mediaId]
  if (!m) return
  const below = Object.values(get().items).filter((i) => i.attach === mediaId).reduce((y, n) => Math.max(y, n.y + n.h), m.y + m.h)
  const n: Item = { id: newId('box'), kind: 'box', x: m.x, y: below + 24, w: Math.max(NOTE.w, m.w), h: NOTE.h, text: '', attach: mediaId, color: 'note' }
  itemOp([n])
  startEdit(n.id)
}

const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(f.name)
const isImage = (f: File) => f.type.startsWith('image/')
export const mediaFiles = (files: File[]) => files.filter((f) => isVideo(f) || isImage(f))

/** Pictures and videos dropped or picked onto the board (not into a design). */
export async function addMedia(files: File[], at: { x: number; y: number }) {
  let x = at.x, made: string[] = []
  for (const f of mediaFiles(files)) {
    try {
      toast(`Adding ${f.name || 'file'}…`)
      const src = await uploadMedia(f)
      const size = await naturalSize(f)
      const w = Math.min(isVideo(f) ? 720 : 800, size.w), h = Math.round((w * size.h) / size.w)
      const it: Item = { id: newId(isVideo(f) ? 'video' : 'image'), kind: isVideo(f) ? 'video' : 'image', x: Math.round(x - w / 2), y: Math.round(at.y - h / 2), w, h, src, text: f.name }
      await itemOp([it])
      made.push(it.id)
      x += w + 80
    } catch (e) { toast(`Could not add ${f.name}: ${(e as Error).message}`) }
  }
  if (made.length) { selectItems(made); set({ toast: null }) }
}
function naturalSize(f: File): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(f)
  return new Promise((res) => {
    const done = (w: number, h: number) => { URL.revokeObjectURL(url); res(w && h ? { w, h } : { w: 720, h: 405 }) }
    if (isVideo(f)) { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight); v.onerror = () => done(0, 0); v.src = url }
    else { const i = new Image(); i.onload = () => done(i.naturalWidth, i.naturalHeight); i.onerror = () => done(0, 0); i.src = url }
  })
}

export const looksLikeUrl = (t: string) => /^https?:\/\/\S+$/i.test(t.trim())
export function addLink(url: string, at = viewCenter()) {
  url = url.trim()
  let label = url
  try { const u = new URL(url); label = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '') } catch { /* keep the raw text */ }
  return addItem('link', { x: at.x - 260, y: at.y - 60, w: 520, h: 120 }, { url, text: label.slice(0, 80) })
}

/** What moves with a dragged item: notes tied to it, and for a section everything sitting in it. */
export function dragGroup(ids: string[]): { items: string[]; designs: string[] } {
  const s = get()
  const items = new Set(ids), designs = new Set<string>()
  const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const within = (b: Box, sec: Box) => { const c = center(b); return c.x >= sec.x && c.x <= sec.x + sec.w && c.y >= sec.y && c.y <= sec.y + sec.h }
  for (const id of ids) {
    const it = s.items[id]
    if (it?.kind !== 'section') continue
    for (const o of Object.values(s.items)) if (o.id !== id && o.kind !== 'arrow' && !o.attach && within(o, it) && !(o.kind === 'section' && o.w * o.h >= it.w * it.h)) items.add(o.id)
    for (const d of Object.values(s.designs)) if (within(d, it)) designs.add(d.id)
  }
  for (const o of Object.values(s.items)) if (o.attach && items.has(o.attach)) items.add(o.id)
  return { items: [...items], designs: [...designs] }
}
export function commitMove(items: string[], designs: string[], from: Record<string, { x: number; y: number }>) {
  const s = get()
  if (items.length) itemOp(items.map((i) => s.items[i]).filter(Boolean))
  if (designs.length) saveLayout(designs.map((id) => ({ id, x: s.designs[id].x, y: s.designs[id].y })), designs.map((id) => ({ id, ...from[id] })))
}

export function removeItems(ids: string[]) {
  const s = get()
  const gone = new Set(ids)
  for (const o of Object.values(s.items)) if ((o.attach && gone.has(o.attach)) || (o.kind === 'arrow' && (gone.has(o.from!) || gone.has(o.to!)))) gone.add(o.id)
  set({ isel: [], iedit: null })
  return itemOp([], [...gone])
}
export function nudgeItems(dx: number, dy: number) {
  const s = get()
  const g = dragGroup(s.isel.filter((i) => s.items[i]?.kind !== 'arrow'))
  const items = { ...s.items }
  for (const id of g.items) items[id] = { ...items[id], x: items[id].x + dx, y: items[id].y + dy }
  const from: Record<string, { x: number; y: number }> = {}
  const designs = { ...s.designs }
  for (const id of g.designs) { from[id] = { x: designs[id].x, y: designs[id].y }; designs[id] = { ...designs[id], x: designs[id].x + dx, y: designs[id].y + dy } }
  set({ items, designs })
  commitMove(g.items, g.designs, from)
}
export function duplicateItems() {
  const s = get()
  const src = s.isel.map((i) => s.items[i]).filter((i) => i && i.kind !== 'arrow' && i.kind !== 'section')
  const copies = src.map((i) => ({ ...i, id: newId(i.kind), x: i.x + 40, y: i.y + 40, attach: undefined }))
  if (copies.length) { itemOp(copies); selectItems(copies.map((c) => c.id)) }
}

/** A picture let go over an ad goes into that design as an <img>; the board copy goes. */
export async function dropIntoDesign(itemId: string, design: string, at: { x: number; y: number }) {
  const s = get()
  const it = s.items[itemId], d = s.designs[design]
  if (!it || it.kind !== 'image' || !it.src || !d || d.loose) return false
  const depth = design.split('/').length - 1
  const src = '../'.repeat(depth) + it.src
  const p = local(design, at)
  const w = Math.min(it.w, d.w)
  await insert(design, `<img src="${src}" style="position:absolute;left:${Math.round(p.x - w / 2)}px;top:${Math.round(p.y - (w * it.h) / it.w / 2)}px;width:${Math.round(w)}px">`)
  // its notes become comments on the ad, pinned where the picture landed
  for (const n of Object.values(get().items).filter((o) => o.attach === itemId && o.text?.trim())) await commentOp({ design, add: { x: Math.round(p.x), y: Math.round(p.y), text: n.text, target: 'the picture dropped here', author: 'user' } })
  await removeItems([itemId])
  return true
}

// ⌘C / ⌘X / ⌘V on planning objects. The clipboard gets a marker, so a paste knows the copy came from here and not a
// screenshot or a design piece copied since.
export const ITEM_MARK = 'studio-items:'
let clip: { items: Item[]; mark: string; n: number } | null = null
export function copyItems(cut = false) {
  const s = get()
  const ids = new Set(dragGroup(s.isel.filter((i) => s.items[i]?.kind !== 'arrow')).items)
  for (const o of Object.values(s.items)) if (o.kind === 'arrow' && ids.has(o.from!) && ids.has(o.to!)) ids.add(o.id) // arrows between copied things
  const items = [...ids].map((i) => s.items[i]).filter(Boolean)
  if (!items.length) return
  clip = { items: structuredClone(items), mark: ITEM_MARK + Date.now().toString(36), n: 0 }
  navigator.clipboard?.writeText(clip.mark).catch(() => { /* the in-page copy still works */ })
  if (cut) removeItems(s.isel)
  toast(`${cut ? 'Cut' : 'Copied'} ${items.filter((i) => i.kind !== 'arrow').length} thing${items.length === 1 ? '' : 's'}`)
}
export const hasItemClip = (text: string) => !!clip && (text === clip.mark || (!text && !!clip))
export function pasteItems() {
  if (!clip) return false
  clip.n++
  const off = 40 * clip.n
  const ids = new Map(clip.items.map((i) => [i.id, newId(i.kind)]))
  const copies = clip.items.map((i) => ({ ...i, id: ids.get(i.id)!, x: i.kind === 'arrow' ? 0 : i.x + off, y: i.kind === 'arrow' ? 0 : i.y + off,
    from: i.from && (ids.get(i.from) ?? i.from), to: i.to && (ids.get(i.to) ?? i.to), attach: i.attach && ids.get(i.attach) }))
  itemOp(copies)
  selectItems(copies.filter((c) => c.kind !== 'arrow' && !c.attach).map((c) => c.id))
  return true
}
/** Shift+H / Shift+V: mirror the selected pictures, videos and boxes. */
export function flipItems(axis: 'x' | 'y') {
  const s = get()
  const put = s.isel.map((i) => s.items[i]).filter((i) => i && i.kind !== 'arrow' && i.kind !== 'section').map((i) => axis === 'x' ? { ...i, fx: !i.fx || undefined } : { ...i, fy: !i.fy || undefined })
  if (put.length) itemOp(put)
}
export function selectAllItems() {
  selectItems(Object.values(get().items).filter((i) => i.kind !== 'arrow' && !i.attach).map((i) => i.id))
}
