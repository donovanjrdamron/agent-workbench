// Drag-to-expand, as in Figma: pull the picture's edges out to the size you want, let go, and only the new area is
// generated. The picture itself is laid back over the result pixel for pixel, so it never changes.
import { useEffect, useRef, useState } from 'react'
import { loadImage, onProgress, urlOf, useAi, type Target } from '../ai'
import { setAttr, style, mover, moveProps } from '../commands'
import { elOf, rawBox } from '../dom'
import { itemOp, upload, uploadMedia } from '../net'
import { get, set, toast, useStore, type Box } from '../store'

const RATIOS: [string, number][] = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'].map((r) => { const [a, b] = r.split(':').map(Number); return [r, a / b] })
const SEND = 1536 // longest side sent to the model
const KEEP = 4096 // longest side of the finished picture

/** Where the picture is on the board (world units), and how many world units one of its pixels takes. */
function frameOf(t: Target, img: HTMLImageElement): { box: Box; k: number } | null {
  const s = get()
  if (t.kind === 'item') { const it = s.items[t.id]; return it ? { box: { x: it.x, y: it.y, w: it.w, h: it.h }, k: it.w / img.naturalWidth } : null }
  const el = elOf(t.design, t.sid)
  if (!el) return null
  const b = rawBox(t.design, el)
  return { box: b, k: b.w / img.naturalWidth }
}

export function startExpand(target: Target) {
  const url = urlOf(target)
  if (!url) return
  const s = get()
  if (target.kind === 'item' && s.items[target.id]?.rot) { toast('Straighten the picture first (rotation 0), then expand it.'); return }
  if (target.kind === 'el') { const el = elOf(target.design, target.sid); if (el && getComputedStyle(el).rotate !== 'none' && parseFloat(getComputedStyle(el).rotate)) { toast('Straighten the picture first (rotation 0), then expand it.'); return } }
  loadImage(url).then((img) => {
    const f = frameOf(target, img)
    if (!f) return
    // a planning picture shown cropped to another shape: show it whole first, so the edges you pull are its real edges
    if (target.kind === 'item') {
      const it = get().items[target.id]!
      const h = Math.round((it.w * img.naturalHeight) / img.naturalWidth)
      if (Math.abs(h - it.h) > 2) { itemOp([{ ...it, h }]); f.box.h = h }
    }
    useAi.setState({ expand: { target, img, from: f.box, box: { ...f.box }, k: f.k, running: false } })
    toast('Drag any edges out to the size you want, then Generate (or Enter). Esc cancels.')
  }).catch((e) => toast(e.message))
}

/** Generate the new area for `box` (world units) around the picture at `from`. */
async function runExpand() {
  const ex = useAi.getState().expand
  if (!ex) return
  const { target, img, from, box, k } = ex
  const nw = img.naturalWidth, nh = img.naturalHeight
  // the new canvas in the picture's own pixels, and where the picture sits on it
  const W = Math.round(box.w / k), H = Math.round(box.h / k), ox = Math.round((from.x - box.x) / k), oy = Math.round((from.y - box.y) / k)
  if (W <= nw + 2 && H <= nh + 2) { useAi.setState({ expand: null }); return }
  useAi.setState({ expand: { ...ex, running: true } })
  const job = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const say = (t: string) => useAi.setState((st) => (st.expand ? { expand: { ...st.expand, status: t } } : {}))
  const off = onProgress(job, say)
  try {
    // the model works in fixed shapes: grow the canvas evenly to the nearest one, and crop that extra away afterwards
    const [ratio, R] = RATIOS.reduce((b, r) => (Math.abs(Math.log(r[1] / (W / H))) < Math.abs(Math.log(b[1] / (W / H))) ? r : b))
    const SW = Math.max(W, Math.round(H * R)), SH = Math.max(H, Math.round(SW / R))
    const sx = Math.round((SW - W) / 2), sy = Math.round((SH - H) / 2)
    const s = Math.min(1, SEND / Math.max(SW, SH))
    const c = document.createElement('canvas'); c.width = Math.round(SW * s); c.height = Math.round(SH * s)
    const g = c.getContext('2d')!
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height)
    g.drawImage(img, (sx + ox) * s, (sy + oy) * s, nw * s, nh * s)
    say('Uploading…')
    const r = await fetch('/api/ai', { method: 'POST', body: JSON.stringify({ board: get().board, design: target.kind === 'el' ? target.design : undefined, op: 'fill', image: c.toDataURL('image/png'), aspect: ratio, job }) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Studio is not answering' }))
    if (r.error === 'NOT_CONNECTED') { window.open('/oauth/higgsfield/start', 'higgsfield-signin', 'width=520,height=720'); throw new Error('Sign in to Higgsfield in the window that opened, then try again.') }
    if (!r.ok) throw new Error(r.error || 'It did not work')
    say('Putting it together…')
    const fill = await loadImage(`/b/${encodeURIComponent(get().board)}/${r.path.split('/').map(encodeURIComponent).join('/')}`)
    // finished picture: the filled canvas, cropped to the user's box, with the original laid back over it
    const f = Math.min(1, KEEP / Math.max(W, H))
    const out = document.createElement('canvas'); out.width = Math.round(W * f); out.height = Math.round(H * f)
    const o = out.getContext('2d')!
    o.drawImage(fill, -sx * f, -sy * f, SW * f, SH * f)
    o.drawImage(feathered(img, { left: ox > 0, top: oy > 0, right: ox + nw < W, bottom: oy + nh < H }), ox * f, oy * f, nw * f, nh * f)
    const blob: Blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the picture'))), 'image/png'))
    await place(target, blob, { box, from, k, W, H, ox, oy, f })
    toast('Expanded. ⌘Z puts the old picture back.')
  } catch (e) {
    toast((e as Error).message)
  } finally {
    off()
    useAi.setState({ expand: null })
  }
}

/** The picture with its edges that meet new area faded over a few pixels, so the seam disappears. */
function feathered(img: HTMLImageElement, edges: { left: boolean; top: boolean; right: boolean; bottom: boolean }) {
  const w = img.naturalWidth, h = img.naturalHeight, F = Math.max(6, Math.round(Math.min(w, h) * 0.02))
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0)
  g.globalCompositeOperation = 'destination-in'
  const fade = (x0: number, y0: number, x1: number, y1: number) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = gr; g.fillRect(0, 0, w, h) }
  if (edges.left) fade(0, 0, F, 0)
  if (edges.right) fade(w, 0, w - F, 0)
  if (edges.top) fade(0, 0, 0, F)
  if (edges.bottom) fade(0, h, 0, h - F)
  return c
}

async function place(t: Target, blob: Blob, m: { box: Box; from: Box; k: number; W: number; H: number; ox: number; oy: number; f: number }) {
  if (t.kind === 'item') {
    const path = await uploadMedia(new File([blob], 'expanded.png', { type: 'image/png' }))
    const it = get().items[t.id]
    if (it) itemOp([{ ...it, src: path, x: Math.round(m.box.x), y: Math.round(m.box.y), w: Math.round(m.box.w), h: Math.round(m.box.h) }])
    return
  }
  const el = elOf(t.design, t.sid) as HTMLImageElement | null
  if (!el) return
  const src = await upload(t.design, blob, 'expanded.png')
  // the element grows by the new area and moves so the old part stays where it was
  const cssK = el.offsetWidth / el.naturalWidth || m.k
  const mv = mover(el)
  setAttr(t.design, el, 'src', src)
  style(t.design, [el], { width: `${Math.round(m.W * cssK)}px`, height: `${Math.round(m.H * cssK)}px`, ...moveProps(mv, -m.ox * cssK, -m.oy * cssK) }, true)
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The expand frame on the board: drag its edges, let go to start. */
export function ExpandFrame() {
  const ex = useAi((s) => s.expand)
  const z = useStore((s) => s.view.z)
  const drag = useRef<{ h: string; x0: number; y0: number; b: Box } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!ex || ex.running) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); useAi.setState({ expand: null }); set({ toast: null }) } else if (e.key === 'Enter') { e.stopImmediatePropagation(); e.preventDefault(); runExpand() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [ex?.running, !!ex])
  if (!ex) return null
  const { box, from, k } = ex
  const down = (h: string) => (e: React.PointerEvent) => {
    if (ex.running) return
    e.stopPropagation(); e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { h, x0: e.clientX, y0: e.clientY, b: { ...box } }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x0) / z, dy = (e.clientY - d.y0) / z
    let { x, y, w, h } = d.b
    // never smaller than the picture: you can only add to it
    if (d.h.includes('e')) w = Math.max(from.x + from.w - x, d.b.w + dx)
    if (d.h.includes('s')) h = Math.max(from.y + from.h - y, d.b.h + dy)
    if (d.h.includes('w')) { const nx = Math.min(from.x, d.b.x + dx); w = d.b.x + d.b.w - nx; x = nx }
    if (d.h.includes('n')) { const ny = Math.min(from.y, d.b.y + dy); h = d.b.y + d.b.h - ny; y = ny }
    useAi.setState({ expand: { ...ex, box: { x, y, w, h } } })
    tick((n) => n + 1)
  }
  const up = () => { drag.current = null } // adjust as many edges as you like; the Generate button (or Enter) starts it
  const px = (v: number) => Math.round(v / k)
  return (
    <div className={`ex-frame${ex.running ? ' running' : ''}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h, outlineWidth: 2 / z }}
      onPointerDown={(e) => e.stopPropagation()} onPointerMove={move} onPointerUp={up}>
      {/* the new area only (four strips around the picture), so the picture itself stays visible */}
      {[
        { left: 0, top: 0, width: box.w, height: from.y - box.y },
        { left: 0, top: from.y + from.h - box.y, width: box.w, height: box.y + box.h - from.y - from.h },
        { left: 0, top: from.y - box.y, width: from.x - box.x, height: from.h },
        { left: from.x + from.w - box.x, top: from.y - box.y, width: box.x + box.w - from.x - from.w, height: from.h },
      ].map((r, i) => r.width > 0 && r.height > 0 ? <div key={i} className="ex-new" style={r} /> : null)}
      <div className="ex-hole" style={{ left: from.x - box.x, top: from.y - box.y, width: from.w, height: from.h }} />
      {!ex.running && HANDLES.map((h) => (
        <div key={h} className={`ex-h ex-${h}`} onPointerDown={down(h)}
          style={{ width: 12 / z, height: 12 / z, borderWidth: 2 / z, margin: -6 / z }} />
      ))}
      <div className="ex-badge" style={{ fontSize: 12 / z, padding: `${3 / z}px ${8 / z}px`, borderRadius: 4 / z, bottom: -30 / z }}>
        {ex.running ? <><span className="ai-spin" style={{ width: 10 / z, height: 10 / z, borderWidth: 2 / z }} /> {ex.status || 'Expanding…'}</> : `${px(box.w)} × ${px(box.h)} · drag any edges`}
      </div>
      {!ex.running && (
        <div className="ex-actions" style={{ top: `calc(100% + ${40 / z}px)`, gap: 6 / z }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="ex-go" style={{ fontSize: 13 / z, padding: `${6 / z}px ${14 / z}px`, borderRadius: 6 / z }} disabled={box.w <= from.w + 1 && box.h <= from.h + 1}
            onClick={() => runExpand()} title="Fill the new area (Enter)">Generate</button>
          <button className="ex-cancel" style={{ fontSize: 13 / z, padding: `${6 / z}px ${14 / z}px`, borderRadius: 6 / z }}
            onClick={() => { useAi.setState({ expand: null }); set({ toast: null }) }} title="Esc">Cancel</button>
        </div>
      )}
    </div>
  )
}
