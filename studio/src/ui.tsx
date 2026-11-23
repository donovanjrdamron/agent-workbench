import { useEffect, useRef, useState, type ReactNode } from 'react'

export const MIXED = Symbol('mixed')
export type Maybe<T> = T | typeof MIXED

// Two decimals, or as many as the field's step has (Track steps by 0.005).
const digitsOf = (step: number) => Math.max(2, (String(step).split('.')[1] || '').length)
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits

export function Num({ label, value, onChange, min, max, step = 1, title, suffix }: { label?: ReactNode; value: Maybe<number> | undefined; onChange: (v: number) => void; min?: number; max?: number; step?: number; title?: string; suffix?: string }) {
  const mixed = value === MIXED || value === undefined
  const digits = digitsOf(step)
  const shown = mixed ? '' : String(round(value as number, digits))
  const [text, setText] = useState(shown)
  const focused = useRef(false)
  const cancel = useRef(false) // Escape: a ref, because the blur it causes fires in the same tick
  useEffect(() => { if (!focused.current) setText(shown) }, [shown])
  const clamp = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v))
  const push = (raw: string) => {
    // allow simple math like "1080/2" or "+20"
    let v = NaN
    const cur = mixed ? 0 : (value as number)
    const t = raw.trim().replace(/[^0-9+\-*/.() ]/g, '')
    try { v = /^[+\-*/]/.test(t) && !/^-?\d*\.?\d+$/.test(t) ? Function(`return (${cur}${t})`)() : Function(`return (${t})`)() } catch { v = NaN }
    if (Number.isFinite(v)) onChange(clamp(v))
  }
  const scrub = (e: React.PointerEvent) => {
    if (mixed) return
    const start = value as number
    const x0 = e.clientX
    let moved = false
    const move = (ev: PointerEvent) => { const d = ev.clientX - x0; if (Math.abs(d) > 2) moved = true; if (moved) onChange(clamp(round(start + d * step, digits))) }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <label className="num" title={title}>
      {label != null && <span className="num-label" onPointerDown={scrub}>{label}</span>}
      <input
        value={text}
        placeholder={mixed ? 'Mixed' : ''}
        onFocus={(e) => { focused.current = true; e.target.select() }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false
          if (!cancel.current && text !== '' && text !== shown) push(text)
          cancel.current = false
          // back to the real value: if the entry was rejected, clamped or rounded, the field must not keep showing what was
          // typed (when it did change, the effect above puts the new value in on the next render)
          setText(shown)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel.current = true // the window's key handler blurs the field next: drop what was typed
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * step
            const v = clamp(round((mixed ? 0 : (value as number)) + d, digits))
            setText(String(v)); onChange(v)
          }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </label>
  )
}

export function Color({ color, alpha, onChange }: { color: string; alpha: number; onChange: (color: string, alpha: number) => void }) {
  const [hex, setHex] = useState(color.replace('#', '').toUpperCase())
  useEffect(() => setHex(color.replace('#', '').toUpperCase()), [color])
  const cancel = useRef(false)
  const typed = useRef(false) // only a hex the user actually typed is applied: clicking into the field and out again changes nothing
  const full = /^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'
  // Picking a colour for something fully transparent (no background yet) means "make it this colour", not "this colour at 0%".
  const solid = alpha === 0 ? 1 : alpha
  return (
    <div className="color">
      <label className="swatch" style={{ background: color }}>
        <input type="color" value={full} onChange={(e) => onChange(e.target.value, solid)} />
      </label>
      <input
        className="hex" value={hex} spellCheck={false}
        onFocus={(e) => e.target.select()}
        onChange={(e) => { typed.current = true; setHex(e.target.value) }}
        onBlur={() => {
          let h = hex.replace('#', '').trim()
          if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('')
          if (!cancel.current && typed.current && /^[0-9a-f]{6}$/i.test(h)) onChange('#' + h.toLowerCase(), solid)
          else setHex(color.replace('#', '').toUpperCase())
          cancel.current = typed.current = false
        }}
        onKeyDown={(e) => { if (e.key === 'Escape') cancel.current = true; if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <Num value={Math.round(alpha * 100)} min={0} max={100} suffix="%" onChange={(v) => onChange(color, v / 100)} />
    </div>
  )
}

export function Select<T extends string | number>({ value, options, onChange, title }: { value: Maybe<T> | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void; title?: string }) {
  const mixed = value === MIXED || value === undefined
  return (
    <select className="select" title={title} value={mixed ? '__mixed' : String(value)} onChange={(e) => { const o = options.find((o) => String(o.value) === e.target.value); e.currentTarget.blur(); /* or ⌘Z and the arrow keys keep going to this list */ if (o) onChange(o.value) }}>
      {mixed && <option value="__mixed">Mixed</option>}
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  )
}

export function Btn({ children, onClick, title, active, disabled }: { children: ReactNode; onClick?: () => void; title?: string; active?: boolean; disabled?: boolean }) {
  return <button className={`btn${active ? ' active' : ''}`} title={title} disabled={disabled} onClick={onClick} onPointerDown={(e) => e.preventDefault()}>{children}</button>
}

export function Section({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="section">
      <header><h4>{title}</h4>{action}</header>
      {children}
    </section>
  )
}

// Plain line icons drawn for this app.
const P: Record<string, ReactNode> = {
  move: <path d="M4 3l9 4.5-3.8 1.2L8 12.5z" />,
  hand: <path d="M5.5 8V4.2a1 1 0 012 0V7m0 0V3.2a1 1 0 012 0V7m0 0V4a1 1 0 012 0v5.5c0 2.2-1.6 3.5-3.6 3.5S4.6 12 3.8 10.4L2.9 8.6c-.4-.9.7-1.6 1.4-.9L5.5 9" />,
  frame: <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />,
  rect: <rect x="3" y="3" width="10" height="10" rx="1" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  line: <path d="M3 13L13 3" />,
  text: <path d="M3.5 4V3h9v1M8 3v10M6.5 13h3" />,
  image: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1" /><path d="M3 11.5l3.2-3 2.3 2 1.8-1.5 2.7 2.5" /></>,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></>,
  eyeOff: <path d="M2 2l12 12M6.2 4A6.6 6.6 0 018 3.5C12 3.5 14.5 8 14.5 8a11 11 0 01-2 2.5M9.9 12.1A6 6 0 018 12.5C4 12.5 1.5 8 1.5 8a11 11 0 012.6-3" />,
  lock: <><rect x="4" y="7.5" width="8" height="6" rx="1" /><path d="M5.5 7.5V5.5a2.5 2.5 0 015 0v2" /></>,
  unlock: <><rect x="4" y="7.5" width="8" height="6" rx="1" /><path d="M5.5 7.5V5.5a2.5 2.5 0 014.8-1" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  step: <><rect x="1.5" y="4.5" width="5.5" height="7" rx="1.2" /><rect x="9" y="4.5" width="5.5" height="7" rx="1.2" /><path d="M7 8h2" /></>,
  section: <><path d="M2.5 5V3.5a1 1 0 011-1H6M10 2.5h2.5a1 1 0 011 1V5M13.5 11v1.5a1 1 0 01-1 1H10M6 13.5H3.5a1 1 0 01-1-1V11" /><path d="M5 6h4" /></>,
  media: <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M6.5 6v4l3.5-2z" /></>,
  link: <path d="M7 9a2.8 2.8 0 004 0l2-2a2.8 2.8 0 00-4-4l-.8.8M9 7a2.8 2.8 0 00-4 0l-2 2a2.8 2.8 0 004 4l.8-.8" />,
  minus: <path d="M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  scale: <><path d="M3 13V8M3 13h5M3 13l5-5" /><path d="M9 3h4v4" /><path d="M13 3L9.5 6.5" /></>,
  group: <><rect x="2.5" y="2.5" width="6" height="6" rx="1" /><rect x="7.5" y="7.5" width="6" height="6" rx="1" /></>,
  undo: <path d="M5.5 3L2.5 6l3 3M2.5 6H10a3.5 3.5 0 010 7H7" />,
  redo: <path d="M10.5 3l3 3-3 3M13.5 6H6a3.5 3.5 0 000 7h3" />,
  alignLeft: <path d="M2.5 2v12M5 5h7M5 10h4.5" />,
  alignH: <path d="M8 2v12M4 5h8M5.5 10h5" />,
  alignRight: <path d="M13.5 2v12M4 5h7M6.5 10H11" />,
  alignTop: <path d="M2 2.5h12M5 5v7M10 5v4.5" />,
  alignV: <path d="M2 8h12M5 4v8M10 5.5v5" />,
  alignBottom: <path d="M2 13.5h12M5 4v7M10 6.5V11" />,
  distH: <path d="M2.5 2v12M13.5 2v12M6.5 5v6h3V5z" />,
  distV: <path d="M2 2.5h12M2 13.5h12M5 6.5h6v3H5z" />,
  textLeft: <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />,
  textCenter: <path d="M2.5 4h11M4.5 8h7M3.5 12h9" />,
  textRight: <path d="M2.5 4h11M6.5 8h7M4.5 12h9" />,
  safe: <><rect x="4" y="1.5" width="8" height="13" rx="1.5" /><path d="M4 4.5h8M4 11.5h8" /></>,
  pen: <path d="M3 13l1-4 6.5-6.5a1.4 1.4 0 012 2L6 11zM9.5 3.5l3 3" />,
  note: <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />,
  component: <path d="M8 2l2.2 2.2L8 6.4 5.8 4.2zM11.8 5.8L14 8l-2.2 2.2L9.6 8zM4.2 5.8L6.4 8l-2.2 2.2L2 8zM8 9.6l2.2 2.2L8 14l-2.2-2.2z" />,
  instance: <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />,
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{P[name]}</svg>
}
