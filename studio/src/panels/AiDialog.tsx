// The dialog for Edit, Expand and Erase: what to change, the new shape, or a brush over what should go.
import { useEffect, useRef, useState } from 'react'
import { expandBox, loadImage, MODELS, RATIOS, runTool, urlOf, useAi } from '../ai'
import { startExpand } from '../canvas/Expand'
import { startCrop } from '../canvas/Crop'

const TITLE = { edit: 'Edit with AI', expand: 'Expand', erase: 'Erase' }
const MAX = { w: 560, h: 420 } // the picture is shown at most this big

export function AiDialog() {
  const open = useAi((s) => s.open)
  if (!open) return null
  return <Dialog key={JSON.stringify(open.target) + open.tool} tool={open.tool} target={open.target} />
}

function Dialog({ tool, target }: { tool: 'edit' | 'expand' | 'erase'; target: Parameters<typeof runTool>[1] }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [err, setErr] = useState('')
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState('1:1')
  const model = useAi((s) => s.model)
  const [brush, setBrush] = useState(40)
  const [painted, setPainted] = useState(false)
  const paint = useRef<HTMLCanvasElement>(null)
  const close = () => useAi.setState({ open: null })

  useEffect(() => {
    const url = urlOf(target)
    if (!url) { setErr('The picture is gone.'); return }
    loadImage(url).then((i) => {
      setImg(i)
      // start from the closest wider-or-taller shape that actually adds something
      const r = i.naturalWidth / i.naturalHeight
      setAspect(r >= 1 ? (r < 1.4 ? '16:9' : '21:9') : r > 0.7 ? '9:16' : '1:1')
    }).catch((e) => setErr(e.message))
  }, [])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [])

  const nw = img?.naturalWidth || 1, nh = img?.naturalHeight || 1
  const box = tool === 'expand' && img ? expandBox(nw, nh, aspect) : null
  // the displayed size: the whole frame (for expand: the new shape) fits in MAX
  const fw = box ? box.W : nw, fh = box ? box.H : nh
  const k = Math.min(MAX.w / fw, MAX.h / fh, 1)

  // erase brush: paint in the picture's own pixels, shown scaled
  const draw = (e: React.PointerEvent<HTMLCanvasElement>, start = false) => {
    const c = paint.current
    if (!c || (!start && e.buttons !== 1)) return
    const r = c.getBoundingClientRect(), s = c.width / r.width
    const x = (e.clientX - r.left) * s, y = (e.clientY - r.top) * s
    const g = c.getContext('2d')!
    g.fillStyle = '#ff00ff'
    g.beginPath(); g.arc(x, y, (brush * s) / 2, 0, Math.PI * 2); g.fill()
    const last = (c as unknown as { last?: { x: number; y: number } }).last
    if (!start && last) { g.strokeStyle = '#ff00ff'; g.lineWidth = brush * s; g.lineCap = 'round'; g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(x, y); g.stroke() }
    ;(c as unknown as { last?: { x: number; y: number } }).last = { x, y }
    setPainted(true)
  }
  const clear = () => { const c = paint.current; c?.getContext('2d')!.clearRect(0, 0, c.width, c.height); setPainted(false) }

  const go = () => {
    if (!img) return
    if (tool === 'edit') { if (!prompt.trim()) return; runTool('edit', target, { prompt: prompt.trim(), model }) }
    if (tool === 'expand') runTool('expand', target, { aspect })
    if (tool === 'erase') {
      if (!painted) return
      const c = document.createElement('canvas'); c.width = nw; c.height = nh
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0); g.drawImage(paint.current!, 0, 0)
      runTool('erase', target, { marked: c.toDataURL('image/png'), prompt: prompt.trim() || undefined, model })
    }
    close()
  }
  const ready = !!img && (tool === 'edit' ? !!prompt.trim() : tool === 'erase' ? painted : true)

  return (
    <div className="ai-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="ai-dialog" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) go() }}>
        <div className="ai-head"><b>{TITLE[tool]}</b><span className="ai-by">Higgsfield</span><button className="mini" onClick={close} title="Close (Esc)">✕</button></div>
        {err && <p className="ai-err">{err}</p>}
        {!img && !err && <div className="ai-loading">Loading the picture…</div>}
        {img && (
          <div className="ai-stage" style={{ width: fw * k, height: fh * k }}>
            {box && <div className="ai-pad" />}
            <img src={img.src} alt="" style={box ? { left: box.x * k, top: box.y * k, width: box.w * k, height: box.h * k } : { left: 0, top: 0, width: nw * k, height: nh * k }} />
            {tool === 'erase' && <canvas ref={paint} width={nw} height={nh} className="ai-paint" style={{ width: nw * k, height: nh * k, cursor: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${Math.min(120, brush)}' height='${Math.min(120, brush)}'><circle cx='${Math.min(120, brush) / 2}' cy='${Math.min(120, brush) / 2}' r='${Math.min(120, brush) / 2 - 1}' fill='none' stroke='white' stroke-width='1.5'/></svg>") ${Math.min(120, brush) / 2} ${Math.min(120, brush) / 2}, crosshair` }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); draw(e, true) }} onPointerMove={(e) => draw(e)} onPointerUp={(e) => { (e.currentTarget as unknown as { last?: unknown }).last = undefined }} />}
          </div>
        )}
        {tool === 'expand' && (
          <div className="ai-row ratios">{RATIOS.map((r) => <button key={r} className={r === aspect ? 'on' : ''} onClick={() => setAspect(r)}>{r}</button>)}</div>
        )}
        {tool === 'erase' && (
          <div className="ai-row">
            <span className="ai-label">Brush</span>
            <input type="range" min={8} max={160} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
            <button className="ghost" onClick={clear} disabled={!painted}>Clear</button>
          </div>
        )}
        {tool !== 'expand' && (
          <div className="ai-row">
            <span className="ai-label">Model</span>
            <select className="ai-model" value={model} onChange={(e) => useAi.setState({ model: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.note}</option>)}
            </select>
          </div>
        )}
        {tool !== 'expand' && <textarea className="ai-prompt" autoFocus={tool === 'edit'} rows={tool === 'edit' ? 3 : 2} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={tool === 'edit' ? 'What should change? e.g. "put the bottles on warm beige linen, soft window light"' : 'Optional: what you are removing, e.g. "the price sticker"'} />}
        <div className="ai-foot">
          <span className="ai-hint">{tool === 'erase' ? 'Paint over what should go.' : tool === 'expand' ? 'The grey area gets filled in.' : ''} Uses about 2–3 credits of your Higgsfield plan. ⌘Enter</span>
          <button className="ghost" onClick={close}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={go}>{tool === 'edit' ? 'Generate' : tool === 'expand' ? 'Expand' : 'Erase'}</button>
        </div>
      </div>
    </div>
  )
}

/** The four tools as a row of buttons (right panel for a picture in an ad, a bar over a planning picture). */
export function AiButtons({ target, compact }: { target: Parameters<typeof runTool>[1]; compact?: boolean }) {
  const busy = useAi((s) => s.busy[target.kind === 'item' ? target.id : `${target.design}#${target.sid}`])
  const stop = { onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); e.preventDefault() } }
  if (busy) return <div className={`ai-buttons busy${compact ? ' compact' : ''}`} {...stop}><span className="ai-spin" />{busy.replace(/^[^:]+: /, '')}</div>
  const b = (label: string, title: string, fn: () => void) => <button key={label} title={title} onClick={(e) => { e.stopPropagation(); fn() }}>{label}</button>
  return (
    <div className={`ai-buttons${compact ? ' compact' : ''}`} {...stop}>
      {b('Crop', 'Crop the picture (or double-click it)', () => startCrop(target))}
      {b('Remove BG', 'Cut out the subject (on this Mac, free)', () => runTool('removebg', target))}
      {b('Edit…', 'Change it by describing what you want (Higgsfield)', () => useAi.setState({ open: { tool: 'edit', target } }))}
      {b('Expand', 'Drag the edges out to the size you want; only the new area is generated (Higgsfield)', () => startExpand(target))}
      {b('Erase…', 'Brush over something to remove it (Higgsfield)', () => useAi.setState({ open: { tool: 'erase', target } }))}
      {b('Upscale', 'Sharpen and enlarge to 4K (Higgsfield)', () => runTool('upscale', target))}
    </div>
  )
}
