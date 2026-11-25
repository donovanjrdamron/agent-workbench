// Studio server. A board is a folder of HTML designs. The HTML files are the truth:
// the editor shows them live, writes small edits back into them, and logs who changed what.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer as createVite } from 'vite'
import { annotate, applyEdits, describe, indexHtml, lint, oneTagPerLine, outline } from './html'
import { SIZES, type Board, type Comment, type Design, type Edit, type Item } from '../shared/types'
import { planOf } from './plan'
import { AiError, runAi, sizeOf, type AiOp } from './ai'
import { loadPresets, runGrade, savePresets, type Grade, type Presets } from './grades'
import * as hfmcp from './hfmcp'

const PORT = Number(process.env.STUDIO_PORT || 4517)
// A loaded board nobody has looked at or called for this long is dropped from memory (see `sweep`).
const IDLE = Number(process.env.STUDIO_IDLE_MS || 3 * 60 * 1000)
const HOME = os.homedir()
// The editor's own state (board list, layouts, baselines, version history) lives on the local
// disk, never in a cloud-synced folder: those can hand back files slowly or not at all.
const ROOT = process.env.STUDIO_DIR || path.join(HOME, 'Library/Application Support/Studio')
const EXPORTS = process.env.STUDIO_EXPORTS || path.join(ROOT, 'exports')
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
fs.mkdirSync(path.join(ROOT, 'boards'), { recursive: true })

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }
const hash = (t: string) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 10)
const tilde = (p: string) => path.resolve(p.replace(/^~(?=\/|$)/, HOME))

// ---------- registry ----------
/** `closed`: put away. Still listed, never loaded or scanned until something asks for it by name. */
interface Reg { name: string; root: string; closed?: boolean; permanent?: boolean } // permanent: one board per brand and kind of work, a section per task
const regPath = path.join(ROOT, 'boards.json')
const readReg = (): Reg[] => (fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : [])
const writeReg = (r: Reg[]) => fs.writeFileSync(regPath, JSON.stringify(r, null, 1))
/** Boards merged into a permanent board: the old name still works and points at its folder there. ROOT/aliases.json */
const aliasPath = path.join(ROOT, 'aliases.json')
const aliases = (): Record<string, { board: string; folder: string }> => { try { return JSON.parse(fs.readFileSync(aliasPath, 'utf8')) } catch { return {} } }
const aliasOf = (name: string) => { const a = aliases()[name]; return a && !readReg().some((r) => r.name === name) ? a : null }
const safeName = (n: string) => /^[\w .()&,-]{1,80}$/.test(n) && !n.startsWith('.')

interface Layout { x: number; y: number; w: number; h: number; width?: number; title?: string }
/** `seen`: the rev of each design as the server last saw it, so a file changed while Studio was closed is not mistaken for hand edits. */
interface State { designs: Record<string, Layout>; comments: Comment[]; seen?: Record<string, string>; items?: Item[]; slices?: Record<string, Slice[]> }
/** A slice: a part of a design exported as its own picture (emails are rebuilt in Klaviyo from these). Artboard coordinates. */
interface Slice { id: string; name: string; x: number; y: number; w: number; h: number }
interface Src { text: string; rev: string; mtime: number; size: number }
/** One undo step. null means the file did not exist on that side. */
/** `group`: steps that belong to one action (a piece dragged from one file to another) and are undone together. */
interface Hist { design: string; before: string | null; after: string | null; group?: string; layout?: Layout; moves?: { id: string; from: { x: number; y: number }; to: { x: number; y: number } }[]; ts?: number; items?: { before: Item[]; after: Item[] }; key?: string }
interface Rt {
  name: string
  root: string
  dir: string // where this board's own state lives
  state: State
  src: Map<string, Src>
  clients: Set<WebSocket>
  undo: Hist[]
  redo: Hist[]
  baseRev: Map<string, string>
  saveTimer: NodeJS.Timeout | null
  scanning: boolean
  used: number // when it was last asked for
  busy: number // requests still working on it
}
const boards = new Map<string, Rt>()
let presence: { board: string; design: string | null; sids: number[]; at: number } | null = null

const LOOSE = 'loose'
const isLoose = (id: string) => id.startsWith(LOOSE + '/') || id.split('/')[1] === LOOSE // (a task folder's own loose/ on a permanent board)
const SKIP_DIRS = new Set(['node_modules', 'shared', 'final', 'studio-assets', 'html-archive'])
function listHtml(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    // a folder with ads/ in it (the board's own folder, or a task's folder on a permanent board) keeps its designs
    // there, plus pieces left on the board outside any frame (loose/). Everything else beside them is working files.
    if (depth <= 1 && entries.some((e) => e.isDirectory() && e.name === 'ads')) {
      for (const sub of ['ads', LOOSE]) if (entries.some((e) => e.isDirectory() && e.name === sub)) walk(rel ? `${rel}/${sub}` : sub, depth + 1)
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (depth < 5 && !SKIP_DIRS.has(e.name)) walk(p, depth + 1) }
      else if (e.name.toLowerCase().endsWith('.html')) out.push(p)
    }
  }
  walk('', 0)
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

const basePath = (rt: Rt, id: string) => path.join(rt.dir, 'base', id)
function setBase(rt: Rt, id: string, text: string) {
  fs.mkdirSync(path.dirname(basePath(rt, id)), { recursive: true })
  fs.writeFileSync(basePath(rt, id), text)
  rt.baseRev.set(id, hash(text))
}
function baseRevOf(rt: Rt, id: string): string | null {
  if (!rt.baseRev.has(id) && fs.existsSync(basePath(rt, id))) rt.baseRev.set(id, hash(fs.readFileSync(basePath(rt, id), 'utf8')))
  return rt.baseRev.get(id) ?? null
}

/** Keep a copy of every version of a design the server has seen, so nothing is ever lost. */
const versionsDir = (rt: Rt, id: string) => path.join(rt.dir, 'versions', id)
function snapshot(rt: Rt, id: string, text: string | null | undefined, why: string) {
  if (!text) return
  const dir = versionsDir(rt, id)
  fs.mkdirSync(dir, { recursive: true })
  const have = fs.readdirSync(dir).sort()
  if (have.length && have[have.length - 1].includes(`-${hash(text)}-`)) return
  fs.writeFileSync(path.join(dir, `${Date.now()}-${hash(text)}-${why}.html`), text)
  for (const old of have.slice(0, Math.max(0, have.length - 80))) fs.rmSync(path.join(dir, old), { force: true })
}
function listVersions(rt: Rt, id: string) {
  const dir = versionsDir(rt, id)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort().map((f, i) => { const [ts, rev, why] = f.replace(/\.html$/, '').split('-'); return { n: i + 1, ts: Number(ts), rev, why, bytes: fs.statSync(path.join(dir, f)).size, file: path.join(dir, f) } })
}
const writeState = (rt: Rt) => fs.writeFileSync(path.join(rt.dir, 'state.json'), JSON.stringify(rt.state, null, 1))
function saveState(rt: Rt) {
  if (rt.saveTimer) clearTimeout(rt.saveTimer)
  rt.saveTimer = setTimeout(() => { rt.saveTimer = null; writeState(rt) }, 300)
}
/** A save still waiting on its timer is written now. */
function flush(rt: Rt) {
  if (rt.saveTimer) { clearTimeout(rt.saveTimer); rt.saveTimer = null; writeState(rt) }
}
/** The board as plain language for agents (plan.md beside state.json). */
function writePlan(rt: Rt) {
  try { fs.writeFileSync(path.join(rt.dir, 'plan.md'), planOf(rt.name, rt.root, payload(rt))) } catch (e) { console.error('plan.md:', (e as Error).message) }
}
const rangeOf = (res: http.ServerResponse) => (res.req as http.IncomingMessage | undefined)?.headers.range
function log(rt: Rt, by: string, design: string, notes: string[]) {
  if (notes.length) fs.appendFileSync(path.join(rt.dir, 'changes.jsonl'), JSON.stringify({ ts: Date.now(), by, design, notes }) + '\n')
}
function broadcast(rt: Rt, msg: unknown) {
  const text = JSON.stringify(msg)
  for (const c of rt.clients) if (c.readyState === 1) c.send(text)
}

/**
 * A board organised in sections (the permanent boards): every top folder is one task, drawn inside a section of the
 * same name. A new file goes beside the others in its folder; the first file of a new folder starts a new row below
 * everything, with its own section. Real sizes arrive later (the editor measures), so sections grow then too.
 */
function placeInSection(rt: Rt, id: string): Layout | null {
  const top = id.includes('/') ? id.split('/')[0] : ''
  const all = Object.entries(rt.state.designs)
  const perm = !!readReg().find((r) => r.name === rt.name)?.permanent
  if (!top || !(perm || (all.length && (rt.state.items || []).some((i) => i.kind === 'section')))) return null
  const sibs = all.filter(([k]) => k.startsWith(top + '/')).map(([, d]) => d)
  const w = 1080, h = /9x16/i.test(id) ? 1920 : 1350
  if (sibs.length) {
    const lastY = Math.max(...sibs.map((d) => d.y)), row = sibs.filter((d) => d.y === lastY), x0 = Math.min(...sibs.map((d) => d.x))
    const x = Math.max(...row.map((d) => d.x + d.w)) + 100
    return x + w - x0 > 8 * 1180 ? { x: x0, y: Math.max(...sibs.map((d) => d.y + d.h)) + 200, w, h } : { x, y: lastY, w, h }
  }
  const boxes = [...all.map(([, d]) => d), ...(rt.state.items || []).filter((i) => i.kind !== 'arrow')]
  if (!boxes.length) return { x: 300, y: 300, w, h }
  return { x: Math.min(...boxes.map((b) => b.x)) + 300, y: Math.max(...boxes.map((b) => b.y + b.h)) + 1100, w, h }
}
/** Grow (never shrink) the section named after a design's folder so it holds the design. Makes it if missing. */
function fitSection(rt: Rt, id: string): boolean {
  const top = id.includes('/') ? id.split('/')[0] : '', d = rt.state.designs[id]
  if (!top || !d || !(readReg().find((r) => r.name === rt.name)?.permanent || rt.state.items?.some((i) => i.kind === 'section'))) return false
  rt.state.items ??= []
  const items = rt.state.items
  const PAD = 300
  let s = items.find((i) => i.kind === 'section' && i.text === top)
  if (!s) { s = { id: 'sec_' + crypto.randomBytes(3).toString('hex'), kind: 'section', text: top, x: d.x - PAD, y: d.y - PAD, w: d.w + 2 * PAD, h: d.h + 2 * PAD } as Item; items.unshift(s); return true } // (first: drawn under everything)
  const x0 = Math.min(s.x, d.x - PAD), y0 = Math.min(s.y, d.y - PAD), x1 = Math.max(s.x + s.w, d.x + d.w + PAD), y1 = Math.max(s.y + s.h, d.y + d.h + PAD)
  if (x0 === s.x && y0 === s.y && x1 === s.x + s.w && y1 === s.y + s.h) return false
  Object.assign(s, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  return true
}

/** First free slot on a loose grid. Real sizes arrive once the editor has rendered the file. */
function place(rt: Rt, id: string): Layout {
  const sec = placeInSection(rt, id)
  if (sec) { rt.state.designs[id] = sec; fitSection(rt, id); return sec }
  const CW = 1180, CH = 2120, COLS = 8
  const taken = new Set(Object.values(rt.state.designs).map((d) => `${Math.round(d.x / CW)},${Math.round(d.y / CH)}`))
  const tall = /9x16/i.test(id)
  for (let i = 0; ; i++) {
    const key = `${i % COLS},${Math.floor(i / COLS)}`
    if (!taken.has(key)) return { x: (i % COLS) * CW, y: Math.floor(i / COLS) * CH, w: 1080, h: tall ? 1920 : 1350 }
  }
}

/** Sync with the folder. Files changed outside the editor are the agent's edits. */
/** Read with a time limit, so one file a sync service is slow to deliver cannot stall everything. */
function readText(abs: string, ms = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    fsp.readFile(abs, 'utf8').then((x) => { clearTimeout(t); resolve(x) }, () => { clearTimeout(t); resolve(null) })
  })
}

/** `force`: files this server has just written itself, taken in at once (and after any scan already running). */
async function scan(rt: Rt, first = false, force?: Set<string>) {
  if (rt.scanning) { if (!force) return; while (rt.scanning) await new Promise((r) => setTimeout(r, 25)) }
  rt.scanning = true
  try { await scanOnce(rt, first, force) } finally { rt.scanning = false }
}

/** Take in a version of a design, and remember its rev across restarts. */
function put(rt: Rt, id: string, text: string, st: fs.Stats) {
  const rev = hash(text)
  rt.src.set(id, { text, rev, mtime: st.mtimeMs, size: st.size })
  if (rt.state.seen?.[id] !== rev) { (rt.state.seen ??= {})[id] = rev; saveState(rt) }
}

/** The file changed on disk outside the editor: that is the agent's new version. The old one is kept as a version. */
function external(rt: Rt, id: string, old: string, text: string, st: fs.Stats) {
  snapshot(rt, id, old, 'before external edit')
  put(rt, id, text, st)
  setBase(rt, id, text)
  rt.undo = rt.undo.filter((u) => u.design !== id)
  rt.redo = rt.redo.filter((u) => u.design !== id)
  log(rt, 'agent', id, ['file edited on disk'])
  broadcast(rt, { type: 'design', design: designOf(rt, id), reload: true })
}

/**
 * Call before anything writes a design. The scan only runs every 2s, so the agent may have saved the file since:
 * writing our cached copy back would silently throw that save away. Throws when the write must not go ahead.
 */
function fresh(rt: Rt, id: string) {
  const cur = rt.src.get(id)
  if (!cur) return
  const abs = path.join(rt.root, id)
  let st: fs.Stats
  try { st = fs.statSync(abs) } catch { return } // gone from disk: the write puts it back
  if (st.mtimeMs === cur.mtime && st.size === cur.size) return
  let text: string | null = null
  try { text = fs.readFileSync(abs, 'utf8') } catch { /* not readable right now */ }
  if (text !== null && text === cur.text) { cur.mtime = st.mtimeMs; cur.size = st.size; return }
  // empty or still being written: never take that in as a version, and never write over it either
  if (!text || Date.now() - st.mtimeMs < 900) throw new HttpError(409, 'the agent is saving this design, try again')
  external(rt, id, cur.text, text, st)
  throw new HttpError(409, 'the agent just changed this design, reloaded')
}

async function scanOnce(rt: Rt, first: boolean, force?: Set<string>) {
  const files = listHtml(rt.root)
  const seen = new Set(files)
  let listChanged = false
  for (const id of files) {
    const abs = path.join(rt.root, id)
    let st: fs.Stats
    try { st = await fsp.stat(abs) } catch { continue }
    const known = rt.src.get(id)
    if (known && known.mtime === st.mtimeMs && known.size === st.size) continue
    // A file mid-write can look empty or cut short. Wait until it has been still for a moment.
    if (st.size === 0 || (!first && !force?.has(id) && Date.now() - st.mtimeMs < 900)) continue
    const text = await readText(abs)
    if (text === null || (text === '' && st.size > 0)) continue // not available right now, try again next pass
    const cur = rt.src.get(id)
    if (cur && cur.text === text) { cur.mtime = st.mtimeMs; cur.size = st.size; continue }
    if (cur !== known) continue // an edit landed while the file was being read, so what was read may be stale: look again next pass
    if (cur) { external(rt, id, cur.text, text, st); continue }
    const last = rt.state.seen?.[id]
    put(rt, id, text, st)
    if (!rt.state.designs[id]) { rt.state.designs[id] = place(rt, id); saveState(rt) }
    listChanged = true
    if (!fs.existsSync(basePath(rt, id))) setBase(rt, id, text)
    else if (first && last && last !== hash(text)) {
      // changed while Studio was not running: nobody edits by hand then, so this is the agent's new version
      snapshot(rt, id, fs.readFileSync(basePath(rt, id), 'utf8'), 'before external edit')
      setBase(rt, id, text)
      log(rt, 'agent', id, ['file edited on disk (while Studio was closed)'])
    }
    if (!first) log(rt, 'agent', id, ['new design file'])
  }
  for (const id of [...rt.src.keys()]) if (!seen.has(id)) { rt.src.delete(id); listChanged = true }
  if (listChanged && !first) broadcast(rt, { type: 'board', board: payload(rt) })
}

const loading = new Map<string, Promise<Rt>>()
function load(name: string): Promise<Rt> {
  name = aliasOf(name)?.board || name
  const hit = boards.get(name)
  if (hit) { hit.used = Date.now(); return Promise.resolve(hit) }
  let p = loading.get(name)
  if (!p) { p = loadNew(name).finally(() => loading.delete(name)); loading.set(name, p) }
  return p
}
async function loadNew(name: string): Promise<Rt> {
  const reg = readReg().find((r) => r.name === name)
  if (!reg) throw new HttpError(404, `no such board: ${name}. See: studio boards`)
  if (!fs.existsSync(reg.root)) throw new HttpError(404, `board folder is missing: ${reg.root}`)
  const dir = path.join(ROOT, 'boards', name)
  fs.mkdirSync(dir, { recursive: true })
  const sp = path.join(dir, 'state.json')
  const state: State = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : { designs: {}, comments: [] }
  const rt: Rt = { name, root: reg.root, dir, state, src: new Map(), clients: new Set(), undo: [], redo: [], saveTimer: null, baseRev: new Map(), scanning: false, used: Date.now(), busy: 0 }
  await scan(rt, true)
  boards.set(name, rt)
  return rt
}
/**
 * Every 2s each loaded board's folder is scanned. A board with no editor tab on it and no call for IDLE is
 * dropped from memory instead, so its folder is left alone. Nothing is lost: designs and versions are files,
 * the pending state save is written first, and the next use loads the board again (only undo history goes).
 */
const idle = (rt: Rt) => !rt.clients.size && !rt.busy && !rt.scanning && Date.now() - rt.used > IDLE
function unload(rt: Rt) { flush(rt); boards.delete(rt.name) }
function sweep() {
  for (const rt of [...boards.values()]) {
    if (idle(rt)) unload(rt)
    else scan(rt).catch((e) => console.error('scan failed:', (e as Error).message))
  }
}
setInterval(sweep, 2000)
/** A request is working on this board until `release`: it is not unloaded under it. */
const held = new WeakMap<http.ServerResponse, Rt>()
function hold(rt: Rt, res: http.ServerResponse) { rt.busy++; held.set(res, rt) }
function release(res: http.ServerResponse) {
  const rt = held.get(res)
  if (rt) { held.delete(res); rt.busy--; rt.used = Date.now() }
}

const designOf = (rt: Rt, id: string): Design => ({ id, ...rt.state.designs[id], ...(isLoose(id) ? { loose: true } : {}), rev: rt.src.get(id)!.rev, dirty: baseRevOf(rt, id) !== rt.src.get(id)!.rev })
const payload = (rt: Rt): Board => ({ name: rt.name, root: rt.root, designs: [...rt.src.keys()].map((id) => designOf(rt, id)), comments: rt.state.comments, items: rt.state.items || [] })

function findDesign(rt: Rt, q: string): string {
  if (rt.src.has(q)) return q
  const ids = [...rt.src.keys()]
  const want = q.toLowerCase()
  const titled = ids.filter((id) => rt.state.designs[id]?.title?.toLowerCase() === want)
  if (titled.length === 1) return titled[0]
  let hits = ids.filter((id) => id.toLowerCase().includes(want) || !!rt.state.designs[id]?.title?.toLowerCase().includes(want))
  if (hits.length > 1) { const plain = hits.filter((id) => !/9x16/i.test(id) || /9x16/i.test(q)); if (plain.length === 1) hits = plain }
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new HttpError(404, `no design matches "${q}". See: studio designs "${rt.name}"`)
  throw new HttpError(400, `"${q}" matches ${hits.length} designs:\n  ${hits.slice(0, 12).join('\n  ')}`)
}

function writeDesign(rt: Rt, id: string, text: string) {
  const abs = path.join(rt.root, id)
  snapshot(rt, id, rt.src.get(id)?.text, 'before edit')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.studio-tmp`)
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, abs) // atomic: nothing ever reads a half-written design
  put(rt, id, text, fs.statSync(abs))
}

function edit(rt: Rt, id: string, edits: Edit[], opts: { rev?: string; by: string; origin?: string }) {
  fresh(rt, id)
  const cur = rt.src.get(id)!
  if (opts.rev && opts.rev !== cur.rev) throw new HttpError(409, 'the file changed since you loaded it')
  let r
  try { r = applyEdits(cur.text, edits) } catch (e) { throw new HttpError(409, (e as Error).message) }
  if (r.source === cur.text) return { ok: true, rev: cur.rev, reload: false, newSid: null }
  writeDesign(rt, id, r.source)
  if (opts.by === 'user') { rt.undo.push({ design: id, before: cur.text, after: r.source }); if (rt.undo.length > 300) rt.undo.shift(); rt.redo = [] }
  else setBase(rt, id, r.source)
  log(rt, opts.by, id, r.notes)
  broadcast(rt, { type: 'design', design: designOf(rt, id), reload: r.structural, origin: opts.origin })
  return { ok: true, rev: rt.src.get(id)!.rev, reload: r.structural, newSid: r.newSid }
}

function removeDesignFile(rt: Rt, id: string) {
  const cur = rt.src.get(id)
  snapshot(rt, id, cur?.text, 'before delete')
  const abs = path.join(rt.root, id)
  if (fs.existsSync(abs)) {
    const trash = path.join(rt.dir, 'trash', `${Date.now()}-${id.replace(/[\\/]/g, '__')}`)
    fs.mkdirSync(path.dirname(trash), { recursive: true })
    fs.copyFileSync(abs, trash)
    fs.rmSync(abs)
  }
  rt.src.delete(id)
}

function history(rt: Rt, dir: 'undo' | 'redo') {
  const stack = dir === 'undo' ? rt.undo : rt.redo
  const group = stack[stack.length - 1]?.group
  let r = historyStep(rt, dir)
  let n = 1
  while (group && r.ok && stack[stack.length - 1]?.group === group) { r = historyStep(rt, dir); n++ }
  return n > 1 && r.ok ? { ...r, design: null, what: 'moving a piece between frames' } : r
}
function historyStep(rt: Rt, dir: 'undo' | 'redo'): { ok: boolean; error?: string; design?: string | null; what?: string } {
  const from = dir === 'undo' ? rt.undo : rt.redo
  const to = dir === 'undo' ? rt.redo : rt.undo
  const next = from[from.length - 1]
  if (next && !next.moves && !next.items) fresh(rt, next.design) // before the step is taken off the stack: a 409 here must not lose it
  const e = from.pop()
  if (!e) return { ok: false, error: `Nothing to ${dir}` }
  if (e.items) { // planning objects (boxes, notes, arrows, media) changed
    rt.state.items = structuredClone(dir === 'undo' ? e.items.before : e.items.after)
    saveState(rt); writePlan(rt)
    to.push(e)
    broadcast(rt, { type: 'items', items: rt.state.items })
    return { ok: true, design: null, what: 'board change' }
  }
  if (e.moves) { // frames moved on the canvas
    for (const m of e.moves) if (rt.state.designs[m.id]) Object.assign(rt.state.designs[m.id], dir === 'undo' ? m.from : m.to)
    saveState(rt)
    to.push(e)
    broadcast(rt, { type: 'board', board: payload(rt) })
    return { ok: true, design: e.moves.length === 1 ? e.moves[0].id : null, what: e.moves.length === 1 ? 'frame move' : `${e.moves.length} frames moved` }
  }
  const expect = dir === 'undo' ? e.after : e.before
  const target = dir === 'undo' ? e.before : e.after
  const cur = rt.src.get(e.design)
  if ((cur?.text ?? null) !== expect) { from.length = 0; return { ok: false, error: 'the file changed on disk, history cleared' } }
  const listChanged = expect === null || target === null
  if (target === null) { if (rt.state.designs[e.design]) e.layout = { ...rt.state.designs[e.design] }; removeDesignFile(rt, e.design) }
  else { writeDesign(rt, e.design, target); if (expect === null) { rt.state.designs[e.design] = e.layout || rt.state.designs[e.design] || place(rt, e.design); saveState(rt) } }
  to.push(e)
  log(rt, 'user', e.design, [dir])
  if (listChanged) broadcast(rt, { type: 'board', board: payload(rt) })
  else broadcast(rt, { type: 'design', design: designOf(rt, e.design), reload: true })
  return { ok: true, design: target === null ? null : e.design, what: `${listChanged ? 'design file' : 'edit'} on ${e.design.replace(/^ads\//, '').replace(/\/index(-9x16)?\.html$/, '$1')}` }
}

function readChanges(rt: Rt, sinceRaw: string | null, by: string | null) {
  const p = path.join(rt.dir, 'changes.jsonl')
  if (!fs.existsSync(p)) return []
  const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ts: number; by: string; design: string; notes: string[] })
  let since = 0
  if (sinceRaw && /^\d+$/.test(sinceRaw)) since = Number(sinceRaw)
  else if (sinceRaw && sinceRaw !== 'last-agent') since = Date.parse(sinceRaw) || 0
  const lastAgent: Record<string, number> = {}
  if (sinceRaw === 'last-agent') for (const r of rows) if (r.by === 'agent') lastAgent[r.design] = r.ts
  // an accept of the whole board is logged under "*" and counts for every design
  return rows.filter((r) => r.ts > Math.max(since, lastAgent[r.design] || 0, lastAgent['*'] || 0) && (!by || r.by === by))
}

function diffDesign(rt: Rt, id: string): string {
  const now = rt.src.get(id)!.text
  const base = fs.existsSync(basePath(rt, id)) ? fs.readFileSync(basePath(rt, id), 'utf8') : now
  if (base === now) return ''
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-diff-'))
  fs.writeFileSync(path.join(tmp, 'a'), oneTagPerLine(base) + '\n')
  fs.writeFileSync(path.join(tmp, 'b'), oneTagPerLine(now) + '\n')
  try {
    execFileSync('diff', ['-U1', '--label', `${id} (your last version)`, '--label', `${id} (now, with the user's edits)`, path.join(tmp, 'a'), path.join(tmp, 'b')])
    return ''
  } catch (e) { return String((e as { stdout?: Buffer }).stdout || '') } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

// ---------- headless render ----------
let browserP: Promise<import('playwright').Browser> | null = null
async function getBrowser() {
  const { chromium } = await import('playwright')
  if (!browserP) {
    // a browser that failed to start or has died must not be handed out for the rest of the server's life
    const p = chromium.launch()
    const drop = () => { if (browserP === p) browserP = null }
    browserP = p
    p.then((b) => b.on('disconnected', drop), drop)
  }
  return browserP
}
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
type Format = 'png' | 'jpg' | 'pdf'

async function render(rt: Rt, id: string, opts: { scale?: number; format?: Format; quality?: number; width?: number }) {
  const lay = rt.state.designs[id]
  const format = opts.format || 'png'
  if (!['png', 'jpg', 'pdf'].includes(format)) throw new HttpError(400, 'format must be png, jpg or pdf')
  const declared = Number(rt.src.get(id)?.text.match(/<meta[^>]+name=["']studio:width["'][^>]*content=["'](\d+)/i)?.[1]) || 0
  const width = opts.width || (declared && (!lay?.width || lay.width === 1200) ? declared : lay?.width) || 1080
  const open = async () => (await getBrowser()).newContext({ viewport: { width: Math.round(width), height: 1920 }, deviceScaleFactor: format === 'pdf' ? 1 : opts.scale || 1 })
  const ctx = await open().catch(() => { browserP = null; return open() }) // the browser was gone: start a new one, once
  try {
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/b/${encodeURIComponent(rt.name)}/${enc(id)}`, { waitUntil: 'load', timeout: 45000 })
    await page.evaluate('document.fonts.ready')
    await page.waitForTimeout(500)
    const el = await page.$('.ad, [data-artboard]')
    const box = el ? await el.boundingBox() : null
    const size = box ? { w: box.width, h: box.height } : { w: page.viewportSize()!.width, h: (await page.evaluate('document.documentElement.scrollHeight')) as number }
    let buf: Buffer
    if (format === 'pdf') buf = await page.pdf({ width: `${Math.ceil(size.w)}px`, height: `${Math.ceil(size.h)}px`, printBackground: true, pageRanges: '1' })
    else if (el) buf = await el.screenshot(format === 'jpg' ? { type: 'jpeg', quality: opts.quality || 92 } : { type: 'png' })
    else buf = await page.screenshot({ fullPage: true, ...(format === 'jpg' ? { type: 'jpeg' as const, quality: opts.quality || 92 } : { type: 'png' as const }) })
    const k = format === 'pdf' ? 1 : opts.scale || 1
    return { buf, width: Math.round(size.w * k), height: Math.round(size.h * k) }
  } finally { await ctx.close() }
}

/** Every slice of a design as its own picture, from one render: <exports>/<board>/<design>-slices/<design>-01.png … */
async function exportSlices(rt: Rt, id: string, o: { scale?: number; format?: Format; quality?: number; out?: string }) {
  const slices = [...(rt.state.slices?.[id] || [])].sort((a, b) => a.y - b.y || a.x - b.x)
  if (!slices.length) throw new HttpError(400, 'this design has no slices yet')
  const format = o.format === 'jpg' ? 'jpg' : 'png', scale = Math.min(4, Math.max(1, Number(o.scale) || 2))
  const lay = rt.state.designs[id]
  const declared = Number(rt.src.get(id)?.text.match(/<meta[^>]+name=["']studio:width["'][^>]*content=["'](\d+)/i)?.[1]) || 0
  const width = (declared && (!lay?.width || lay.width === 1200) ? declared : lay?.width) || 1080
  // named after the design's folder (index.html) or file, without the ad ratio tags
  const parts = id.replace(/\.html$/i, '').split('/'), stem = (parts.length > 1 && /^index/i.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1]).replace(/[^\w.-]+/g, '-')
  const dir = o.out ? tilde(o.out) : path.join(EXPORTS, rt.name, `${stem}-slices`)
  await fsp.mkdir(dir, { recursive: true })
  // last time's pictures go, so a removed slice does not linger beside the new set
  for (const f of await fsp.readdir(dir)) if (new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d\\d.*\\.(png|jpg)$`).test(f)) await fsp.rm(path.join(dir, f))
  const ctx = await (await getBrowser()).newContext({ viewport: { width: Math.round(width), height: 1920 }, deviceScaleFactor: scale })
  try {
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/b/${encodeURIComponent(rt.name)}/${enc(id)}`, { waitUntil: 'load', timeout: 45000 })
    await page.evaluate('document.fonts.ready')
    await page.waitForTimeout(500)
    const el = await page.$('.ad, [data-artboard]')
    const o0 = el ? (await el.boundingBox()) || { x: 0, y: 0 } : { x: 0, y: 0 }
    const out = []
    for (const [i, s] of slices.entries()) {
      const name = `${stem}-${String(i + 1).padStart(2, '0')}${s.name && !/^slice/i.test(s.name) ? '-' + s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) : ''}.${format}`
      const clip = { x: o0.x + s.x, y: o0.y + s.y, width: s.w, height: s.h }
      const buf = await page.screenshot({ clip, fullPage: true, ...(format === 'jpg' ? { type: 'jpeg' as const, quality: o.quality || 90 } : { type: 'png' as const }) })
      const target = path.join(dir, name)
      await fsp.writeFile(target, buf)
      out.push({ path: target, width: Math.round(s.w * scale), height: Math.round(s.h * scale), slice: s.id })
    }
    return { dir, exported: out }
  } finally { await ctx.close() }
}

function exportName(id: string, scale: number, format: Format) {
  const parts = id.replace(/\.html$/i, '').split('/')
  const file = parts.pop()!
  const folder = parts.pop()
  const ratio = /9x16/i.test(file) ? '9x16' : folder ? '4x5' : ''
  const stem = folder && /^index/i.test(file) ? `${folder}${ratio ? '-' + ratio : ''}` : file
  return `${stem}${format !== 'pdf' && scale !== 1 ? `-${scale}x` : ''}.${format}`
}

async function exportDesign(rt: Rt, id: string, o: { scale?: number; format?: Format; quality?: number; width?: number; out?: string }) {
  const r = await render(rt, id, o)
  const name = exportName(id, o.scale || 1, o.format || 'png')
  let target = o.out ? tilde(o.out) : path.join(EXPORTS, rt.name, name)
  if (!/\.(png|jpe?g|pdf)$/i.test(target)) target = path.join(target, name)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, r.buf)
  return { path: target, width: r.width, height: r.height, design: id }
}

// ---------- http ----------
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' }
const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'])
const VID = new Set(['.mp4', '.webm', '.mov', '.m4v'])

function readBody(req: http.IncomingMessage, limit = 80 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const json = (res: http.ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const text = (res: http.ServerResponse, body: string) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body) }
const bodyJson = async (req: http.IncomingMessage) => JSON.parse((await readBody(req)).toString() || '{}')

function template(rt: Rt, abs: string, w: number, h: number, bg = '#f4ece3') {
  const base = path.join(rt.root, 'shared', 'base.css')
  const link = fs.existsSync(base) ? `\n<link rel="stylesheet" href="${path.relative(path.dirname(abs), base).split(path.sep).join('/')}">` : ''
  return `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">${link}
<style>
body{margin:0}
.ad{position:relative;width:${w}px;height:${h}px;overflow:hidden;font-family:Inter,sans-serif;background:${bg};color:#141414}
.ad>*{position:absolute}
</style>
<div class="ad">
</div>
`
}


// ---------- pieces moving between files ----------
const relUrl = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u) && !u.startsWith('/')
/** Rewrite the links in a piece of markup so they still point at the same files from another folder of the board. */
function rebase(rt: Rt, html: string, from: string | null, to: string): string {
  const toDir = path.dirname(path.join(rt.root, to))
  const fix = (u: string): string => {
    u = u.trim()
    let abs: string | null = null
    const served = u.match(/^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/b\/[^/]+\/(.+)$/) // as the browser reports it
    if (served) abs = path.join(rt.root, decodeURIComponent(served[1].split(/[?#]/)[0]))
    else if (from && relUrl(u)) abs = path.resolve(path.dirname(path.join(rt.root, from)), decodeURIComponent(u.split(/[?#]/)[0]))
    if (!abs) return u
    return path.relative(toDir, abs).split(path.sep).map(encodeURIComponent).join('/')
  }
  return html
    .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])(.*?)\2/gi, (_m, a, q, u) => `${a}${q}${fix(u)}${q}`)
    .replace(/url\(\s*(&quot;|["']?)(.*?)\1\s*\)/gi, (_m, q, u) => `url(${q === '&quot;' ? "'" : q}${fix(u)}${q === '&quot;' ? "'" : q})`)
}
/** The fonts a file loads: its stylesheet links and @font-face rules, as they must read from another file. */
function fontsOf(rt: Rt, from: string, to: string): string[] {
  const src = rt.src.get(from)?.text || ''
  const links = (src.match(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>/gi) || [])
  const faces = (src.match(/@font-face\s*\{[^}]*\}/gi) || [])
  return [...links.map((l) => rebase(rt, l, from, to)), ...(faces.length ? [`<style>\n${faces.map((f) => rebase(rt, f, from, to)).join('\n')}\n</style>`] : [])]
}
const squash = (t: string) => t.replace(/\s+/g, ' ')
function looseFile(heads: string[], w: number, h: number, html: string) {
  return `<!doctype html><meta charset="utf-8">
${heads.join('\n')}
<style>
html,body{margin:0;background:transparent}
body{padding:${PAD}px}
.ad{position:relative;width:${w}px;height:${h}px;font-family:Inter,sans-serif;color:#141414}
.ad>*{position:absolute}
</style>
<div class="ad">
${html}
</div>
`
}
const PAD = 400 // room around a loose piece, so a shadow or a longer line of copy is not cut off

/**
 * Move pieces from one file to another, or onto the bare board (each becomes a small file of its own under loose/).
 * `items[].html` is the piece as it should read in its new home, written by the editor from what it looked like.
 */
async function transfer(rt: Rt, b: { from?: string; sids?: number[]; rev?: string; emptied?: boolean; to?: string; parent?: number; items?: { html: string; x: number; y: number; w: number; h: number; name?: string }[] }) {
  const items = b.items || []
  if (!items.length) throw new HttpError(400, 'nothing to move')
  const from = b.from ? findDesign(rt, b.from) : null
  const to = b.to ? findDesign(rt, b.to) : null
  if (from) fresh(rt, from)
  if (to) fresh(rt, to)
  if (from && b.rev && rt.src.get(from)!.rev !== b.rev) throw new HttpError(409, 'the file changed since you loaded it')
  const group = 'g_' + crypto.randomBytes(4).toString('hex')
  const made: string[] = []
  let newSid: number | null = null
  let listChanged = false
  const reloads: string[] = []
  if (to) {
    const cur = rt.src.get(to)!
    let text = cur.text
    if (from) { const have = squash(text); const extra = fontsOf(rt, from, to).filter((t) => !have.includes(squash(t))); if (extra.length) text = text.replace(/\s*$/, '\n') + extra.join('\n') + '\n' }
    let r
    try { r = applyEdits(text, items.map((it) => ({ kind: 'insert' as const, parent: Number(b.parent), html: rebase(rt, it.html, from, to) }))) } catch (e) { throw new HttpError(409, (e as Error).message) }
    writeDesign(rt, to, r.source)
    rt.undo.push({ design: to, before: cur.text, after: r.source, group })
    log(rt, 'user', to, r.notes.map((n) => (from ? `${n} (moved here from ${from})` : n)))
    newSid = r.newSid
    reloads.push(to)
  } else {
    fs.mkdirSync(path.join(rt.root, LOOSE), { recursive: true })
    const heads = from ? fontsOf(rt, from, `${LOOSE}/x.html`) : ['<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">']
    for (const it of items) {
      const stem = (it.name || 'piece').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'piece'
      let rel = ''
      for (let i = 1; !rel || fs.existsSync(path.join(rt.root, rel)); i++) rel = `${LOOSE}/${stem}-${i}.html`
      const w = Math.max(1, Math.ceil(it.w)), h = Math.max(1, Math.ceil(it.h))
      const text = looseFile(heads, w, h, rebase(rt, it.html, from, rel))
      fs.writeFileSync(path.join(rt.root, rel), text)
      rt.state.designs[rel] = { x: Math.round(it.x), y: Math.round(it.y), w, h }
      await scan(rt, false, new Set([rel]))
      rt.undo.push({ design: rel, before: null, after: text, group })
      log(rt, 'user', rel, [from ? `piece moved out of ${from} onto the board` : 'new piece on the board'])
      made.push(rel)
    }
    saveState(rt)
    listChanged = true
  }
  if (from && b.sids?.length) {
    const cur = rt.src.get(from)!
    if (b.emptied && isLoose(from)) {
      const layout = rt.state.designs[from] ? { ...rt.state.designs[from] } : undefined
      removeDesignFile(rt, from)
      rt.undo.push({ design: from, before: cur.text, after: null, group, layout })
      listChanged = true
    } else {
      let r
      try { r = applyEdits(cur.text, b.sids.map((sid) => ({ kind: 'remove' as const, sid }))) } catch (e) { throw new HttpError(409, (e as Error).message) }
      writeDesign(rt, from, r.source)
      rt.undo.push({ design: from, before: cur.text, after: r.source, group })
      log(rt, 'user', from, r.notes.map((n) => `${n} (moved to ${to || 'the board'})`))
      reloads.push(from)
    }
  }
  while (rt.undo.length > 300) rt.undo.shift()
  rt.redo = []
  if (listChanged) broadcast(rt, { type: 'board', board: payload(rt) })
  for (const id of reloads) broadcast(rt, { type: 'design', design: designOf(rt, id), reload: true })
  return { ok: true, designs: made, design: to, newSid }
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname
  const q = url.searchParams
  const post = req.method === 'POST'
  if (p === '/api/health') return json(res, { ok: true, root: ROOT, port: PORT, mode: 'html' }), true
  if (p === '/api/boards' && !post) return json(res, { aliases: Object.fromEntries(Object.entries(aliases()).map(([k, v]) => [k, v.board])), boards: readReg().map((r) => ({ ...r, exists: fs.existsSync(r.root), loaded: boards.has(r.name), viewers: boards.get(r.name)?.clients.size || 0, empty: emptyBoard(r) })) }), true
  if (p === '/api/boards' && post) {
    const b = await bodyJson(req)
    const reg = readReg()
    if (typeof b.permanent === 'string') {
      // starred on the work board: a permanent board (one per brand and kind of work, a section per task folder)
      if (!reg.some((r) => r.name === b.permanent)) throw new HttpError(404, `no such board: ${b.permanent}`)
      writeReg(reg.map((r) => (r.name !== b.permanent ? r : b.on ? { ...r, permanent: true } : (({ permanent: _p, ...rest }) => rest)(r))))
      return json(res, { ok: true }), true
    }
    if (b.close || b.open) {
      // closing changes nothing on disk but the flag: files, state and versions stay as they are
      const name = String(b.close || b.open)
      if (!reg.some((r) => r.name === name)) throw new HttpError(404, `no such board: ${name}. See: studio boards`)
      writeReg(reg.map((r) => (r.name !== name ? r : b.close ? { ...r, closed: true } : (({ closed: _c, ...rest }) => rest)(r))))
      const rt = b.close ? boards.get(name) : undefined
      if (rt) {
        // editor tabs on it are told to move on; it leaves memory now, or at the next sweep if something is still working on it
        for (const c of rt.clients) { if (c.readyState === 1) c.send(JSON.stringify({ type: 'closed' })); c.close() }
        rt.clients.clear()
        rt.used = 0
        if (idle(rt)) unload(rt)
      }
      return json(res, { ok: true }), true
    }
    if (b.remove) { writeReg(reg.filter((r) => r.name !== b.remove)); boards.delete(b.remove); return json(res, { ok: true }), true }
    const root = tilde(String(b.root || ''))
    if (!safeName(String(b.name || ''))) throw new HttpError(400, 'bad board name')
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, `not a folder: ${root}`)
    if (reg.some((r) => r.name === b.name)) throw new HttpError(409, `board exists: ${b.name}`)
    writeReg([...reg, { name: b.name, root }])
    return json(res, { ok: true, name: b.name, designs: (await load(b.name)).src.size }), true
  }
  if (p === '/api/config') return json(res, { workboard: process.env.WORKBOARD_URL || 'http://127.0.0.1:4477', review: !/^(127\.|::1$|::ffff:127\.)/.test(req.socket.localAddress || '') }), true
  if (p === '/api/selection') {
    if (!presence) return json(res, { board: null }), true
    const rt = boards.get(presence.board)
    const src = rt && presence.design ? rt.src.get(presence.design) : null
    const els = src ? indexHtml(src.text) : []
    return json(res, { board: presence.board, design: presence.design, at: presence.at, file: rt && presence.design ? path.join(rt.root, presence.design) : null,
      elements: presence.sids.map((s) => els[s]).filter(Boolean).map((e) => ({ what: describe(e), line: e.line, html: src!.text.slice(e.start, Math.min(e.end, e.start + 400)) })) }), true
  }

  // everything below works on one board
  const b = post && !p.startsWith('/api/upload') ? await bodyJson(req) : {}
  const boardName = q.get('board') || b.board
  if (!p.startsWith('/api/')) return false
  const al = aliasOf(String(boardName || ''))
  const rt = await load(String(boardName || ''))
  hold(rt, res)
  const want = q.get('design') || b.design
  // an old board name: its designs now sit in their own folder on the permanent board
  const id = want ? findDesign(rt, al && rt.src.has(`${al.folder}/${want}`) ? `${al.folder}/${want}` : String(want)) : ''
  const needId = () => { if (!id) throw new HttpError(400, 'missing design'); return id }

  if (p === '/api/board') return json(res, payload(rt)), true
  if (p === '/api/tree') return text(res, `${path.join(rt.root, needId())}\n${outline(rt.src.get(id)!.text)}\n`), true
  if (p === '/api/check') {
    const ids = id ? [id] : [...rt.src.keys()]
    return json(res, { results: ids.map((i) => ({ design: i, findings: lint(rt.src.get(i)!.text) })) }), true
  }
  if (p === '/api/source') return text(res, rt.src.get(needId())!.text), true
  if (p === '/api/reveal-file' && post) {
    // show a design's file, or a picture it uses, in Finder. Only from this Mac (never the phone), only inside the board.
    if (!/^(127\.|::1$|::ffff:127\.)/.test(req.socket.localAddress || '')) throw new HttpError(403, 'only on the Mac')
    let rel = id || ''
    const src = String(b.src || '')
    if (src) {
      if (/^(https?:|data:|blob:)/i.test(src)) throw new HttpError(400, 'That picture is not a file on this Mac (it comes from the web).')
      const clean = decodeURIComponent(src.split(/[?#]/)[0])
      rel = path.join(id ? path.dirname(id) : '', clean)
    }
    const root = fs.realpathSync(rt.root)
    const target = path.resolve(root, rel)
    if (!rel || !(target === root || target.startsWith(root + path.sep))) throw new HttpError(400, 'not a file on this board')
    if (!fs.existsSync(target)) throw new HttpError(404, `Can't find ${path.basename(target)}`)
    execFile('/usr/bin/open', ['-R', target])
    return json(res, { ok: true, path: target }), true
  }
  // `from`: the design a pasted piece was copied out of, so its links can be made to work from this file
  if (p === '/api/edit' && post && b.from && rt.src.has(b.from)) b.edits = (b.edits || []).map((e: Edit) => (e.kind === 'insert' ? { ...e, html: rebase(rt, e.html, b.from, needId()) } : e))
  if (p === '/api/edit' && post) return json(res, edit(rt, needId(), b.edits || [], { rev: b.rev, by: b.by || 'agent', origin: b.origin })), true
  if (p === '/api/delete-design' && post) {
    fresh(rt, needId())
    const text = rt.src.get(id)!.text
    removeDesignFile(rt, id)
    rt.undo.push({ design: id, before: text, after: null }); rt.redo = []
    log(rt, b.by || 'user', id, ['design file deleted (kept in Studio trash, undo restores it)'])
    broadcast(rt, { type: 'board', board: payload(rt) })
    return json(res, { ok: true }), true
  }
  if (p === '/api/revert' && post) {
    fresh(rt, needId())
    const cur = rt.src.get(id)!
    const base = fs.existsSync(basePath(rt, id)) ? fs.readFileSync(basePath(rt, id), 'utf8') : cur.text
    if (base === cur.text) return json(res, { ok: true, changed: false }), true
    writeDesign(rt, id, base)
    rt.undo.push({ design: id, before: cur.text, after: base }); rt.redo = []
    log(rt, 'user', id, ['reverted every hand edit, back to the agent\'s last version'])
    broadcast(rt, { type: 'design', design: designOf(rt, id), reload: true })
    return json(res, { ok: true, changed: true }), true
  }
  if (p === '/api/versions') return json(res, { versions: listVersions(rt, needId()) }), true
  if (p === '/api/restore' && post) {
    const v = listVersions(rt, needId()).find((x) => x.n === Number(b.version))
    if (!v) throw new HttpError(404, `no such version: ${b.version}`)
    fresh(rt, id)
    const cur = rt.src.get(id)!
    const text = fs.readFileSync(v.file, 'utf8')
    writeDesign(rt, id, text)
    rt.undo.push({ design: id, before: cur.text, after: text }); rt.redo = []
    log(rt, b.by || 'agent', id, [`restored version ${v.n}`])
    broadcast(rt, { type: 'design', design: designOf(rt, id), reload: true })
    return json(res, { ok: true }), true
  }
  if (p === '/api/undo' && post) return json(res, history(rt, 'undo')), true
  if (p === '/api/redo' && post) return json(res, history(rt, 'redo')), true
  if (p === '/api/layout' && post) {
    for (const d of b.designs || []) if (rt.state.designs[d.id]) Object.assign(rt.state.designs[d.id], Object.fromEntries(Object.entries(d).filter(([k, v]) => (['x', 'y', 'w', 'h', 'width'].includes(k) && typeof v === 'number') || (k === 'title' && typeof v === 'string'))))
    if ((b.designs || []).some((d: { title?: string }) => typeof d.title === 'string')) broadcast(rt, { type: 'board', board: payload(rt) })
    // real sizes (or a move) can push a design past its section's edge: the section grows to hold it
    if ((b.designs || []).map((d: { id: string }) => fitSection(rt, d.id)).some(Boolean)) broadcast(rt, { type: 'items', items: rt.state.items || [] })
    saveState(rt)
    if (Array.isArray(b.from)) {
      const moves = (b.from as { id: string; x: number; y: number }[]).filter((f) => rt.state.designs[f.id]).map((f) => ({ id: f.id, from: { x: f.x, y: f.y }, to: { x: rt.state.designs[f.id].x, y: rt.state.designs[f.id].y } })).filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y)
      if (moves.length) {
        const ids = (ms: typeof moves) => ms.map((m) => m.id).sort().join('\n')
        const top = rt.undo[rt.undo.length - 1]
        // a held arrow key sends one move per repeat: keep them as one undo step
        if (top?.moves && top.ts && Date.now() - top.ts < 1000 && ids(top.moves) === ids(moves)) { for (const m of top.moves) m.to = moves.find((x) => x.id === m.id)!.to; top.ts = Date.now() }
        else { rt.undo.push({ design: moves[0].id, before: null, after: null, moves, ts: Date.now() }); if (rt.undo.length > 300) rt.undo.shift() }
        rt.redo = []
      }
    }
    return json(res, { ok: true }), true
  }
  if (p === '/api/changes') return json(res, { changes: readChanges(rt, q.get('since'), q.get('by')).filter((c) => !id || c.design === id) }), true
  if (p === '/api/diff') {
    const ids = id ? [id] : [...rt.src.keys()]
    return text(res, ids.map((i) => diffDesign(rt, i)).filter(Boolean).join('\n')), true
  }
  if (p === '/api/accept' && post) {
    const ids = id ? [id] : [...rt.src.keys()]
    for (const i of ids) setBase(rt, i, rt.src.get(i)!.text)
    log(rt, 'agent', id || '*', ['accepted current state as the baseline'])
    return json(res, { ok: true, count: ids.length }), true
  }
  if (p === '/api/plan') return text(res, planOf(rt.name, rt.root, payload(rt))), true
  if (p === '/api/items' && !post) return json(res, { items: rt.state.items || [] }), true
  if (p === '/api/items' && post) {
    // { put: Item[] (added or changed), remove: id[] }. One call is one undo step.
    const before = rt.state.items || []
    const put: Item[] = Array.isArray(b.put) ? b.put : []
    const gone = new Set<string>(Array.isArray(b.remove) ? b.remove : [])
    const byId = new Map(before.map((i) => [i.id, i]))
    for (const it of put) {
      if (!it || typeof it.id !== 'string' || !it.kind) throw new HttpError(400, 'bad item')
      byId.set(it.id, { ...byId.get(it.id), ...it })
    }
    for (const g of gone) byId.delete(g)
    // arrows and notes left pointing at nothing go too
    const alive = (ref?: string) => !ref || byId.has(ref) || rt.src.has(ref)
    for (const [k, it] of byId) if ((it.kind === 'arrow' && (!alive(it.from) || !alive(it.to))) || (it.attach && !byId.has(it.attach))) byId.delete(k)
    const after = [...byId.values()]
    // a comment pinned on a board object goes when that object does
    if (rt.state.comments.some((c) => c.item && !byId.has(c.item))) { rt.state.comments = rt.state.comments.filter((c) => !c.item || byId.has(c.item)); broadcast(rt, { type: 'comments', comments: rt.state.comments }) }
    rt.state.items = after
    if (b.by !== 'agent') {
      const top = rt.undo[rt.undo.length - 1]
      // typing into one box sends a change per pause: keep a quick run of edits to the same item as one step
      const key = put.length === 1 && !gone.size ? put[0].id : ''
      if (key && top?.items && top.ts && Date.now() - top.ts < 1500 && top.key === key) { top.items.after = structuredClone(after); top.ts = Date.now() }
      else { rt.undo.push({ design: '', before: null, after: null, items: { before: structuredClone(before), after: structuredClone(after) }, ts: Date.now(), ...(key ? { key } : {}) }); if (rt.undo.length > 300) rt.undo.shift() }
      rt.redo = []
    }
    saveState(rt); writePlan(rt)
    broadcast(rt, { type: 'items', items: after, origin: b.from })
    return json(res, { ok: true, items: after.length }), true
  }
  if (p === '/api/comments' && !post) return json(res, { comments: rt.state.comments.filter((c) => (q.get('all') === '1' || !c.resolved) && (!id || c.design === id)).map((c) => ({ ...c, file: c.design ? path.join(rt.root, c.design) : null })) }), true
  if (p === '/api/comments' && post) {
    if (b.add && !b.onBoard) needId(); if (b.add) rt.state.comments.push({ id: 'c_' + crypto.randomBytes(3).toString('hex'), x: 40, y: 40, target: '', text: '', author: 'user', resolved: false, replies: [], ts: Date.now(), ...b.add, design: b.onBoard ? '' : id } as Comment)
    if (b.update) { const c = rt.state.comments.find((c) => c.id === b.update.id); if (!c) throw new HttpError(404, `no such comment: ${b.update.id}`); Object.assign(c, b.update); if (b.reply) c.replies.push({ by: b.reply.by || 'agent', text: b.reply.text, ts: Date.now() }) }
    if (b.remove) rt.state.comments = rt.state.comments.filter((c) => c.id !== b.remove)
    saveState(rt)
    broadcast(rt, { type: 'comments', comments: rt.state.comments })
    writePlan(rt)
    return json(res, { ok: true, id: rt.state.comments[rt.state.comments.length - 1]?.id }), true
  }
  if (p === '/api/copy-design' && post) {
    // a whole frame copied (⌘C on a frame) and pasted here: a new file beside the original's name. From another board,
    // the files it links to (pictures, fonts) come along into this board's studio-assets/.
    const fromBoard = String(b.fromBoard || rt.name), fromId = String(b.fromId || '')
    const reg = readReg().find((r) => r.name === fromBoard)
    if (!reg) throw new HttpError(404, `no such board: ${fromBoard}`)
    const fromRoot = path.resolve(reg.root), fromAbs = path.resolve(fromRoot, fromId)
    if (!fromAbs.startsWith(fromRoot + path.sep) || !fs.existsSync(fromAbs)) throw new HttpError(404, `no such design: ${fromId}`)
    const sameBoard = fromRoot === path.resolve(rt.root)
    const text0 = (sameBoard && rt.src.get(fromId)?.text) || fs.readFileSync(fromAbs, 'utf8')
    // the new name: ads/<name> copy/index.html for a design in its own folder, <name> copy.html for a plain file
    const parts = fromId.split('/'), file = parts.pop()!
    const inFolder = /^index(-[\w]+)?\.html$/i.test(file) && parts.length > 0
    const relOf = (n: number) => { const tag = n > 1 ? ` copy ${n}` : ' copy'; return inFolder ? [...parts.slice(0, -1), parts[parts.length - 1].replace(/ copy( \d+)?$/, '') + tag, file].join('/') : [...parts, file.replace(/\.html$/i, '').replace(/ copy( \d+)?$/, '') + tag + '.html'].join('/') }
    let rel = relOf(1)
    for (let i = 2; fs.existsSync(path.join(rt.root, rel)); i++) rel = relOf(i)
    const abs = path.join(rt.root, rel)
    const fromDir = path.dirname(fromAbs), toDir = path.dirname(abs)
    const fix = (u: string): string => {
      const raw = u.trim()
      if (!relUrl(raw)) return u
      const clean = decodeURIComponent(raw.split(/[?#]/)[0]), tail = raw.slice(raw.split(/[?#]/)[0].length)
      const src = path.resolve(fromDir, clean)
      if (!src.startsWith(fromRoot + path.sep) || !fs.existsSync(src) || !fs.statSync(src).isFile()) return u
      let target = src
      if (!sameBoard) {
        const buf = fs.readFileSync(src), dir = path.join(rt.root, 'studio-assets')
        fs.mkdirSync(dir, { recursive: true })
        target = path.join(dir, hash(buf.toString('binary')) + path.extname(src).toLowerCase())
        if (!fs.existsSync(target)) fs.writeFileSync(target, buf)
      }
      return path.relative(toDir, target).split(path.sep).map(encodeURIComponent).join('/') + tail
    }
    const text = text0
      .replace(/(\s(?:src|href|poster)\s*=\s*)(["'])(.*?)\2/gi, (_m, a1, q1, u) => `${a1}${q1}${fix(u)}${q1}`)
      .replace(/url\(\s*(&quot;|["']?)(.*?)\1\s*\)/gi, (_m, q1, u) => `url(${q1}${fix(u)}${q1})`)
    fs.mkdirSync(toDir, { recursive: true })
    fs.writeFileSync(abs, text)
    const lay = sameBoard ? rt.state.designs[fromId] : undefined
    const w = Number(b.w) || lay?.w || 1080, h = Number(b.h) || lay?.h || 1350
    rt.state.designs[rel] = { x: Math.round(Number(b.x) || 0), y: Math.round(Number(b.y) || 0), w, h, ...(lay?.width ? { width: lay.width } : {}) }
    await scan(rt, false, new Set([rel]))
    saveState(rt)
    broadcast(rt, { type: 'board', board: payload(rt) })
    return json(res, { ok: true, design: rel }), true
  }
  if (p === '/api/new' && post) {
    // From the board the name is free text: it becomes the title, and the file gets a safe name of its own.
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : ''
    let name = String(b.name || '').trim()
    if (!name && title) name = title.replace(/[^\w .()-]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 50) || 'frame'
    if (!/^[\w .()-]{1,60}$/.test(name)) throw new HttpError(400, 'bad design name')
    const [w, h] = b.w && b.h ? [Math.round(Number(b.w)), Math.round(Number(b.h))] : SIZES[b.size || '4x5'] || String(b.size).split('x').map(Number)
    if (!(w > 0) || !(h > 0)) throw new HttpError(400, `bad size: ${b.size}`)
    const ads = fs.existsSync(path.join(rt.root, 'ads')) || !listHtml(rt.root).length
    const file = b.size === '9x16' ? 'index-9x16.html' : 'index.html'
    const relOf = (n: string) => (ads ? `ads/${n}/${file}` : `${n}.html`)
    let rel = relOf(name)
    if (fs.existsSync(path.join(rt.root, rel))) {
      if (b.name) throw new HttpError(409, `already exists: ${rel}`)
      for (let i = 2; fs.existsSync(path.join(rt.root, rel)); i++) rel = relOf(`${name} ${i}`)
    }
    const abs = path.join(rt.root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const text = template(rt, abs, w, h, typeof b.bg === 'string' && /^#[0-9a-f]{3,8}$/i.test(b.bg) ? b.bg : undefined)
    fs.writeFileSync(abs, text)
    if (typeof b.x === 'number' && typeof b.y === 'number') rt.state.designs[rel] = { x: Math.round(b.x), y: Math.round(b.y), w, h }
    await scan(rt, false, new Set([rel])) // on the board before we answer, so `studio new` can be followed by `tree` or `shot` at once
    if (title && rt.state.designs[rel]) { rt.state.designs[rel].title = title; saveState(rt); broadcast(rt, { type: 'board', board: payload(rt) }) }
    if (b.by === 'user') { rt.undo.push({ design: rel, before: null, after: text }); rt.redo = [] }
    return json(res, { ok: true, design: rel, file: abs }), true
  }
  if (p === '/api/transfer' && post) return json(res, await transfer(rt, b)), true
  if (p === '/api/copy' && post) {
    const from = path.join(rt.root, needId())
    const rel = String(b.to || '').replace(/^\/+/, '')
    if (!rel.toLowerCase().endsWith('.html') || rel.includes('..')) throw new HttpError(400, 'copy target must be a .html path inside the board')
    const abs = path.join(rt.root, rel)
    if (fs.existsSync(abs)) throw new HttpError(409, `already exists: ${rel}`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.copyFileSync(from, abs)
    await scan(rt, false, new Set([rel]))
    return json(res, { ok: true, design: rel, file: abs }), true
  }
  if (p === '/api/upload' && post) {
    const buf = await readBody(req)
    const ext = (path.extname(q.get('name') || '') || '.png').toLowerCase()
    if (!IMG.has(ext) && !VID.has(ext)) throw new HttpError(415, 'not an image or video')
    const dir = path.join(rt.root, 'studio-assets')
    fs.mkdirSync(dir, { recursive: true })
    const abs = path.join(dir, hash(buf.toString('binary')) + ext)
    fs.writeFileSync(abs, buf)
    return json(res, { src: path.relative(id ? path.dirname(path.join(rt.root, id)) : path.join(rt.root, LOOSE), abs).split(path.sep).join('/'), path: path.relative(rt.root, abs).split(path.sep).join('/') }), true
  }
  if (p === '/api/grade-presets') {
    // the brand grades you can pick in the Grade panel (saved next to the boards)
    if (post && b.presets && typeof b.presets === 'object') savePresets(ROOT, b.presets as Presets)
    return json(res, { presets: loadPresets(ROOT) }), true
  }
  if ((p === '/api/grade-preview' || p === '/api/grade') && post) {
    // grade a picture: a quick small preview while you drag the sliders, or the full picture (saved under studio-assets/,
    // metadata gone) that replaces it as one undo step
    const bytes = (d: unknown) => (typeof d === 'string' && d.includes(',') ? Buffer.from(d.slice(d.indexOf(',') + 1), 'base64') : undefined)
    const image = bytes(b.image)
    if (!image?.length) throw new HttpError(400, 'missing image')
    const g = b.grade as Grade
    let out: Buffer
    try { out = await runGrade(image, p === '/api/grade-preview' ? { ...g, max: Number(b.max) || 1400, fullw: Number(b.fullw) || 0 } : g) } catch (e) { throw new HttpError(422, (e as Error).message) }
    const jpg = out[0] === 0xff && out[1] === 0xd8
    if (p === '/api/grade-preview') return json(res, { ok: true, url: `data:image/${jpg ? 'jpeg' : 'png'};base64,${out.toString('base64')}` }), true
    const rel = `studio-assets/grade-${crypto.createHash('sha1').update(out).digest('hex').slice(0, 12)}.${jpg ? 'jpg' : 'png'}`
    fs.mkdirSync(path.join(rt.root, 'studio-assets'), { recursive: true })
    fs.writeFileSync(path.join(rt.root, rel), out)
    const abs = path.join(rt.root, rel)
    const size = sizeOf(out) || { w: 1, h: 1 }
    return json(res, { ok: true, path: rel, ...size, src: path.relative(id ? path.dirname(path.join(rt.root, id)) : path.join(rt.root, LOOSE), abs).split(path.sep).join('/') }), true
  }
  if (p === '/api/ai' && post) {
    // remove background / edit / expand / erase a picture. The picture comes as a data URL (what is on screen); the
    // result is saved under studio-assets/ and the tab is told how it is going over the socket while it waits.
    const op = String(b.op) as AiOp
    if (!['removebg', 'edit', 'expand', 'erase', 'upscale', 'fill'].includes(op)) throw new HttpError(400, 'unknown image tool')
    const bytes = (d: unknown) => (typeof d === 'string' && d.includes(',') ? Buffer.from(d.slice(d.indexOf(',') + 1), 'base64') : undefined)
    const image = bytes(b.image)
    if (!image?.length) throw new HttpError(400, 'missing image')
    const say = (text: string) => broadcast(rt, { type: 'ai', job: b.job, text })
    try {
      const r = await runAi(ROOT, rt.root, { op, image, marked: bytes(b.marked), prompt: b.prompt ? String(b.prompt) : undefined, aspect: b.aspect ? String(b.aspect) : undefined, model: b.model ? String(b.model) : undefined }, say)
      const abs = path.join(rt.root, r.path)
      return json(res, { ok: true, ...r, src: path.relative(id ? path.dirname(path.join(rt.root, id)) : path.join(rt.root, LOOSE), abs).split(path.sep).join('/') }), true
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(422, e.message)
      throw e
    }
  }
  if (p === '/api/import-assets' && post) {
    // a piece copied from another design (maybe on another board) refers to its files as /b/<board>/<path>: give back
    // the path to use from this design, copying a file from another board's folder into this board's studio-assets/
    const base = id ? path.dirname(path.join(rt.root, id)) : path.join(rt.root, LOOSE)
    const map: Record<string, string> = {}
    for (const u of Array.isArray(b.urls) ? b.urls.slice(0, 200) : []) {
      const m = /^\/b\/([^/]+)\/(.+)$/.exec(String(u))
      if (!m) continue
      const reg = readReg().find((r) => r.name === decodeURIComponent(m[1]))
      if (!reg) continue
      const from = path.resolve(reg.root), abs = path.resolve(from, m[2].split('/').map(decodeURIComponent).join('/'))
      if (!abs.startsWith(from + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
      let target = abs
      if (from !== path.resolve(rt.root)) {
        const buf = fs.readFileSync(abs), dir = path.join(rt.root, 'studio-assets')
        fs.mkdirSync(dir, { recursive: true })
        target = path.join(dir, hash(buf.toString('binary')) + path.extname(abs).toLowerCase())
        if (!fs.existsSync(target)) fs.writeFileSync(target, buf)
      }
      map[String(u)] = path.relative(base, target).split(path.sep).join('/')
    }
    return json(res, { ok: true, map }), true
  }
  if (p === '/api/export' && post) return json(res, await exportDesign(rt, needId(), b)), true
  if (p === '/api/slices' && !post) return json(res, { slices: rt.state.slices?.[needId()] || [] }), true
  if (p === '/api/slices' && post) {
    const d = needId(), n = (v: unknown) => Math.round(Number(v) || 0)
    const list: Slice[] = (Array.isArray(b.slices) ? b.slices : []).slice(0, 200)
      .map((s: Slice, i: number) => ({ id: String(s.id || 's_' + crypto.randomBytes(3).toString('hex')).slice(0, 40), name: String(s.name || '').slice(0, 60), x: n(s.x), y: n(s.y), w: Math.max(1, n(s.w)), h: Math.max(1, n(s.h)), i }))
      .map(({ i: _i, ...s }: Slice & { i: number }) => s)
    rt.state.slices ??= {}
    if (list.length) rt.state.slices[d] = list; else delete rt.state.slices[d]
    saveState(rt)
    broadcast(rt, { type: 'slices', design: d, slices: list, origin: b.from })
    return json(res, { ok: true, slices: list.length }), true
  }
  if (p === '/api/export-slices' && post) return json(res, await exportSlices(rt, needId(), b)), true
  if (p === '/api/reveal' && post) {
    // show an export folder in Finder (only ever one under the exports folder)
    const target = path.resolve(String(b.path || ''))
    if (!target.startsWith(path.resolve(EXPORTS) + path.sep) || !fs.existsSync(target)) throw new HttpError(400, 'not an export folder')
    execFile('/usr/bin/open', [target])
    return json(res, { ok: true }), true
  }
  if (p === '/api/export-all' && post) {
    const out = []
    const dir = b.out && !/\.(png|jpe?g|pdf)$/i.test(b.out) ? b.out : undefined
    for (const d of rt.src.keys()) if (b.match ? true : !isLoose(d)) if (!b.match || d.toLowerCase().includes(String(b.match).toLowerCase())) out.push(await exportDesign(rt, d, { ...b, out: dir }))
    return json(res, { exported: out }), true
  }
  if (p === '/api/render') {
    const format = (q.get('format') || 'png') as Format
    const r = await render(rt, needId(), { scale: Number(q.get('scale')) || 1, format })
    res.writeHead(200, { 'content-type': format === 'pdf' ? 'application/pdf' : format === 'jpg' ? 'image/jpeg' : 'image/png' }); res.end(r.buf); return true
  }
  return false
}

/**
 * A board with nothing on it: no designs, no planning objects, no HTML in its folder. Such boards are left out of every
 * board list (they come from tasks that never used Studio); opening one by name or link still works.
 */
const emptyCache = new Map<string, { key: string; empty: boolean }>()
function emptyBoard(reg: Reg): boolean {
  if (reg.permanent) return false // always listed, even before its first design
  const rt = boards.get(reg.name)
  if (rt) return !rt.src.size && !(rt.state.items || []).length
  const sp = path.join(ROOT, 'boards', reg.name, 'state.json')
  const mt = (f: string) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
  const key = `${mt(sp)}:${mt(reg.root)}`
  const hit = emptyCache.get(reg.name)
  if (hit && hit.key === key) return hit.empty
  let empty = true
  try {
    const st: Partial<State> = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {}
    empty = !Object.keys(st.designs || {}).length && !(st.items || []).length && !listHtml(reg.root).length
  } catch { empty = false }
  emptyCache.set(reg.name, { key, empty })
  return empty
}

/**
 * What a board holds, for the hover preview in the board menu. Read from its saved state and a few file dates only:
 * the board is not loaded or scanned, so hovering a closed board costs nothing.
 */
function previewOf(name: string) {
  const reg = readReg().find((r) => r.name === name)
  if (!reg) throw new HttpError(404, `no such board: ${name}`)
  const sp = path.join(ROOT, 'boards', name, 'state.json')
  const st: Partial<State> = boards.get(name)?.state || (fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : {})
  const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
  const ids = Object.keys(st.designs || {}).filter((id) => !isLoose(id))
  // the most recently changed designs show; a file that is gone is left out
  const dated = ids.slice(0, 400).map((id) => ({ id, t: mtime(path.join(reg.root, id)) })).filter((d) => d.t)
  dated.sort((a, b) => b.t - a.t)
  const items = (st.items || []).filter((i) => i.kind !== 'arrow').slice(0, 300).map((i) => ({ kind: i.kind, x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot, text: (i.text || '').slice(0, 60), src: i.src }))
  return {
    name, root: reg.root, closed: !!reg.closed, exists: fs.existsSync(reg.root),
    designCount: dated.length,
    designs: dated.slice(0, 6).map((d) => ({ id: d.id, w: st.designs![d.id].w || 1080, h: st.designs![d.id].h || 1350 })),
    items, comments: (st.comments || []).filter((c) => !c.resolved).length,
    edited: Math.max(mtime(sp), dated[0]?.t || 0) || null,
  }
}
/** /p/<board>/<path>: a board file for the preview, straight from the folder (the board is not loaded). */
function servePreviewFile(res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
  const reg = readReg().find((r) => r.name === parts[0])
  if (!reg) throw new HttpError(404, 'no such board')
  const root = path.resolve(reg.root), abs = path.resolve(root, parts.slice(1).join('/'))
  if (!abs.startsWith(root + path.sep)) throw new HttpError(403, 'outside the board')
  const type = MIME[path.extname(abs).toLowerCase()]
  if (!type || type.startsWith('video/') || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'not found')
  res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=60' })
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res)
}

/** /b/<board>/<path>: the board folder, served so relative links in the designs just work. */
async function serveBoardFile(res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
  const asked = parts.shift() || '', al = aliasOf(asked)
  const rt = await load(asked)
  const rel = (al ? [al.folder, ...parts] : parts).join('/')
  const abs = path.resolve(rt.root, rel)
  if (abs !== rt.root && !abs.startsWith(rt.root + path.sep)) throw new HttpError(403, 'outside the board')
  const type = MIME[path.extname(abs).toLowerCase()]
  if (!type || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'not found')
  if (url.searchParams.has('studio') && type.startsWith('text/html')) {
    const src = rt.src.get(rel)?.text ?? fs.readFileSync(abs, 'utf8')
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(annotate(src))
    return
  }
  const range = type.startsWith('video/') ? /bytes=(\d*)-(\d*)/.exec(String(rangeOf(res) || '')) : null
  if (range) { // videos seek with byte ranges
    const size = fs.statSync(abs).size
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
    fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-store' : 'max-age=30', ...(type.startsWith('video/') ? { 'accept-ranges': 'bytes' } : {}) })
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res) // a synced folder can fail a read after the exists check
}

const vite = await createVite({ root: APP_DIR, appType: 'spa', server: { middlewareMode: true, hmr: { port: PORT + 1 }, allowedHosts: ['.ts.net'] }, logLevel: 'warn' })

const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname.startsWith('/b/')) return await serveBoardFile(res, url)
    if (url.pathname.startsWith('/p/')) return servePreviewFile(res, url)
    if (url.pathname === '/api/preview') return json(res, previewOf(url.searchParams.get('board') || ''))
    // Higgsfield through the subscription: sign in once in the browser (OAuth), Studio keeps the token in settings.json
    if (url.pathname === '/api/higgsfield') return json(res, hfmcp.status(ROOT))
    if (url.pathname === '/api/higgsfield/signout' && req.method === 'POST') { hfmcp.signOut(ROOT); return json(res, { ok: true }) }
    if (url.pathname === '/oauth/higgsfield/start') {
      res.writeHead(302, { location: await hfmcp.signInUrl(ROOT, `http://127.0.0.1:${PORT}/oauth/higgsfield`) }); res.end(); return
    }
    if (url.pathname === '/oauth/higgsfield') {
      const q = url.searchParams
      const page = (title: string, body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:15px system-ui;background:#2c2c2c;color:#f2f2f2;display:grid;place-items:center;height:90vh"><div style="max-width:440px;text-align:center"><h2>${title}</h2><p style="color:#bbb">${body}</p></div><script>try{window.opener&&window.opener.postMessage({higgsfield:${JSON.stringify(title)}},'*')}catch(e){}</script>`) }
      if (q.get('error')) return page('Not connected', String(q.get('error_description') || q.get('error')).replace(/</g, '&lt;'))
      try {
        await hfmcp.finishSignIn(ROOT, q.get('code') || '', q.get('state') || '')
        // what the server offers, for whoever wires the tools (kept beside settings.json)
        hfmcp.listTools(ROOT).then((t) => fs.writeFileSync(path.join(ROOT, 'higgsfield-tools.json'), JSON.stringify(t, null, 1))).catch((e) => console.error('higgsfield tools:', (e as Error).message))
        return page('Higgsfield is connected', 'Studio can now use your Higgsfield plan. You can close this tab.')
      } catch (e) { return page('Not connected', String((e as Error).message).replace(/</g, '&lt;')) }
    }
    if (url.pathname.startsWith('/api/')) {
      if (await api(req, res, url)) return
      throw new HttpError(404, 'unknown endpoint')
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (!res.headersSent) json(res, { ok: false, error: (e as Error).message }, status)
    else res.end()
    return
  } finally { release(res) }
  vite.middlewares(req, res)
}
const server = http.createServer(handle)

const wss = new WebSocketServer({ noServer: true })
const upgrade = (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/ws') return
  wss.handleUpgrade(req, socket, head, async (ws) => {
    let rt: Rt
    try { rt = await load(url.searchParams.get('board') || '') } catch (e) { ws.send(JSON.stringify({ type: 'error', error: (e as Error).message })); ws.close(); return }
    rt.clients.add(ws)
    ws.send(JSON.stringify({ type: 'board', board: payload(rt) }))
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'presence') presence = { board: rt.name, design: msg.design ?? null, sids: msg.sids || [], at: Date.now() }
      } catch { /* ignore bad frames */ }
    })
    ws.on('close', () => rt.clients.delete(ws))
  })
}
server.on('upgrade', upgrade)

/**
 * Review from the phone: Studio also answers on this Mac's Tailscale address (only your own devices can reach it, never
 * the Wi-Fi or the internet). What comes in that way can look at boards and leave comments, nothing else: no edits,
 * no AI, no files, no settings.
 */
const REVIEW_GET = new Set(['/api/boards', '/api/board', '/api/config', '/api/health', '/api/comments', '/api/preview'])
function reviewOk(req: http.IncomingMessage): boolean {
  const p = new URL(req.url || '/', 'http://x').pathname
  if (req.method === 'POST') return p === '/api/comments'
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (p.startsWith('/oauth/') || p.startsWith('/api/higgsfield')) return false
  return !p.startsWith('/api/') || REVIEW_GET.has(p)
}
function tailscaleIp(): string | null {
  for (const exe of ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try { const ip = execFileSync(exe, ['ip', '-4'], { timeout: 5000, encoding: 'utf8' }).trim().split(/\s+/)[0]; if (ip?.startsWith('100.')) return ip } catch { /* not this one */ }
  }
  return null
}
function serveReview() {
  if (process.env.STUDIO_NO_TAILSCALE) return
  const ip = tailscaleIp()
  if (!ip) { setTimeout(serveReview, 30_000); return } // Tailscale is off: look again later
  const rs = http.createServer((req, res) => {
    if (reviewOk(req)) return void handle(req, res)
    res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'review only: from the phone you can look and comment' }))
  })
  rs.on('upgrade', upgrade)
  rs.on('error', () => setTimeout(serveReview, 30_000)) // the address changed or is busy: try again later
  rs.listen(PORT, ip, () => console.log(`Review (phone) http://${ip}:${PORT}`))
}

// One bad request or file read must not take the editor down mid-session (edits made while it is down are lost).
process.on('uncaughtException', (e) => console.error('uncaught:', e))
server.on('error', (e) => { console.error(e); process.exit(1) }) // but a server that cannot listen should not linger
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Studio  http://127.0.0.1:${PORT}`)
  console.log(`State          ${ROOT}`)
  serveReview()
})

const shutdown = async () => {
  for (const rt of boards.values()) flush(rt)
  try { (await browserP)?.close() } catch { /* already gone */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
