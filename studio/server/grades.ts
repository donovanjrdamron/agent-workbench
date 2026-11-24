// Brand grades for pictures: presets (kept in Studio's state folder, editable from the Grade panel) and the runner.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Grade {
  intensity: number; contrast: number; grain: number; vignette: number; halation: number
  reds: number; blues: number; greens: number
  shadow: [number, number, number]; mid: [number, number, number]; high: [number, number, number]
  grade?: boolean // false: strip metadata only
}
export type Presets = Record<string, Grade>

const BICENTENNIAL: Omit<Grade, 'grain'> = { intensity: 1.01, contrast: 0.15, vignette: 0, halation: 0, reds: 1.25, blues: 1.15, greens: 0.75, shadow: [4, 0, -2], mid: [6, 2, -4], high: [4, 2, -2] }
/** The presets a fresh Studio starts with; yours are saved next to the boards (grades.json). */
export const DEFAULT_PRESETS: Presets = {
  'Bicentennial · fine grain': { ...BICENTENNIAL, grain: 7 },
  'Bicentennial · 35mm grain': { ...BICENTENNIAL, grain: 13 },
  'Clean · strip metadata only': { ...BICENTENNIAL, grain: 0, grade: false },
}

export function loadPresets(stateDir: string): Presets {
  try { const p = JSON.parse(fs.readFileSync(path.join(stateDir, 'grades.json'), 'utf8')); if (p && typeof p === 'object' && Object.keys(p).length) return p } catch { /* first run */ }
  return DEFAULT_PRESETS
}
export function savePresets(stateDir: string, p: Presets) {
  const f = path.join(stateDir, 'grades.json')
  fs.writeFileSync(f + '.tmp', JSON.stringify(p, null, 1)); fs.renameSync(f + '.tmp', f)
}

const PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grade.py') // (a real path: the folder name may have spaces)
/** Grade a picture. `max`: a quick preview no bigger than that; `fullw`: the full picture's width (keeps the grain's look in a preview). */
export function runGrade(image: Buffer, g: Grade & { max?: number; fullw?: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = execFile(process.env.STUDIO_PYTHON || 'python3', [PY, JSON.stringify(g)], { encoding: 'buffer', maxBuffer: 400 * 1024 * 1024, timeout: 120_000 }, (err, out, errOut) => {
      if (err) return reject(new Error(/No module named/.test(String(errOut)) ? 'The grade needs Python with numpy and Pillow: pip3 install numpy pillow' : String(errOut).trim().split('\n').pop() || err.message))
      resolve(out as unknown as Buffer)
    })
    p.stdin?.end(image)
  })
}
