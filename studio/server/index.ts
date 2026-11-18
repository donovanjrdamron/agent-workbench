// Studio server. A board is a folder of HTML designs. The HTML files are the truth:
// the editor shows them live, writes small edits back into them, and logs who changed what.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer as createVite } from 'vite'
import { annotate, applyEdits, describe, indexHtml, lint, oneTagPerLine, outline } from './html'
import { SIZES, type Board, type Comment, type Design, type Edit } from '../shared/types'

const PORT = Number(process.env.STUDIO_PORT || 4517)
const HOME = os.homedir()
// The editor's own state (board list, layouts, baselines, version history) lives on the local
// disk, never in a cloud-synced folder: those can hand back files slowly or not at all.
const ROOT = process.env.STUDIO_DIR || path.join(HOME, 'Library/Application Support/Studio')
const EXPORTS = process.env.STUDIO_EXPORTS || (process.env.STUDIO_DIR ? path.join(ROOT, 'exports') : path.join(ROOT, 'exports'))
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
fs.mkdirSync(path.join(ROOT, 'boards'), { recursive: true })

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg) } }
const hash = (t: string) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 10)
const tilde = (p: string) => path.resolve(p.replace(/^~(?=\/|$)/, HOME))

// ---------- registry ----------
interface Reg { name: string; root: string }
const regPath = path.join(ROOT, 'boards.json')
const readReg = (): Reg[] => (fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : [])
const writeReg = (r: Reg[]) => fs.writeFileSync(regPath, JSON.stringify(r, null, 1))
const safeName = (n: string) => /^[\w .()&,-]{1,80}$/.test(n) && !n.startsWith('.')

interface Layout { x: number; y: number; w: number; h: number; width?: number }
/** `seen`: the rev of each design as the server last saw it, so a file changed while Studio was closed is not mistaken for hand edits. */
interface State { designs: Record<string, Layout>; comments: Comment[]; seen?: Record<string, string> }
interface Src { text: string; rev: string; mtime: number; size: number }
/** One undo step. null means the file did not exist on that side. */
interface Hist { design: string; before: string | null; after: string | null; moves?: { id: string; from: { x: number; y: number }; to: { x: number; y: number } }[]; ts?: number }
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
}
const boards = new Map<string, Rt>()
let presence: { board: string; design: string | null; sids: number[]; at: number } | null = null

const SKIP_DIRS = new Set(['node_modules', 'shared', 'final', 'studio-assets', 'html-archive'])
function listHtml(root: string): string[] {
  const start = fs.existsSync(path.join(root, 'ads')) ? 'ads' : ''
  const out: string[] = []
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (depth < 4 && !SKIP_DIRS.has(e.name)) walk(p, depth + 1) }
      else if (e.name.toLowerCase().endsWith('.html')) out.push(p)
    }
  }
  walk(start, 0)
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
function saveState(rt: Rt) {
  if (rt.saveTimer) clearTimeout(rt.saveTimer)
  rt.saveTimer = setTimeout(() => { rt.saveTimer = null; fs.writeFileSync(path.join(rt.dir, 'state.json'), JSON.stringify(rt.state, null, 1)) }, 300)
}
function log(rt: Rt, by: string, design: string, notes: string[]) {
  if (notes.length) fs.appendFileSync(path.join(rt.dir, 'changes.jsonl'), JSON.stringify({ ts: Date.now(), by, design, notes }) + '\n')
}
function broadcast(rt: Rt, msg: unknown) {
  const text = JSON.stringify(msg)
  for (const c of rt.clients) if (c.readyState === 1) c.send(text)
}

/** First free slot on a loose grid. Real sizes arrive once the editor has rendered the file. */
function place(rt: Rt, id: string): Layout {
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
  const hit = boards.get(name)
  if (hit) return Promise.resolve(hit)
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
  const rt: Rt = { name, root: reg.root, dir, state, src: new Map(), clients: new Set(), undo: [], redo: [], saveTimer: null, baseRev: new Map(), scanning: false }
  await scan(rt, true)
  boards.set(name, rt)
  return rt
}
setInterval(() => { for (const rt of boards.values()) scan(rt).catch((e) => console.error('scan failed:', (e as Error).message)) }, 2000)

const designOf = (rt: Rt, id: string): Design => ({ id, ...rt.state.designs[id], rev: rt.src.get(id)!.rev, dirty: baseRevOf(rt, id) !== rt.src.get(id)!.rev })
const payload = (rt: Rt): Board => ({ name: rt.name, root: rt.root, designs: [...rt.src.keys()].map((id) => designOf(rt, id)), comments: rt.state.comments })

function findDesign(rt: Rt, q: string): string {
  if (rt.src.has(q)) return q
  const ids = [...rt.src.keys()]
  const want = q.toLowerCase()
  let hits = ids.filter((id) => id.toLowerCase().includes(want))
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
  const from = dir === 'undo' ? rt.undo : rt.redo
  const to = dir === 'undo' ? rt.redo : rt.undo
  const next = from[from.length - 1]
  if (next && !next.moves) fresh(rt, next.design) // before the step is taken off the stack: a 409 here must not lose it
  const e = from.pop()
  if (!e) return { ok: false, error: `Nothing to ${dir}` }
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
  if (target === null) removeDesignFile(rt, e.design)
  else { writeDesign(rt, e.design, target); if (!rt.state.designs[e.design]) rt.state.designs[e.design] = place(rt, e.design) }
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
  const open = async () => (await getBrowser()).newContext({ viewport: { width: Math.round(opts.width || lay?.width || 1080), height: 1920 }, deviceScaleFactor: format === 'pdf' ? 1 : opts.scale || 1 })
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
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm' }
const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'])

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

function template(rt: Rt, abs: string, w: number, h: number) {
  const base = path.join(rt.root, 'shared', 'base.css')
  const link = fs.existsSync(base) ? `\n<link rel="stylesheet" href="${path.relative(path.dirname(abs), base).split(path.sep).join('/')}">` : ''
  return `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">${link}
<style>
body{margin:0}
.ad{position:relative;width:${w}px;height:${h}px;overflow:hidden;font-family:Inter,sans-serif;background:#f4ece3;color:#141414}
.ad>*{position:absolute}
</style>
<div class="ad">
</div>
`
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname
  const q = url.searchParams
  const post = req.method === 'POST'
  if (p === '/api/health') return json(res, { ok: true, root: ROOT, port: PORT, mode: 'html' }), true
  if (p === '/api/boards' && !post) return json(res, { boards: readReg().map((r) => ({ ...r, exists: fs.existsSync(r.root) })) }), true
  if (p === '/api/boards' && post) {
    const b = await bodyJson(req)
    const reg = readReg()
    if (b.remove) { writeReg(reg.filter((r) => r.name !== b.remove)); boards.delete(b.remove); return json(res, { ok: true }), true }
    const root = tilde(String(b.root || ''))
    if (!safeName(String(b.name || ''))) throw new HttpError(400, 'bad board name')
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, `not a folder: ${root}`)
    if (reg.some((r) => r.name === b.name)) throw new HttpError(409, `board exists: ${b.name}`)
    writeReg([...reg, { name: b.name, root }])
    return json(res, { ok: true, name: b.name, designs: (await load(b.name)).src.size }), true
  }
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
  const rt = await load(String(boardName || ''))
  const want = q.get('design') || b.design
  const id = want ? findDesign(rt, String(want)) : ''
  const needId = () => { if (!id) throw new HttpError(400, 'missing design'); return id }

  if (p === '/api/board') return json(res, payload(rt)), true
  if (p === '/api/tree') return text(res, `${path.join(rt.root, needId())}\n${outline(rt.src.get(id)!.text)}\n`), true
  if (p === '/api/check') {
    const ids = id ? [id] : [...rt.src.keys()]
    return json(res, { results: ids.map((i) => ({ design: i, findings: lint(rt.src.get(i)!.text) })) }), true
  }
  if (p === '/api/source') return text(res, rt.src.get(needId())!.text), true
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
    for (const d of b.designs || []) if (rt.state.designs[d.id]) Object.assign(rt.state.designs[d.id], Object.fromEntries(Object.entries(d).filter(([k, v]) => ['x', 'y', 'w', 'h', 'width'].includes(k) && typeof v === 'number')))
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
  if (p === '/api/comments' && !post) return json(res, { comments: rt.state.comments.filter((c) => (q.get('all') === '1' || !c.resolved) && (!id || c.design === id)).map((c) => ({ ...c, file: path.join(rt.root, c.design) })) }), true
  if (p === '/api/comments' && post) {
    if (b.add) needId(); if (b.add) rt.state.comments.push({ id: 'c_' + crypto.randomBytes(3).toString('hex'), x: 40, y: 40, target: '', text: '', author: 'user', resolved: false, replies: [], ts: Date.now(), ...b.add, design: id } as Comment)
    if (b.update) { const c = rt.state.comments.find((c) => c.id === b.update.id); if (!c) throw new HttpError(404, `no such comment: ${b.update.id}`); Object.assign(c, b.update); if (b.reply) c.replies.push({ by: b.reply.by || 'agent', text: b.reply.text, ts: Date.now() }) }
    if (b.remove) rt.state.comments = rt.state.comments.filter((c) => c.id !== b.remove)
    saveState(rt)
    broadcast(rt, { type: 'comments', comments: rt.state.comments })
    return json(res, { ok: true, id: rt.state.comments[rt.state.comments.length - 1]?.id }), true
  }
  if (p === '/api/new' && post) {
    const name = String(b.name || '').trim()
    if (!/^[\w .()-]{1,60}$/.test(name)) throw new HttpError(400, 'bad design name')
    const [w, h] = SIZES[b.size || '4x5'] || String(b.size).split('x').map(Number)
    if (!w || !h) throw new HttpError(400, `bad size: ${b.size}`)
    const ads = fs.existsSync(path.join(rt.root, 'ads')) || !listHtml(rt.root).length
    const file = b.size === '9x16' ? 'index-9x16.html' : 'index.html'
    const rel = ads ? `ads/${name}/${file}` : `${name}.html`
    const abs = path.join(rt.root, rel)
    if (fs.existsSync(abs)) throw new HttpError(409, `already exists: ${rel}`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, template(rt, abs, w, h))
    await scan(rt, false, new Set([rel])) // on the board before we answer, so `studio new` can be followed by `tree` or `shot` at once
    return json(res, { ok: true, design: rel, file: abs }), true
  }
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
    if (!IMG.has(ext)) throw new HttpError(415, 'not an image')
    const dir = path.join(rt.root, 'studio-assets')
    fs.mkdirSync(dir, { recursive: true })
    const abs = path.join(dir, hash(buf.toString('binary')) + ext)
    fs.writeFileSync(abs, buf)
    return json(res, { src: path.relative(path.dirname(path.join(rt.root, needId())), abs).split(path.sep).join('/') }), true
  }
  if (p === '/api/export' && post) return json(res, await exportDesign(rt, needId(), b)), true
  if (p === '/api/export-all' && post) {
    const out = []
    const dir = b.out && !/\.(png|jpe?g|pdf)$/i.test(b.out) ? b.out : undefined
    for (const d of rt.src.keys()) if (!b.match || d.toLowerCase().includes(String(b.match).toLowerCase())) out.push(await exportDesign(rt, d, { ...b, out: dir }))
    return json(res, { exported: out }), true
  }
  if (p === '/api/render') {
    const format = (q.get('format') || 'png') as Format
    const r = await render(rt, needId(), { scale: Number(q.get('scale')) || 1, format })
    res.writeHead(200, { 'content-type': format === 'pdf' ? 'application/pdf' : format === 'jpg' ? 'image/jpeg' : 'image/png' }); res.end(r.buf); return true
  }
  return false
}

/** /b/<board>/<path>: the board folder, served so relative links in the designs just work. */
async function serveBoardFile(res: http.ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
  const rt = await load(parts.shift() || '')
  const rel = parts.join('/')
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
  res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-store' : 'max-age=30' })
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res) // a synced folder can fail a read after the exists check
}

const vite = await createVite({ root: APP_DIR, appType: 'spa', server: { middlewareMode: true, hmr: { port: PORT + 1 } }, logLevel: 'warn' })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname.startsWith('/b/')) return await serveBoardFile(res, url)
    if (url.pathname.startsWith('/api/')) {
      if (await api(req, res, url)) return
      throw new HttpError(404, 'unknown endpoint')
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (!res.headersSent) json(res, { ok: false, error: (e as Error).message }, status)
    else res.end()
    return
  }
  vite.middlewares(req, res)
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
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
})

// One bad request or file read must not take the editor down mid-session (edits made while it is down are lost).
process.on('uncaughtException', (e) => console.error('uncaught:', e))
server.on('error', (e) => { console.error(e); process.exit(1) }) // but a server that cannot listen should not linger
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Studio  http://127.0.0.1:${PORT}`)
  console.log(`State          ${ROOT}`)
})

const shutdown = async () => {
  for (const rt of boards.values()) if (rt.saveTimer) { clearTimeout(rt.saveTimer); fs.writeFileSync(path.join(rt.dir, 'state.json'), JSON.stringify(rt.state, null, 1)) }
  try { (await browserP)?.close() } catch { /* already gone */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
