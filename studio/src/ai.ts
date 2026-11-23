// Image tools on a picture: remove background (on this Mac), edit / expand / erase / upscale (Higgsfield, on the plan's credits).
// Works on a planning picture on the board and on an <img> inside an ad. The result replaces the picture and is
// one undo step; the original file stays in studio-assets/.
import { create } from 'zustand'
import { setAttr, style } from './commands'
import { elOf } from './dom'
import { itemOp } from './net'
import { get, toast } from './store'

export type Tool = 'removebg' | 'edit' | 'expand' | 'erase' | 'upscale'
export type Target = { kind: 'item'; id: string } | { kind: 'el'; design: string; sid: number }

/** The dialog for the tools that need more than a click, and which pictures are being worked on. */
export interface Expanding { target: Target; img: HTMLImageElement; from: { x: number; y: number; w: number; h: number }; box: { x: number; y: number; w: number; h: number }; k: number; running: boolean; status?: string }
export const useAi = create<{ open: { tool: 'edit' | 'expand' | 'erase'; target: Target } | null; busy: Record<string, string>; model: string; expand: Expanding | null; crop: import('./canvas/Crop').Cropping | null }>(() => ({ open: null, busy: {}, model: 'gpt_image_2_6', expand: null, crop: null }))
export const MODELS = [{ id: 'gpt_image_2_6', name: 'GPT Image 2.6', note: 'best at keeping labels and text' }, { id: 'nano_banana_pro', name: 'Nano Banana Pro', note: 'Google' }, { id: 'flux_3_image', name: 'FLUX 3', note: 'Black Forest Labs' }]
const keyOf = (t: Target) => (t.kind === 'item' ? t.id : `${t.design}#${t.sid}`)
export const busyText = (t: Target) => useAi.getState().busy[keyOf(t)]

/** The picture's address as the page loads it. */
export function urlOf(t: Target): string | null {
  const s = get()
  if (t.kind === 'item') {
    const it = s.items[t.id]
    return it?.src ? `/b/${encodeURIComponent(s.board)}/${it.src.split('/').map(encodeURIComponent).join('/')}` : null
  }
  const el = elOf(t.design, t.sid) as HTMLImageElement | null
  return el ? el.currentSrc || el.src : null
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the picture')); i.src = url })
}
async function dataUrlOf(url: string) {
  const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error('Could not read the picture'); return r.blob() })
  return new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob) })
}

export const RATIOS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '21:9']
const ratio = (r: string) => { const [a, b] = r.split(':').map(Number); return a / b }
/** The canvas an expand starts from: the picture in the middle of the new shape, grey around it. */
export function expandBox(w: number, h: number, r: string) {
  const k = ratio(r)
  let W = w, H = h
  if (w / h < k) W = Math.round(h * k); else H = Math.round(w / k)
  const s = Math.min(1, 2048 / Math.max(W, H)) // Higgsfield works at about 2k anyway
  return { W: Math.round(W * s), H: Math.round(H * s), x: Math.round(((W - w) / 2) * s), y: Math.round(((H - h) / 2) * s), w: Math.round(w * s), h: Math.round(h * s) }
}

export interface RunOpts { prompt?: string; aspect?: string; marked?: string; model?: string }

/** Run a tool and put the result in place of the picture. */
export async function runTool(tool: Tool, target: Target, opts: RunOpts = {}) {
  const key = keyOf(target)
  if (useAi.getState().busy[key]) { toast('That picture is already being worked on.'); return }
  const url = urlOf(target)
  if (!url) { toast('Select a picture first.'); return }
  const label = { removebg: 'Removing the background', edit: 'Editing', expand: 'Expanding', erase: 'Erasing', upscale: 'Upscaling' }[tool]
  const say = (text: string) => { useAi.setState((s) => ({ busy: { ...s.busy, [key]: text } })); toast(text) }
  const job = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const off = onProgress(job, (t) => say(`${label}: ${t}`))
  say(`${label}…`)
  try {
    const img = await loadImage(url)
    const image = await dataUrlOf(url)
    const s = get()
    const r = await fetch('/api/ai', { method: 'POST', body: JSON.stringify({ board: s.board, design: target.kind === 'el' ? target.design : undefined, op: tool, image, marked: opts.marked, prompt: opts.prompt, aspect: tool === 'expand' ? opts.aspect : undefined, model: opts.model, job }) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Studio is not answering' }))
    if (r.error === 'NOT_CONNECTED') {
      window.open('/oauth/higgsfield/start', 'higgsfield-signin', 'width=520,height=720')
      throw new Error('Sign in to Higgsfield in the window that opened (your plan pays for it), then try again.')
    }
    if (!r.ok) throw new Error(r.error || 'It did not work')
    place(target, r, img, tool === 'expand')
    toast(`${{ removebg: 'Background removed', edit: 'Edited', expand: 'Expanded', erase: 'Erased', upscale: 'Upscaled' }[tool]}. ⌘Z puts the old picture back.`)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    off()
    useAi.setState((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b } })
  }
}

/** Swap the result in: same place, same width; an expanded picture grows around its old middle (the old part keeps its size). */
function place(t: Target, r: { path: string; src: string; w: number; h: number }, img: HTMLImageElement, expanded: boolean) {
  const R = r.w / r.h, was = img.naturalWidth / img.naturalHeight
  const grow = expanded ? Math.max(1, R / was) : 1 // wider: the height stays; taller: the width stays
  const box = expanded ? { W: grow, w: 1 } : null
  if (t.kind === 'item') {
    const it = get().items[t.id]
    if (!it) return
    const w = Math.round(it.w * grow), h = Math.round(w / R)
    itemOp([{ ...it, src: r.path, x: Math.round(it.x + it.w / 2 - w / 2), y: Math.round(it.y + it.h / 2 - h / 2), w, h }])
    return
  }
  const el = elOf(t.design, t.sid) as HTMLImageElement | null
  if (!el) return
  setAttr(t.design, el, 'src', r.src)
  // an expanded picture has a new shape: keep its width, let the height follow (unless it fills a fixed box)
  const fit = getComputedStyle(el).objectFit
  if (box && el.style.height && fit !== 'cover' && fit !== 'contain') {
    const w = el.offsetWidth * (box.W / box.w)
    style(t.design, [el], { width: `${Math.round(w)}px`, height: `${Math.round((w * r.h) / r.w)}px` }, true)
  }
  void img
}

// progress lines the server sends over the board's socket while a job runs
const listeners = new Map<string, (t: string) => void>()
export function onProgress(job: string, fn: (t: string) => void) { listeners.set(job, fn); return () => listeners.delete(job) }
export function aiMessage(msg: { job?: string; text?: string }) { if (msg.job && msg.text) listeners.get(msg.job)?.(msg.text) }

export const openTool = (tool: 'edit' | 'expand' | 'erase', target: Target) => useAi.setState({ open: { tool, target } })
