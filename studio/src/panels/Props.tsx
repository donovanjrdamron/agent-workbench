import { useEffect, useRef, useState } from 'react'
import { deleteSelection, duplicate, finishEditing, flush, moveProps, mover, removeDesign, revert, selectParent, selectionHost, setAttr, style, styleSelection, zOrder } from '../commands'
import { boxOf, cssColor, docOf, elOf, frames, isPage, isTextLeaf, label, toCss } from '../dom'
import { exportDesign, saveLayout, settled, upload } from '../net'
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

function DesignPanel({ id }: { id: string }) {
  const d = useStore((s) => s.designs[id])
  const root = useStore((s) => s.root)
  if (!d) return null
  const page = frames.get(id) ? !frames.get(id)!.art : false
  return (
    <>
      <Section title="Design">
        <p className="hint path">{root}/{id}</p>
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
      <ExportBox design={id} />
    </>
  )
}

function Help() {
  return (
    <Section title="How this works">
      <p className="hint">Each frame is one of the agent's HTML files, shown live. Click a frame to select it and drag to move it. Click again to select something inside, then move, resize or restyle it. Double-click copy to retype it. Changes save into the file, and the agent sees exactly what you changed.</p>
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
        {page ? <p className="hint">Position comes from the layout here, so it cannot be dragged.</p> : <div className="row">
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
          <button className="ghost" onClick={async () => { const file = await pickFile(); if (file) { try { setAttr(design, el, 'src', await upload(design, file, file.name)) } catch (e) { toast((e as Error).message) } } }}>Replace image</button>
          <div className="row">
            <Select value={cs.objectFit} onChange={(v) => st({ 'object-fit': v })} options={['fill', 'cover', 'contain', 'none', 'scale-down'].map((x) => ({ value: x, label: x }))} />
          </div>
          <p className="hint path">{el.getAttribute('src')?.slice(0, 120)}</p>
        </Section>
      )}

      {!img && (
        <Section title="Background">
          <Color color={bg.color} alpha={bg.alpha} onChange={(c, a) => st({ 'background-color': toCss(c, a) })} />
          <div className="brand">{dots.map(([n, c]) => <button key={n} title={n} style={{ background: c }} onClick={() => st({ 'background-color': c })} />)}</div>
          {hasBgImage && <p className="hint">Also has an image or gradient: edit it under Inline CSS.</p>}
        </Section>
      )}

      {els.length === 1 && <InlineCss key={`${design}:${sel.sids[0]}:${line}`} design={design} el={el} />}
      {f && <ExportBox key={design} design={design} />}
    </aside>
  )
}
