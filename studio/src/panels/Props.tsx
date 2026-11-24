import { useEffect, useRef, useState } from 'react'
import { deleteSelection, duplicate, finishEditing, flush, moveProps, mover, removeDesign, revert, selectParent, selectionHost, setAttr, style, styleSelection, zOrder } from '../commands'
import { boxOf, cssColor, docOf, elOf, frames, isPage, isTextLeaf, label, sidOf, toCss } from '../dom'
import { AiButtons } from './AiDialog'
import { copyRef, frameRef } from '../refs'
import { exportDesign, saveLayout, settled, upload } from '../net'
import { startSlicing } from '../canvas/Slices'
import { get, set, toast, useStore } from '../store'
import { Btn, Color, Icon, Num, Section, Select } from '../ui'

// Web fonts are offered only in files that load them; anywhere else they would silently render as a fallback.
const FONTS = ['Inter', 'Sentient', 'Instrument Serif', 'Archivo']
const SYSTEM_FONTS = ['Helvetica Neue', 'Arial', 'Georgia']
const SERIFS = new Set(['Georgia', 'Sentient', 'Instrument Serif', 'Times New Roman', 'Didot'])
const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semi Bold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']] as const
const BRAND = [['Cream', '#f4ece3'], ['Cream light', '#f6f1e6'], ['Ink', '#141414'], ['Ad red', '#c11c0f'], ['Deep red', '#7e120a'], ['Gold', '#d9a516'], ['Cream on photo', '#f7f2e9'], ['Amber', '#ffd9a8'], ['White', '#ffffff']] as const
const px = (v: string) => Math.round((parseFloat(v) || 0) * 100) / 100

const first = (stack: string) => stack.split(',')[0].replace(/["']/g, '').trim()
// Per design: every font family the file uses, with the full fallback stack it came with. Only grows, so a font
// stays on offer after the one element that used it has been switched to something else.
const fontsSeen = new Map<string, Map<string, string>>()
const fontsRead = new WeakSet<Document>()
function fontsOf(design: string, doc: Document, current: string): { names: string[]; stack: (name: string) => string } {
  let seen = fontsSeen.get(design)
  if (!seen) fontsSeen.set(design, (seen = new Map()))
  const note = (stack: string) => { const n = first(stack); if (n && !seen!.has(n)) seen!.set(n, stack) }
  if (!fontsRead.has(doc) && doc.readyState === 'complete') { fontsRead.add(doc); doc.body.querySelectorAll('[data-sid]').forEach((e) => note(getComputedStyle(e).fontFamily)) }
  note(current)
  const loaded = new Set(Array.from(doc.fonts as unknown as Iterable<FontFace>, (f) => f.family.replace(/["']/g, '')))
  const names = [...new Set([...seen.keys(), ...SYSTEM_FONTS, ...FONTS.filter((f) => loaded.has(f))])]
  // the file's own stack where there is one, so the fallbacks stay the file's (single quotes: it is written into an attribute)
  return { names, stack: (name) => (seen!.get(name) || `'${name}', ${!SERIFS.has(name) ? 'sans-serif' : name === 'Georgia' ? 'serif' : 'Georgia, serif'}`).replace(/"/g, "'") }
}

// The colour dots: the file's own palette, read from the custom properties it declares on :root (--oxblood: #812221).
const palettes = new WeakMap<Document, (readonly [string, string])[]>()
function paletteOf(doc: Document | null): readonly (readonly [string, string])[] {
  if (!doc) return BRAND
  const hit = palettes.get(doc)
  if (hit) return hit.length ? hit : BRAND
  const out = new Map<string, string>()
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRule[]
    try { rules = Array.from(sheet.cssRules) } catch { continue } // a cross-origin sheet (web fonts) cannot be read
    for (const rule of rules) {
      // not instanceof: the rule comes from the iframe's own realm
      if (!('selectorText' in rule) || !String(rule.selectorText).includes(':root')) continue
      const decl = (rule as CSSStyleRule).style
      for (const name of Array.from(decl)) {
        if (!name.startsWith('--')) continue
        const v = decl.getPropertyValue(name).trim()
        const hex = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : /^#[0-9a-f]{3}$/i.test(v) ? '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase() : /^rgba?\(/i.test(v) ? cssColor(v).color : null
        if (hex && ![...out.values()].includes(hex)) out.set(name.slice(2), hex)
      }
    }
  }
  const list = [...out].slice(0, 18)
  if (doc.readyState === 'complete') palettes.set(doc, list) // before that a linked stylesheet may still be loading
  return list.length ? list : BRAND
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => resolve(i.files?.[0] || null); i.click() })
}

function ExportBox({ design }: { design: string }) {
  const [scale, setScale] = useState(2)
  const [format, setFormat] = useState('png')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState('')
  const run = async () => {
    setBusy(true)
    try {
      // the export renders the file on disk: copy still being typed and a value just entered must be written first
      if (get().editing) finishEditing()
      flush()
      await settled(design)
      const r = await exportDesign(design, scale, format)
      if (r.path) { setLast(r.path); toast(`Exported ${r.width}×${r.height}`) } else toast(r.error || 'Export failed')
    } finally { setBusy(false) }
  }
  return (
    <Section title="Export">
      <div className="row">
        <Select value={scale} onChange={setScale} options={[{ value: 1, label: '1x' }, { value: 2, label: '2x' }, { value: 3, label: '3x' }]} />
        <Select value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'pdf', label: 'PDF' }]} />
        <button className="primary" disabled={busy} onClick={run}>{busy ? 'Rendering…' : 'Export'}</button>
      </div>
      <button className="ghost" title="Mark parts of this design and export each as its own picture (for Klaviyo)" onClick={() => startSlicing(design)}>Slice for export…</button>
      {last && <p className="hint path">{last}</p>}
    </Section>
  )
}

function InlineCss({ design, el }: { design: string; el: HTMLElement }) {
  const cur = (el.getAttribute('style') || '').split(';').map((s) => s.trim()).filter(Boolean).join(';\n')
  const [text, setText] = useState(cur)
  const [dirty, setDirty] = useState(false)
  const cancel = useRef(false)
  useEffect(() => { if (!dirty) setText(cur) }, [cur, dirty])
  return (
    <Section title="Inline CSS">
      <textarea className="css" rows={Math.min(10, Math.max(3, text.split('\n').length + 1))} value={text} spellCheck={false} placeholder="property: value;"
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
        onKeyDown={(e) => { if (e.key === 'Escape') cancel.current = true }}
        onBlur={() => {
          if (!dirty) return
          setDirty(false)
          if (cancel.current) { cancel.current = false; setText(cur); return } // Escape: drop what was typed
          const v = text.split('\n').map((s) => s.trim().replace(/;$/, '')).filter(Boolean).join(';'); setAttr(design, el, 'style', v || null)
        }} />
      <p className="hint">Your tweaks live here, on the element. The agent sees them as a diff of its file.</p>
    </Section>
  )
}

/** What paints a frame's background: the frontmost layer that covers (nearly) all of it and has a fill, else the artboard. */
export function backgroundOf(id: string): HTMLElement | null {
  const root = frames.get(id)?.root
  if (!root) return null
  const r = root.getBoundingClientRect()
  let hit: HTMLElement = root
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (el.tagName === 'IMG' || el.tagName === 'svg' || el.closest('svg')) continue
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el)
    if (b.width * b.height < r.width * r.height * 0.97 || cs.visibility === 'hidden' || cs.display === 'none') continue
    if (cssColor(cs.backgroundColor).alpha > 0 || cs.backgroundImage !== 'none') hit = el
  }
  return hit
}

function DesignPanel({ id }: { id: string }) {
  const d = useStore((s) => s.designs[id])
  const root = useStore((s) => s.root)
  useStore((s) => s.tick)
  if (!d) return null
  const page = frames.get(id) ? !frames.get(id)!.art : false
  const paint = backgroundOf(id)
  const pcs = paint ? getComputedStyle(paint) : null
  const bg = pcs ? cssColor(pcs.backgroundColor) : null
  const setBg = (v: string) => { if (paint) style(id, [paint], { 'background-color': v }, true) }
  return (
    <>
      <Section title="Design">
        <p className="hint path">{root}/{id}</p>
        <button className="ghost" title="Copies a reference to this frame (its file) that any AI can use to find exactly this design" onClick={() => copyRef(frameRef(id))}>Copy link for AI</button>
        <div className="row"><Num label="W" value={d.w} onChange={() => {}} /><Num label="H" value={d.h} onChange={() => {}} /></div>
        {page && <div className="row">
          <Select title="Preview width" value={d.width || 1200} onChange={(width) => { set({ designs: { ...get().designs, [id]: { ...d, width } } }); saveLayout([{ id, width }]) }}
            options={[...new Set([390, 600, 680, 1200, 1440, d.width || 1200])].sort((a, b) => a - b).map((w) => ({ value: w, label: `${w}px wide${w === 390 ? ' (phone)' : w === 600 || w === 680 ? ' (email)' : ''}` }))} />
        </div>}
        <p className="hint">{page ? 'This is a page (email or brief). Click it again to select text and images inside. Layout stays the agent\'s job.' : 'Drag to move this frame. Click it again to select what is inside.'}</p>
        <div className="row">
          {d.dirty && <button className="ghost" title="Throw away your hand edits on this design" onClick={() => revert(id)}>Revert my edits</button>}
          <button className="ghost danger" title="Delete this design file (⌫)" onClick={() => removeDesign(id)}>Delete design</button>
        </div>
      </Section>
      {!page && bg && paint && (
        <Section title="Background">
          <Color color={bg.color} alpha={bg.alpha} onChange={(c, a) => setBg(toCss(c, a))} />
          <div className="brand">{paletteOf(paint.ownerDocument).map(([n, c]) => <button key={n} title={n} style={{ background: c }} onClick={() => setBg(c)} />)}</div>
          {pcs && pcs.backgroundImage !== 'none' && <p className="hint">This background also has a picture or gradient on top: edit it under the layer's Inline CSS.</p>}
          {paint !== frames.get(id)?.root && <p className="hint">Painted by the full-size layer {label(paint)}.</p>}
        </Section>
      )}
      <ExportBox design={id} />
    </>
  )
}

type Dots = readonly (readonly [string, string])[]
const none = (v: string) => !v || v === 'none' || cssColor(v).alpha === 0

/** Stroke on a box, card or text block: its border (and, for text, an outline on the letters). */
function StrokePanel({ design, els, dots, text }: { design: string; els: HTMLElement[]; dots: Dots; text: boolean }) {
  const cs = getComputedStyle(els[0])
  const w = parseFloat(cs.borderTopWidth) || 0
  const has = w > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden'
  const col = cssColor(cs.borderTopColor)
  const set = (props: Record<string, string | null>) => style(design, els, props, true)
  const border = (width: number, st: string, color: string) => set({ border: `${width}px ${st} ${color}` }) // (the shorthand resets all four sides)
  const tw = parseFloat(cs.getPropertyValue('-webkit-text-stroke-width')) || 0
  const tcol = cssColor(cs.getPropertyValue('-webkit-text-stroke-color') || 'rgb(0,0,0)')
  return (
    <>
      <Section title="Stroke" action={has
        ? <button className="mini" title="Remove the stroke" onClick={() => set({ border: 'none' })}>−</button>
        : <button className="mini" title="Add a stroke" onClick={() => border(2, 'solid', '#141414')}>+</button>}>
        {has && <>
          <Color color={col.color} alpha={col.alpha} onChange={(c, a) => border(w, cs.borderTopStyle, toCss(c, a))} />
          <div className="brand">{dots.map(([n, c]) => <button key={n} title={n} style={{ background: c }} onClick={() => border(w, cs.borderTopStyle, c)} />)}</div>
          <div className="row">
            <Num label="W" value={w} min={0} step={0.5} suffix="px" title="Stroke weight" onChange={(v) => (v > 0 ? border(v, cs.borderTopStyle, cs.borderTopColor) : set({ border: 'none' }))} />
            <Select title="Line" value={cs.borderTopStyle} onChange={(v) => border(w, v, cs.borderTopColor)} options={['solid', 'dashed', 'dotted', 'double'].map((x) => ({ value: x, label: x }))} />
          </div>
        </>}
        {!has && <p className="hint">No stroke. + adds one.</p>}
      </Section>
      {text && (
        <Section title="Text outline" action={tw > 0
          ? <button className="mini" title="Remove the outline" onClick={() => set({ '-webkit-text-stroke': null, '-webkit-text-stroke-width': null, '-webkit-text-stroke-color': null, 'paint-order': null })}>−</button>
          : <button className="mini" title="Outline the letters" onClick={() => set({ '-webkit-text-stroke': '2px #141414', 'paint-order': 'stroke fill' })}>+</button>}>
          {tw > 0 && <>
            <Color color={tcol.color} alpha={tcol.alpha} onChange={(c, a) => set({ '-webkit-text-stroke': `${tw}px ${toCss(c, a)}` })} />
            <div className="row"><Num label="W" value={tw} min={0} step={0.5} suffix="px" onChange={(v) => set({ '-webkit-text-stroke': v > 0 ? `${v}px ${cs.getPropertyValue('-webkit-text-stroke-color')}` : null })} /></div>
          </>}
        </Section>
      )}
    </>
  )
}

/** An SVG drawing (arrows, circles, icons): its stroke and fill, set on the drawing and on any shape that sets its own. */
function VectorPanel({ design, els, dots }: { design: string; els: HTMLElement[]; dots: Dots }) {
  const shapes = els.flatMap((svg) => Array.from(svg.querySelectorAll('path,circle,ellipse,line,polyline,polygon,rect,text'))) as unknown as HTMLElement[]
  const probe = shapes[0] || els[0]
  const cs = getComputedStyle(probe)
  const stroked = !none(cs.stroke), filled = !none(cs.fill)
  const sw = parseFloat(cs.strokeWidth) || 0
  const sc = cssColor(stroked ? cs.stroke : 'rgb(20,20,20)'), fc = cssColor(filled ? cs.fill : 'rgb(20,20,20)')
  const dashed = cs.strokeDasharray && cs.strokeDasharray !== 'none'
  // on the drawing (its shapes inherit it) and on every shape that has its own value, which would otherwise win
  const set = (props: Record<string, string | null>) => {
    style(design, els, props, true)
    const attr: Record<string, string> = { stroke: 'stroke', 'stroke-width': 'stroke-width', fill: 'fill', 'stroke-dasharray': 'stroke-dasharray', 'stroke-linecap': 'stroke-linecap' }
    const own = shapes.filter((sh) => Object.keys(props).some((k) => attr[k] && (sh.hasAttribute(attr[k]) || sh.style.getPropertyValue(k))))
    if (own.length) style(design, own, props, true)
  }
  return (
    <Section title="Vector">
      <h5>Stroke</h5>
      <div className="row">
        <Color color={sc.color} alpha={stroked ? sc.alpha : 0} onChange={(c, a) => set({ stroke: toCss(c, a) })} />
        <button className="mini" title={stroked ? 'No stroke' : 'Add a stroke'} onClick={() => set(stroked ? { stroke: 'none' } : { stroke: '#141414', 'stroke-width': String(sw || 2) })}>{stroked ? '−' : '+'}</button>
      </div>
      <div className="brand">{dots.map(([n, c]) => <button key={n} title={n} style={{ background: c }} onClick={() => set({ stroke: c })} />)}</div>
      {stroked && <div className="row">
        <Num label="W" value={sw} min={0} step={0.2} title="Stroke weight" onChange={(v) => set({ 'stroke-width': String(v) })} />
        <Select title="Line" value={dashed ? 'dashed' : 'solid'} onChange={(v) => set({ 'stroke-dasharray': v === 'dashed' ? `${Math.max(2, sw * 3)} ${Math.max(2, sw * 2)}` : 'none' })} options={[{ value: 'solid', label: 'solid' }, { value: 'dashed', label: 'dashed' }]} />
        <Select title="Line ends" value={cs.strokeLinecap} onChange={(v) => set({ 'stroke-linecap': v })} options={['round', 'butt', 'square'].map((x) => ({ value: x, label: `${x} ends` }))} />
      </div>}
      <h5>Fill</h5>
      <div className="row">
        <Color color={fc.color} alpha={filled ? fc.alpha : 0} onChange={(c, a) => set({ fill: toCss(c, a) })} />
        <button className="mini" title={filled ? 'No fill' : 'Add a fill'} onClick={() => set({ fill: filled ? 'none' : '#141414' })}>{filled ? '−' : '+'}</button>
      </div>
    </Section>
  )
}

/** A drop shadow: box-shadow on boxes and pictures, a drop-shadow filter on drawings (it follows their shape). */
function ShadowPanel({ design, els }: { design: string; els: HTMLElement[] }) {
  const el = els[0]
  const svg = el.tagName.toLowerCase() === 'svg' || el.tagName === 'IMG'
  const cs = getComputedStyle(el)
  const cur = svg ? (cs.filter.match(/drop-shadow\(([^)]*\)[^)]*)\)/)?.[1] || '') : cs.boxShadow !== 'none' ? cs.boxShadow : ''
  const nums = (cur.match(/-?\d+(\.\d+)?px/g) || []).map((v) => parseFloat(v))
  const colorStr = cur.match(/rgba?\([^)]*\)/)?.[0] || 'rgba(0, 0, 0, 0.35)'
  const col = cssColor(colorStr)
  const [x, y, blur] = [nums[0] ?? 0, nums[1] ?? 8, nums[2] ?? 24]
  const write = (v: { x: number; y: number; blur: number; color: string } | null) => {
    if (svg) {
      const rest = cs.filter === 'none' ? '' : cs.filter.replace(/drop-shadow\((?:[^()]|\([^()]*\))*\)/g, '').trim()
      style(design, els, { filter: v ? `${rest} drop-shadow(${v.x}px ${v.y}px ${v.blur}px ${v.color})`.trim() : rest || null }, true)
    } else style(design, els, { 'box-shadow': v ? `${v.x}px ${v.y}px ${v.blur}px ${v.color}` : null }, true)
  }
  return (
    <Section title="Shadow" action={cur
      ? <button className="mini" title="Remove the shadow" onClick={() => write(null)}>−</button>
      : <button className="mini" title="Add a drop shadow" onClick={() => write({ x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.35)' })}>+</button>}>
      {cur ? <>
        <Color color={col.color} alpha={col.alpha} onChange={(c, a) => write({ x, y, blur, color: toCss(c, a) })} />
        <div className="row">
          <Num label="X" value={x} onChange={(v) => write({ x: v, y, blur, color: colorStr })} />
          <Num label="Y" value={y} onChange={(v) => write({ x, y: v, blur, color: colorStr })} />
          <Num label="Blur" value={blur} min={0} onChange={(v) => write({ x, y, blur: v, color: colorStr })} />
        </div>
      </> : <p className="hint">No shadow. + adds one.</p>}
    </Section>
  )
}

function Help() {
  return (
    <Section title="How this works">
      <p className="hint">Each frame is one of the agent's HTML files, shown live. Click anything to select it and drag it anywhere, inside a frame or out onto the board. Grab a frame by its name or its background to move the whole frame. Double-click copy to retype it. Changes save into the file, and the agent sees exactly what you changed.</p>
      <dl className="keys">
        <dt>V / H</dt><dd>Move, pan</dd><dt>T</dt><dd>Add text</dd><dt>R / O</dt><dd>Add box, circle</dd><dt>C</dt><dd>Comment for the agent</dd>
        <dt>⌘ click</dt><dd>Select the exact element, even a background</dd><dt>⌫</dt><dd>Delete the element, or the frame</dd><dt>Esc</dt><dd>Select parent</dd><dt>Enter</dt><dd>Edit text</dd>
        <dt>⌘D</dt><dd>Duplicate</dd><dt>] / [</dt><dd>To front, to back</dd><dt>⇧1 / ⇧2</dt><dd>Fit all, fit selection</dd><dt>⌘Z</dt><dd>Undo</dd>
      </dl>
    </Section>
  )
}

export function Props() {
  const sel = useStore((s) => s.sel)
  useStore((s) => s.tick)
  if (!sel.design) return <aside className="panel right"><Help /></aside>
  const design = sel.design
  const els = sel.sids.map((s) => elOf(design, s)).filter(Boolean) as HTMLElement[]
  if (!els.length) return <aside className="panel right"><DesignPanel id={design} /><Help /></aside>

  const el = els[0]
  const cs = getComputedStyle(el)
  const d = get().designs[design]
  // X and Y are those of the whole selection, and a new value moves every piece by the same amount (they keep their spacing)
  // (measured afresh on every change: while a label is scrubbed, this render's numbers are already old)
  const corner = () => { const bs = els.map((e) => boxOf(design, e)); return { x: Math.round(Math.min(...bs.map((v) => v.x)) - d.x), y: Math.round(Math.min(...bs.map((v) => v.y)) - d.y) } }
  const at = corner()
  const st = (props: Record<string, string | null>) => style(design, els, props)
  const moveTo = (x: number | null, y: number | null) => { const c = corner(); for (const e of els) style(design, [e], moveProps(mover(e), x == null ? 0 : x - c.x, y == null ? 0 : y - c.y)) }
  const text = els.every(isTextLeaf)
  const page = isPage(design)
  const img = el.tagName === 'IMG'
  // some words selected while editing copy: the Text controls read and style just those words
  const part = text && els.length === 1 ? selectionHost(el) : null
  const tcs = part ? getComputedStyle(part) : cs
  const stT = (props: Record<string, string | null>) => { if (!styleSelection(el, props)) st(props) }
  const fg = cssColor(tcs.color)
  const bg = cssColor(cs.backgroundColor)
  const size = px(tcs.fontSize)
  const family = tcs.fontFamily.split(',')[0].replace(/["']/g, '').trim()
  const tracking = tcs.letterSpacing === 'normal' ? 0 : Math.round((parseFloat(tcs.letterSpacing) / size) * 1000) / 1000
  // of the block's own font size (not that of some selected words inside it); "normal" is about 1.2, a usable place to start stepping from
  const lh = cs.lineHeight === 'normal' ? 1.2 : Math.round((parseFloat(cs.lineHeight) / px(cs.fontSize)) * 100) / 100
  // a circle is border-radius:50%: show what that is in px, or one nudge would turn "50" into 51px and square it off
  const rad = cs.borderTopLeftRadius.includes('%') ? Math.round((parseFloat(cs.borderTopLeftRadius) / 100) * Math.min(px(cs.width), px(cs.height))) : px(cs.borderTopLeftRadius)
  const doc = docOf(design)
  const fonts = text && doc ? fontsOf(design, doc, tcs.fontFamily) : null
  const dots = paletteOf(doc)
  const rot = cs.rotate && cs.rotate !== 'none' ? parseFloat(cs.rotate) : 0
  const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none'
  const f = frames.get(design)
  const line = el.outerHTML.length

  return (
    <aside className="panel right">
      <Section title={els.length > 1 ? `${els.length} elements` : label(el)}>
        <div className="row tight">
          <Btn title="Select parent (Esc)" onClick={selectParent}><Icon name="chevron" /></Btn>
          <Btn title="Duplicate (⌘D)" onClick={duplicate}><Icon name="group" /></Btn>
          <Btn title="Delete" onClick={deleteSelection}><Icon name="x" /></Btn>
        </div>
        <div className="row tight layer-order">
          <Btn title="Bring to front ( ] )" onClick={() => zOrder('front')}>⤒ Front</Btn>
          <Btn title="Bring forward one ( ⌘] )" onClick={() => zOrder('forward')}>↑</Btn>
          <Btn title="Send backward one ( ⌘[ )" onClick={() => zOrder('backward')}>↓</Btn>
          <Btn title="Send to back ( [ )" onClick={() => zOrder('back')}>⤓ Back</Btn>
        </div>
        {el.className && typeof el.className === 'string' && <p className="hint">class: {el.className}</p>}
      </Section>

      <Section title="Position">
        {page ? <p className="hint">Drag it anywhere on the page. The agent folds your moves back into the layout.</p> : <div className="row">
          <Num label="X" value={at.x} onChange={(v) => moveTo(v, null)} />
          <Num label="Y" value={at.y} onChange={(v) => moveTo(null, v)} />
        </div>}
        <div className="row">
          <Num label="W" value={px(cs.width)} min={1} onChange={(v) => st({ width: `${v}px` })} />
          <Num label="H" value={px(cs.height)} min={1} onChange={(v) => st({ height: `${v}px` })} />
        </div>
        <div className="row">
          <Num label="Rotate" value={rot} suffix="°" onChange={(v) => st({ rotate: v ? `${v}deg` : null })} />
          <Num label="Radius" value={rad} min={0} onChange={(v) => st({ 'border-radius': `${v}px` })} />
        </div>
        <div className="row">
          <Num label="Opacity" value={Math.round(parseFloat(cs.opacity) * 100)} min={0} max={100} suffix="%" onChange={(v) => st({ opacity: v >= 100 ? null : String(v / 100) })} />
          <Num label="Layer" title="z-index: higher sits in front" value={parseInt(cs.zIndex) || 0} onChange={(v) => st({ 'z-index': String(Math.round(v)), ...(cs.position === 'static' ? { position: 'relative' } : {}) })} />
        </div>
      </Section>

      {text && (
        <Section title={part ? 'Text: selected words' : 'Text'}>
          {part && <p className="hint">Only the words you selected change. Click the copy again to keep typing, Esc when done.</p>}
          {!part && els.length === 1 && Array.from(el.querySelectorAll<HTMLElement>('*')).some((c) => c.textContent?.trim() && getComputedStyle(c).fontSize !== cs.fontSize) && <p className="hint">This block holds more than one text style. To change one part, double-click it and select the words first.</p>}
          <div className="row">
            <Select value={family} onChange={(v) => { if (v === '__custom') { const n = prompt('Font family (must be loaded by the file)'); if (n) stT({ 'font-family': `'${n.trim()}'` }) } else stT({ 'font-family': fonts ? fonts.stack(v) : `'${v}'` }) }}
              options={[...new Set([family, ...(fonts?.names || [])])].map((x) => ({ value: x, label: x })).concat([{ value: '__custom', label: 'Other font…' }])} />
          </div>
          <div className="row">
            {/* weight and italic in one list, the way Figma names styles: Regular, Regular Italic, Bold, Bold Italic… */}
            <Select title="Weight and italic" value={`${Number(tcs.fontWeight)}${tcs.fontStyle === 'italic' ? 'i' : ''}`} onChange={(v) => stT({ 'font-weight': String(parseInt(v)), 'font-style': v.endsWith('i') ? 'italic' : 'normal' })}
              options={[...new Set([Number(tcs.fontWeight), ...WEIGHTS.map((w) => w[0] as number)])].sort((a, b) => a - b).flatMap((w) => { const n = WEIGHTS.find((x) => x[0] === w)?.[1] || String(w); return [{ value: `${w}`, label: n }, { value: `${w}i`, label: `${n} Italic` }] })} />
            <Num label="Size" value={size} min={1} onChange={(v) => stT({ 'font-size': `${v}px` })} />
          </div>
          <div className="row">
            <Num label="Line" value={lh} min={0} step={0.01} title="Line height, as a multiple of the size" onChange={(v) => st({ 'line-height': v ? String(v) : null })} />
            <Num label="Track" value={tracking} step={0.005} suffix="em" title="Letter spacing" onChange={(v) => stT({ 'letter-spacing': `${v}em` })} />
          </div>
          <div className="row tight">
            {(['left', 'center', 'right'] as const).map((a) => <Btn key={a} title={`Align ${a}`} active={cs.textAlign === a || (a === 'left' && cs.textAlign === 'start')} onClick={() => st({ 'text-align': a })}><Icon name={{ left: 'textLeft', center: 'textCenter', right: 'textRight' }[a]} /></Btn>)}
            <Btn title="Italic" active={tcs.fontStyle === 'italic'} onClick={() => stT({ 'font-style': tcs.fontStyle === 'italic' ? 'normal' : 'italic' })}><i style={{ fontFamily: 'Georgia, serif', fontSize: 16, fontWeight: 700 }}>I</i></Btn>
            <Btn title="Uppercase" active={tcs.textTransform === 'uppercase'} onClick={() => stT({ 'text-transform': tcs.textTransform === 'uppercase' ? 'none' : 'uppercase' })}>AA</Btn>
          </div>
          <Color color={fg.color} alpha={fg.alpha} onChange={(c, a) => stT({ color: toCss(c, a) })} />
          <div className="brand">{dots.map(([n, c]) => <button key={n} title={`${n} text`} style={{ background: c }} onClick={() => stT({ color: c })} />)}</div>
        </Section>
      )}

      {img && (
        <Section title="Image">
          <AiButtons target={{ kind: 'el', design, sid: sidOf(el) }} />
          <button className="ghost" onClick={async () => { const file = await pickFile(); if (file) { try { setAttr(design, el, 'src', await upload(design, file, file.name)) } catch (e) { toast((e as Error).message) } } }}>Replace image</button>
          <div className="row">
            <Select value={cs.objectFit} onChange={(v) => st({ 'object-fit': v })} options={['fill', 'cover', 'contain', 'none', 'scale-down'].map((x) => ({ value: x, label: x }))} />
          </div>
          <p className="hint path">{el.getAttribute('src')?.slice(0, 120)}</p>
        </Section>
      )}

      {!img && el.tagName.toLowerCase() !== 'svg' && (
        <Section title="Background">
          <Color color={bg.color} alpha={bg.alpha} onChange={(c, a) => st({ 'background-color': toCss(c, a) })} />
          <div className="brand">{dots.map(([n, c]) => <button key={n} title={n} style={{ background: c }} onClick={() => st({ 'background-color': c })} />)}</div>
          {hasBgImage && <p className="hint">Also has an image or gradient: edit it under Inline CSS.</p>}
        </Section>
      )}

      {!page && (el.tagName.toLowerCase() === 'svg' ? <VectorPanel design={design} els={els} dots={dots} /> : <StrokePanel design={design} els={els} dots={dots} text={text} />)}
      {!page && <ShadowPanel design={design} els={els} />}
      {els.length === 1 && <InlineCss key={`${design}:${sel.sids[0]}:${line}`} design={design} el={el} />}
      {f && <ExportBox key={design} design={design} />}
    </aside>
  )
}
