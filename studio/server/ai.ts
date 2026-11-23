// Image tools: background removal on this Mac (Apple Vision); edit, expand, erase and upscale on Higgsfield.
// Higgsfield runs on your subscription through its official MCP server; the sign-in lives in settings.json.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as hfmcp from './hfmcp'

const run = promisify(execFile)

export type AiOp = 'removebg' | 'edit' | 'expand' | 'erase' | 'upscale' | 'fill'
export interface AiJob {
  op: AiOp
  image: Buffer // the picture as it is now (png/jpg/webp)
  marked?: Buffer // erase: the same picture with the parts to remove painted magenta
  prompt?: string
  aspect?: string // expand: the shape of the result
  model?: string // edit / erase: which image model
}

export class AiError extends Error {}

const sniff = (b: Buffer) => (b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png')

// ---- Higgsfield, through the subscription (see hfmcp.ts) ----
export const MODELS = ['gpt_image_2_6', 'nano_banana_pro', 'flux_3_image']
const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9']
/** The supported shape closest to w×h. */
export function nearestRatio(w: number, h: number) {
  const r = w / h, v = (x: string) => { const [a, b] = x.split(':').map(Number); return Math.abs(Math.log(a / b / r)) }
  return RATIOS.reduce((best, x) => (v(x) < v(best) ? x : best))
}

/** A tool result's text, or an error with Higgsfield's own words. */
function check(r: any, what: string) {
  const text = (r.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  if (r.isError || r.structuredContent?.error) throw new AiError(`Higgsfield (${what}): ${String(r.structuredContent?.error || text).split('\n')[0].slice(0, 240)}`)
  return r.structuredContent || {}
}

async function upload(dir: string, img: Buffer) {
  const type = sniff(img)
  const up = check(await hfmcp.callTool(dir, 'media_upload', { filename: `studio.${type.split('/')[1].replace('jpeg', 'jpg')}`, content_type: type }), 'upload')
  const u = up.uploads?.[0]
  if (!u?.upload_url || !u.media_id) throw new AiError('Higgsfield did not give an upload address.')
  const put = await fetch(u.upload_url, { method: 'PUT', headers: { 'Content-Type': type, 'If-None-Match': '*' }, body: new Uint8Array(img), signal: AbortSignal.timeout(180_000) })
  if (!put.ok) throw new AiError(`Upload to Higgsfield failed (${put.status})`)
  check(await hfmcp.callTool(dir, 'media_confirm', { type: 'image', media_id: u.media_id }), 'upload')
  return u.media_id as string
}

function promptFor(job: AiJob) {
  const keep = 'Keep everything else exactly as it is: same subject, product, labels, text, logos, colours, lighting, framing and size.'
  if (job.op === 'fill') return 'This photo has flat grey (#808080) empty areas along its edges. Fill ONLY those grey areas by seamlessly continuing the scene: same surface, background, lighting, perspective, grain and colour. Do not add new objects, people or text. Do not move, resize, redraw or change anything in the existing photo; keep its framing exactly where it is.'
  if (job.op === 'erase') return `The second image is the first image with some areas painted solid magenta. Return the FIRST image with everything under the magenta removed and filled in with background that matches the surroundings, as if it was never there. ${job.prompt ? `What to remove: ${job.prompt}. ` : ''}${keep} The result must contain no magenta.`
  return `${job.prompt}. ${keep.replace('Keep everything else', 'Change only what was asked; keep everything else')}`
}

const DONE = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled', 'ip_detected', 'error'])
async function higgsfield(dir: string, job: AiJob, w: number, h: number, progress: (s: string) => void) {
  if (!hfmcp.status(dir).connected) throw new AiError('NOT_CONNECTED')
  progress('Uploading the picture…')
  const id = await upload(dir, job.image)
  let sub: any
  if (job.op === 'expand') {
    sub = check(await hfmcp.callTool(dir, 'outpaint_image', { params: { image_id: id, aspect_ratio: job.aspect || 'auto' } }), 'expand')
  } else if (job.op === 'upscale') {
    sub = check(await hfmcp.callTool(dir, 'upscale_image', { params: { image_id: id, width: w, height: h, resolution: Math.max(w, h) >= 2048 ? '4k' : '4k' } }), 'upscale')
  } else {
    const medias = [{ value: id, role: 'image_references' }]
    if (job.marked) medias.push({ value: await upload(dir, job.marked), role: 'image_references' })
    // fill (drag-to-expand): GPT Image keeps the picture exactly in place, so the original can be laid back over it
    const model = job.op === 'fill' ? 'gpt_image_2_6' : job.model && MODELS.includes(job.model) ? job.model : MODELS[0]
    const params: Record<string, unknown> = { model, prompt: promptFor(job), medias, aspect_ratio: job.op === 'fill' && job.aspect ? job.aspect : nearestRatio(w, h), resolution: job.op === 'fill' && Math.max(w, h) <= 1600 ? '1k' : '2k', use_unlim: false }
    if (model.startsWith('gpt_image')) params.quality = job.op === 'fill' ? 'medium' : 'high'
    sub = check(await hfmcp.callTool(dir, 'generate_image', { params, context: 'Edit a picture on a design board' }), 'edit')
  }
  const jobId = sub.results?.[0]?.id || sub.job_id || sub.id || sub.jobs?.[0]?.job_id
  if (!jobId) throw new AiError('Higgsfield did not start a job.')
  const t0 = Date.now()
  for (;;) {
    const s = check(await hfmcp.callTool(dir, 'job_status', { jobId, sync: true }), 'status')
    const g = s.generation || s
    const secs = Math.round((Date.now() - t0) / 1000)
    if (DONE.has(g.status)) {
      if (g.status === 'nsfw' || g.status === 'ip_detected') throw new AiError(`Higgsfield's filter blocked this result (it can be a false alarm). Try again, or pick another model.`)
      if (g.status !== 'completed') throw new AiError(`Higgsfield could not do it${g.error ? `: ${g.error}` : '.'}`)
      const url = g.results?.rawUrl || g.results?.[0]?.rawUrl || g.results?.url || g.result?.url
      if (!url) throw new AiError('Higgsfield finished but sent no picture.')
      progress('Downloading the result…')
      const r = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (!r.ok) throw new AiError(`Could not download the result (${r.status})`)
      return Buffer.from(await r.arrayBuffer())
    }
    progress(`Generating… ${secs}s`)
    if (secs > 900) throw new AiError('Higgsfield took longer than 15 minutes. Check higgsfield.ai, the result may still arrive there.')
  }
}

/** The background cutter, built once from cutout.swift into the state folder. */
async function cutter(stateDir: string) {
  const bin = path.join(stateDir, 'bin', 'cutout')
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cutout.swift')
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    try { await run('swiftc', ['-O', src, '-o', bin], { timeout: 300_000 }) } catch (e) { throw new AiError(`Could not build the background remover (needs Xcode command line tools): ${(e as Error).message.slice(0, 200)}`) }
  }
  return bin
}

async function removeBg(stateDir: string, img: Buffer) {
  const bin = await cutter(stateDir)
  const tmp = fs.mkdtempSync(path.join(stateDir, 'cut-'))
  try {
    const inp = path.join(tmp, 'in' + (sniff(img) === 'image/jpeg' ? '.jpg' : sniff(img) === 'image/webp' ? '.webp' : '.png')), out = path.join(tmp, 'out.png')
    fs.writeFileSync(inp, img)
    try { await run(bin, [inp, out], { timeout: 120_000 }) } catch (e) {
      if ((e as { code?: number }).code === 2) throw new AiError('No clear subject found to cut out.')
      throw new AiError(`Background removal failed: ${(e as Error).message.slice(0, 200)}`)
    }
    return fs.readFileSync(out)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

/** Width and height of a PNG or JPEG, read from its header. */
export function sizeOf(b: Buffer): { w: number; h: number } | null {
  if (b[0] === 0x89) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b[0] === 0xff) {
    let i = 2
    while (i < b.length) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1], len = b.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  if (b.subarray(8, 12).toString() === 'WEBP') {
    const f = b.subarray(12, 16).toString()
    if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    if (f === 'VP8L') { const n = b.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) } }
  }
  return null
}

/**
 * Run a tool on a picture and save the result next to the board's other assets.
 * Returns the new file's path inside the board folder and its pixel size.
 */
export async function runAi(stateDir: string, boardRoot: string, job: AiJob, progress: (s: string) => void = () => {}) {
  const size = sizeOf(job.image) || { w: 1024, h: 1024 }
  if (job.op === 'edit' && !job.prompt?.trim()) throw new AiError('Say what to change.')
  const out = job.op === 'removebg' ? await removeBg(stateDir, job.image) : await higgsfield(stateDir, job, size.w, size.h, progress)
  const ext = sniff(out) === 'image/jpeg' ? 'jpg' : sniff(out) === 'image/webp' ? 'webp' : 'png'
  const rel = `studio-assets/${job.op}-${crypto.createHash('sha1').update(out).digest('hex').slice(0, 12)}.${ext}`
  fs.mkdirSync(path.join(boardRoot, 'studio-assets'), { recursive: true })
  fs.writeFileSync(path.join(boardRoot, rel), out)
  return { path: rel, ...(sizeOf(out) || size) }
}
