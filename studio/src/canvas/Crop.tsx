// Crop, as in Figma: double-click a picture (or press Crop) and the whole picture shows dimmed behind a crop box.
// Drag the box's edges and corners in (Shift keeps the shape), drag the picture to slide it inside the box, then Enter,
// Done or a click elsewhere. The cut-away part is never lost: crop again later and you can pull the edges back out.
import { useEffect, useRef, useState } from 'react'
import { loadImage, useAi, type Target } from '../ai'
import { changeEl, mover, moveProps } from '../commands'
import { elOf, isPage, rawBox } from '../dom'
import { itemOp, upload, uploadMedia } from '../net'
import { get, set, toast, useStore, type Box } from '../store'

/** What part of the original picture is showing, in the original's own pixels. */
export interface CropRect { src: string; x: number; y: number; w: number; h: number }
export interface Cropping { target: Target; img: HTMLImageElement; orig: string; full: Box; box: Box; start: Box }

const MIN = 8 // smallest crop, in board units
const boardUrl = (path: string) => `/b/${encodeURIComponent(get().board)}/${path.split('/').map(encodeURIComponent).join('/')}`

function flipped(t: Target) {
  if (t.kind === 'item') { const it = get().items[t.id]; return !!(it?.rot || it?.fx || it?.fy) }
  const el = elOf(t.design, t.sid)
  if (!el) return false
  const cs = getComputedStyle(el)
  return (cs.rotate !== 'none' && !!parseFloat(cs.rotate)) || (cs.scale !== 'none' && cs.scale.split(' ').some((v) => parseFloat(v) < 0))
}

export function startCrop(target: Target) {
  const s = get()
  if (useAi.getState().expand || useAi.getState().crop) return
  if (flipped(target)) { toast('Straighten and unflip the picture first, then crop it.'); return }
  let box: Box, orig: string, url: string, prev: CropRect | null = null
  if (target.kind === 'item') {
    const it = s.items[target.id]
    if (!it?.src) return
    prev = it.crop || null
    orig = prev?.src || it.src
    url = boardUrl(orig)
    box = { x: it.x, y: it.y, w: it.w, h: it.h }
  } else {
    const el = elOf(target.design, target.sid) as HTMLImageElement | null
    if (!el || el.tagName !== 'IMG') return
    try { prev = JSON.parse(el.getAttribute('data-crop') || 'null') } catch { prev = null }
    orig = prev?.src || el.getAttribute('src') || ''
    url = new URL(orig, el.baseURI).href
    box = rawBox(target.design, el)
  }
  loadImage(url).then((img) => {
    const nw = img.naturalWidth, nh = img.naturalHeight
    const p = prev && prev.w > 0 && prev.h > 0 ? prev : { x: 0, y: 0, w: nw, h: nh }
    // the picture fills its box the way it is drawn (cover, centred): work out where the whole original sits
    const k = Math.max(box.w / p.w, box.h / p.h)
    const full = { x: box.x + (box.w - p.w * k) / 2 - p.x * k, y: box.y + (box.h - p.h * k) / 2 - p.y * k, w: nw * k, h: nh * k }
    // what shows now, clamped to the picture
    const b = { x: Math.max(box.x, full.x), y: Math.max(box.y, full.y), w: 0, h: 0 }
    b.w = Math.min(box.x + box.w, full.x + full.w) - b.x
    b.h = Math.min(box.y + box.h, full.y + full.h) - b.y
    useAi.setState({ crop: { target, img, orig, full, box: b, start: { ...b } } })
    set({ toast: null })
  }).catch((e) => toast(e.message))
}

const cancelCrop = () => useAi.setState({ crop: null })

/** Cut the picture to the box and put it in place. */
export async function finishCrop() {
  const c = useAi.getState().crop
  if (!c) return
  const { target, img, orig, full, box } = c
  const nw = img.naturalWidth, nh = img.naturalHeight, k = full.w / nw
  const r = { x: Math.round((box.x - full.x) / k), y: Math.round((box.y - full.y) / k), w: Math.round(box.w / k), h: Math.round(box.h / k) }
  r.x = Math.max(0, Math.min(nw - 1, r.x)); r.y = Math.max(0, Math.min(nh - 1, r.y))
  r.w = Math.max(1, Math.min(nw - r.x, r.w)); r.h = Math.max(1, Math.min(nh - r.y, r.h))
  const same = (a: Box, b: Box) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
  useAi.setState({ crop: null })
  if (same(box, c.start)) return
  const whole = r.x === 0 && r.y === 0 && r.w === nw && r.h === nh
  try {
    let path = orig, src = orig
    if (!whole) {
      const cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h
      cv.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
      const png = /\.(png|webp|gif|svg)(\?|$)/i.test(orig)
      const type = png ? 'image/png' : 'image/jpeg'
      const blob: Blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the picture'))), type, 0.95))
      const name = `cropped.${png ? 'png' : 'jpg'}`
      if (target.kind === 'item') path = await uploadMedia(new File([blob], name, { type }))
      else src = await upload(target.design, blob, name)
    }
    const crop: CropRect | undefined = whole ? undefined : { src: orig, ...r }
    if (target.kind === 'item') {
      const it = get().items[target.id]
      if (it) itemOp([{ ...it, src: path, crop, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }])
      return
    }
    const el = elOf(target.design, target.sid) as HTMLImageElement | null
    if (!el) return
    const now = rawBox(target.design, el)
    const f = el.offsetWidth / now.w || 1 // the design's own px per board unit
    const mv = mover(el)
    changeEl(target.design, el, { src, 'data-crop': crop ? JSON.stringify(crop) : null }, { width: `${Math.round(box.w * f)}px`, height: `${Math.round(box.h * f)}px`, ...(isPage(target.design) && mv.mode !== 'lt' ? {} : moveProps(mv, (box.x - now.x) * f, (box.y - now.y) * f)) })
  } catch (e) {
    toast((e as Error).message)
  }
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The crop box on the board. */
export function CropFrame() {
  const c = useAi((s) => s.crop)
  const z = useStore((s) => s.view.z)
  const drag = useRef<{ h: string; x0: number; y0: number; b: Box; f: Box } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!c) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); cancelCrop() }
      else if (e.key === 'Enter') { e.stopImmediatePropagation(); e.preventDefault(); finishCrop() }
    }
    // a click anywhere else finishes the crop, as in Figma
    const away = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node) && !(e.target as Element).closest?.('.crop-actions')) finishCrop() }
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', away, true)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', away, true) }
  }, [!!c])
  if (!c) return null
  const { full, box, img } = c

  const down = (h: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { h, x0: e.clientX, y0: e.clientY, b: { ...box }, f: { ...full } }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    const cur = useAi.getState().crop
    if (!d || !cur) return
    const dx = (e.clientX - d.x0) / z, dy = (e.clientY - d.y0) / z
    const F = d.f
    if (d.h === 'move') {
      // slide the picture under the box; it always covers the box
      const x = Math.min(d.b.x, Math.max(d.b.x + d.b.w - F.w, F.x + dx))
      const y = Math.min(d.b.y, Math.max(d.b.y + d.b.h - F.h, F.y + dy))
      useAi.setState({ crop: { ...cur, full: { ...F, x, y } } })
    } else {
      let x0 = d.b.x, y0 = d.b.y, x1 = d.b.x + d.b.w, y1 = d.b.y + d.b.h
      if (d.h.includes('w')) x0 = Math.max(F.x, Math.min(x1 - MIN, x0 + dx))
      if (d.h.includes('e')) x1 = Math.min(F.x + F.w, Math.max(x0 + MIN, x1 + dx))
      if (d.h.includes('n')) y0 = Math.max(F.y, Math.min(y1 - MIN, y0 + dy))
      if (d.h.includes('s')) y1 = Math.min(F.y + F.h, Math.max(y0 + MIN, y1 + dy))
      if (e.shiftKey && d.h.length === 2) {
        // keep the shape: follow the edge that moved most, then fit inside the picture
        const R = d.b.w / d.b.h
        let w = x1 - x0, h = y1 - y0
        if (w / R > h) h = w / R; else w = h * R
        const maxW = d.h.includes('w') ? x1 - F.x : F.x + F.w - x0, maxH = d.h.includes('n') ? y1 - F.y : F.y + F.h - y0
        const s = Math.min(1, maxW / w, maxH / h); w *= s; h *= s
        if (d.h.includes('w')) x0 = x1 - w; else x1 = x0 + w
        if (d.h.includes('n')) y0 = y1 - h; else y1 = y0 + h
      }
      useAi.setState({ crop: { ...cur, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } } })
    }
    tick((n) => n + 1)
  }
  const up = () => { drag.current = null }
  const k = full.w / img.naturalWidth
  const btn = { fontSize: 13 / z, padding: `${6 / z}px ${14 / z}px`, borderRadius: 6 / z }
  return (
    <div ref={root} className="crop-layer" onPointerMove={move} onPointerUp={up} onDoubleClick={(e) => { e.stopPropagation(); finishCrop() }}>
      {/* the whole picture, dimmed: drag it to slide it under the box */}
      <img className="crop-full" src={img.src} alt="" draggable={false} style={{ left: full.x, top: full.y, width: full.w, height: full.h }} onPointerDown={down('move')} />
      <div className="crop-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h, outlineWidth: 1.5 / z }} onPointerDown={down('move')}>
        <div className="crop-clip"><img src={img.src} alt="" draggable={false} style={{ left: full.x - box.x, top: full.y - box.y, width: full.w, height: full.h }} /></div>
        <div className="crop-thirds" style={{ borderWidth: `0 ${1 / z}px` }} />
        <div className="crop-thirds h" style={{ borderWidth: `${1 / z}px 0` }} />
        {HANDLES.map((h) => (
          <div key={h} className={`crop-h ch-${h}${h.length === 2 ? ' corner' : ''}`} onPointerDown={down(h)}
            style={h.length === 2 ? { width: 10 / z, height: 10 / z, margin: -5 / z, borderWidth: 1.5 / z } : h === 'n' || h === 's' ? { width: 22 / z, height: 6 / z, margin: `${-3 / z}px ${-11 / z}px`, borderRadius: 3 / z } : { width: 6 / z, height: 22 / z, margin: `${-11 / z}px ${-3 / z}px`, borderRadius: 3 / z }} />
        ))}
        <div className="ex-badge" style={{ fontSize: 12 / z, padding: `${3 / z}px ${8 / z}px`, borderRadius: 4 / z, bottom: -30 / z }}>
          {Math.round(box.w / k)} × {Math.round(box.h / k)}
        </div>
        <div className="ex-actions crop-actions" style={{ top: `calc(100% + ${40 / z}px)`, gap: 6 / z }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="ex-go" style={btn} onClick={() => finishCrop()} title="Enter">Done</button>
          <button className="ex-cancel" style={btn} onClick={() => useAi.setState({ crop: { ...c, box: { ...c.full } } })} title="Show the whole picture again">Reset</button>
          <button className="ex-cancel" style={btn} onClick={cancelCrop} title="Esc">Cancel</button>
        </div>
      </div>
    </div>
  )
}
