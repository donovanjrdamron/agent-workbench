// Brand grade on a picture, from Studio itself: pick a brand preset, tweak it, see it live on the board,
// apply. The graded copy is a new file with no metadata and replaces the picture as one undo step.
import { create } from 'zustand'
import { loadImage, place, urlOf, type Target } from './ai'
import { elOf } from './dom'
import { get, toast } from './store'

export interface Grade {
  intensity: number; contrast: number; grain: number; vignette: number; halation: number
  reds: number; blues: number; greens: number
  shadow: [number, number, number]; mid: [number, number, number]; high: [number, number, number]
  grade?: boolean
}
interface S { target: Target | null; presets: Record<string, Grade>; preset: string; g: Grade | null; busy: boolean; previewing: boolean }
export const useGrade = create<S>(() => ({ target: null, presets: {}, preset: '', g: null, busy: false, previewing: false }))
const G = useGrade.getState, S = useGrade.setState

let source: { url: string; data: string; w: number; img: HTMLImageElement } | null = null
let shown: { el: HTMLImageElement; was: string } | null = null
let timer = 0, seq = 0

const imgEl = (t: Target): HTMLImageElement | null =>
  t.kind === 'item' ? document.querySelector<HTMLImageElement>(`[data-iid="${CSS.escape(t.id)}"] img`) : (elOf(t.design, t.sid) as HTMLImageElement | null)
function restore() { if (shown) { shown.el.src = shown.was; shown = null } }
async function dataUrl(url: string) {
  const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error('Could not read the picture'); return r.blob() })
  return new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob) })
}
const call = (p: string, body: object) => fetch(p, { method: 'POST', body: JSON.stringify({ board: get().board, ...body }) }).then((r) => r.json())

export async function openGrade(target: Target) {
  closeGrade()
  const url = urlOf(target)
  if (!url) { toast('Select a picture first.'); return }
  const r = await call('/api/grade-presets', {}).catch(() => null)
  const presets: Record<string, Grade> = r?.presets || {}
  const names = Object.keys(presets)
  if (!names.length) { toast('No grade presets found.'); return }
  // the board's own brand first (its name says which), else the one used last
  let last = ''; try { last = localStorage.getItem('gradePreset') || '' } catch { /* private window */ }
  const board = get().board.toLowerCase()
  const preset = names.find((n) => board.includes(n.toLowerCase().split(/[\s·]/)[0])) || (presets[last] ? last : names[0])
  S({ target, presets, preset, g: structuredClone(presets[preset]), busy: false })
  try {
    const img = await loadImage(url)
    source = { url, data: await dataUrl(url), w: img.naturalWidth, img }
    preview()
  } catch (e) { toast((e as Error).message); closeGrade() }
}

export function setGrade(patch: Partial<Grade>) { const g = G().g; if (!g) return; S({ g: { ...g, ...patch } }); preview() }
export function pickPreset(name: string) {
  const p = G().presets[name]; if (!p) return
  S({ preset: name, g: structuredClone(p) }); try { localStorage.setItem('gradePreset', name) } catch { /* private window */ }
  preview()
}

/** A quick, smaller grade of the picture shown in place on the board while you adjust (nothing is saved). */
function preview() {
  clearTimeout(timer)
  timer = window.setTimeout(async () => {
    const { target, g } = G()
    if (!target || !g || !source) return
    const n = ++seq
    S({ previewing: true })
    try {
      const r = await call('/api/grade-preview', { design: target.kind === 'el' ? target.design : undefined, image: source.data, grade: g, max: 1400, fullw: source.w })
      if (n !== seq || G().target !== target) return
      if (!r.ok) { toast(r.error || 'Preview failed'); return }
      const el = imgEl(target)
      if (el) { if (!shown || shown.el !== el) { restore(); shown = { el, was: el.getAttribute('src') || el.src } } el.src = r.url }
    } finally { if (n === seq) S({ previewing: false }) }
  }, 180)
}

export async function applyGrade() {
  const { target, g, preset } = G()
  if (!target || !g || !source || G().busy) return
  S({ busy: true })
  try {
    const r = await call('/api/grade', { design: target.kind === 'el' ? target.design : undefined, image: source.data, grade: g })
    if (!r.ok) throw new Error(r.error || 'The grade did not work')
    restore()
    place(target, r, source.img, false)
    try { localStorage.setItem('gradePreset', preset) } catch { /* private window */ }
    toast(`${g.grade === false ? 'Metadata removed' : `${preset} grade applied`}. ⌘Z puts the old picture back.`)
    S({ target: null, g: null }); source = null
  } catch (e) { toast((e as Error).message) } finally { S({ busy: false }) }
}

export async function savePreset(name: string) {
  const { g, presets } = G(); if (!g || !name.trim()) return
  const next = { ...presets, [name.trim()]: structuredClone(g) }
  const r = await call('/api/grade-presets', { presets: next }).catch(() => null)
  if (!r?.presets) { toast('Could not save the preset'); return }
  S({ presets: r.presets, preset: name.trim() }); toast(`Saved "${name.trim()}"`)
}
export async function deletePreset(name: string) {
  const { presets } = G(); const next = { ...presets }; delete next[name]
  if (!Object.keys(next).length) return
  const r = await call('/api/grade-presets', { presets: next }).catch(() => null)
  if (r?.presets) { const first = Object.keys(r.presets)[0]; S({ presets: r.presets }); pickPreset(first) }
}

export function closeGrade() { clearTimeout(timer); seq++; restore(); source = null; S({ target: null, g: null, busy: false, previewing: false }) }

/** Put a picture on the Mac's clipboard (as PNG, the one image type browsers can copy), to paste anywhere. */
export async function copyImage(target: Target) {
  const url = urlOf(target)
  if (!url) { toast('Select a picture first.'); return }
  try {
    const png = (async () => {
      const img = await loadImage(url)
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not copy the picture'))), 'image/png'))
    })()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]) // (the promise keeps the click's permission)
    toast('Image copied')
  } catch (e) { toast((e as Error).message || 'Could not copy the picture') }
}
