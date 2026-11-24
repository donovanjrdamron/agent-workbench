// The Grade panel: a brand preset and every knob that goes into it, shown live on the picture while you drag.
import { useState } from 'react'
import { applyGrade, closeGrade, deletePreset, pickPreset, savePreset, setGrade, useGrade, type Grade } from '../grade'
import { Spinner } from './Agent'

type Num = Exclude<keyof Grade, 'shadow' | 'mid' | 'high' | 'grade'>
const SLIDERS: { k: Num; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }[] = [
  { k: 'intensity', label: 'Strength', min: 0, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { k: 'contrast', label: 'Contrast', min: -0.2, max: 0.5, step: 0.01 },
  { k: 'grain', label: 'Grain', min: 0, max: 30, step: 0.5 },
  { k: 'vignette', label: 'Vignette', min: 0, max: 0.6, step: 0.01 },
  { k: 'halation', label: 'Halation', min: 0, max: 1, step: 0.01 },
]
const SAT: { k: Num; label: string; dot: string }[] = [
  { k: 'reds', label: 'Reds', dot: '#e5484d' }, { k: 'blues', label: 'Blues', dot: '#3e8ef7' }, { k: 'greens', label: 'Greens', dot: '#46a758' },
]
const TONES: { k: 'shadow' | 'mid' | 'high'; label: string }[] = [{ k: 'shadow', label: 'Shadows' }, { k: 'mid', label: 'Midtones' }, { k: 'high', label: 'Highlights' }]
const RGB = ['#e5484d', '#46a758', '#3e8ef7']
const fix = (v: number) => (Math.abs(v) < 1 ? v.toFixed(2) : String(Math.round(v * 10) / 10))

function Row({ label, value, min, max, step, onChange, fmt, dot }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string; dot?: string }) {
  return (
    <label className="gr-row">
      <span className="gr-l">{dot && <i style={{ background: dot }} />}{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="gr-v">{fmt ? fmt(value) : fix(value)}</span>
    </label>
  )
}

export function GradePanel() {
  const { target, g, presets, preset, busy, previewing } = useGrade()
  const [tones, setTones] = useState(false)
  if (!target || !g) return null
  const changed = JSON.stringify(g) !== JSON.stringify(presets[preset])
  const on = g.grade !== false
  return (
    <aside className="gr-panel" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="gr-head">
        <b>Brand grade</b>{previewing && <Spinner />}
        <button className="ag-btn" onClick={closeGrade} title="Cancel (Esc)">✕</button>
      </div>
      <div className="gr-body">
        <div className="gr-preset">
          <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
            {Object.keys(presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {changed && <span className="gr-mod" title="You changed this preset's settings">edited</span>}
        </div>
        <label className="gr-toggle"><input type="checkbox" checked={on} onChange={(e) => setGrade({ grade: e.target.checked })} />Colour grade <span>(off: only strip the metadata)</span></label>
        <div className={on ? '' : 'gr-off'}>
          {SLIDERS.map((s) => <Row key={s.k} label={s.label} value={g[s.k] as number} min={s.min} max={s.max} step={s.step} fmt={s.fmt} onChange={(v) => setGrade({ [s.k]: v })} />)}
          <div className="gr-h">Saturation</div>
          {SAT.map((s) => <Row key={s.k} label={s.label} dot={s.dot} value={g[s.k] as number} min={0} max={2} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setGrade({ [s.k]: v })} />)}
          <button className="gr-h gr-fold" onClick={() => setTones((t) => !t)}>{tones ? '▾' : '▸'} Tone colour (shadows · midtones · highlights)</button>
          {tones && TONES.map((t) => (
            <div key={t.k} className="gr-tone">
              <div className="gr-tl">{t.label}</div>
              {['R', 'G', 'B'].map((c, i) => <Row key={c} label={c} dot={RGB[i]} value={g[t.k][i]} min={-20} max={20} step={0.5} onChange={(v) => { const n = [...g[t.k]] as [number, number, number]; n[i] = v; setGrade({ [t.k]: n }) }} />)}
            </div>
          ))}
        </div>
        <p className="gr-note">Applying saves a new full-size copy with no metadata. The original stays in the folder; ⌘Z puts it back.</p>
      </div>
      <div className="gr-foot">
        <button className="gr-link" onClick={() => { const n = prompt('Save these settings as a preset named:', changed ? `${preset} (custom)` : preset); if (n) savePreset(n) }}>Save preset…</button>
        {changed && <button className="gr-link" onClick={() => pickPreset(preset)}>Reset</button>}
        {!changed && Object.keys(presets).length > 1 && <button className="gr-link del" onClick={() => { if (confirm(`Delete the preset "${preset}"?`)) deletePreset(preset) }}>Delete preset</button>}
        <span style={{ flex: 1 }} />
        <button className="gr-apply" disabled={busy} onClick={applyGrade}>{busy ? <><Spinner /> Applying…</> : 'Apply'}</button>
      </div>
    </aside>
  )
}
