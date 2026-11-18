// What a picture actually looks like. Cut-out PNGs, CSS masks and rotation mean an image's
// layout box can be far bigger than the visible picture. This builds a small alpha map of each
// image as rendered (transparency + mask), so clicks and selection boxes follow what you see.

/** rows = first and last visible column of each row (-1 when the row is empty). fill = share of the box that is visible. */
export interface AlphaMap { gw: number; gh: number; data: Uint8Array; rows: Int16Array; fill: number }
const maps = new WeakMap<Element, AlphaMap | 'pending' | 'none'>()
const THRESHOLD = 28

/** Drop a picture's map (its file, fit, mask or blend changed). prepareImages builds a new one. */
export const forget = (el: Element) => { maps.delete(el) }
// White does not show under these blend modes, so a JPG on white is only there where it is dark.
const KNOCKS_OUT_WHITE = new Set(['multiply', 'darken', 'color-burn'])

export function mapOf(el: Element): AlphaMap | null {
  const m = maps.get(el)
  return m && m !== 'pending' && m !== 'none' ? m : null
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src })
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

async function build(img: HTMLImageElement): Promise<AlphaMap | 'none'> {
  const w = img.offsetWidth, h = img.offsetHeight
  if (!w || !h || !img.complete || !img.naturalWidth) return 'none'
  const k = Math.min(1, 180 / Math.max(w, h))
  const gw = Math.max(8, Math.round(w * k)), gh = Math.max(8, Math.round(h * k))
  const c = document.createElement('canvas')
  c.width = gw; c.height = gh
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, gw, gh)
  let pixels: Uint8ClampedArray
  let small: string
  try { pixels = ctx.getImageData(0, 0, gw, gh).data; small = c.toDataURL('image/png') } catch { return 'none' } // cross-origin image
  const cs = getComputedStyle(img)
  const mask = cs.maskImage || (cs as unknown as Record<string, string>).webkitMaskImage
  if (mask && mask !== 'none' && !mask.includes('url(')) {
    const comp = (cs as unknown as Record<string, string>).webkitMaskComposite || 'source-over'
    const style = `display:block;width:${gw}px;height:${gh}px;-webkit-mask-image:${mask};mask-image:${mask};-webkit-mask-size:${cs.maskSize};mask-size:${cs.maskSize};-webkit-mask-position:${cs.maskPosition};mask-position:${cs.maskPosition};-webkit-mask-repeat:${cs.maskRepeat};mask-repeat:${cs.maskRepeat};-webkit-mask-composite:${comp};mask-composite:${cs.maskComposite}`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gw}" height="${gh}"><foreignObject width="100%" height="100%"><img xmlns="http://www.w3.org/1999/xhtml" src="${small}" style="${esc(style)}"/></foreignObject></svg>`
    try {
      const im = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
      ctx.clearRect(0, 0, gw, gh)
      ctx.drawImage(im, 0, 0)
      pixels = ctx.getImageData(0, 0, gw, gh).data
    } catch { /* keep the unmasked alpha */ }
  }
  const data = new Uint8Array(gw * gh)
  const rows = new Int16Array(gh * 2).fill(-1)
  let count = 0
  const knock = KNOCKS_OUT_WHITE.has(cs.mixBlendMode)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = (y * gw + x) * 4
    let a = pixels[i + 3]
    if (knock) a = Math.round((a * (255 - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]))) / 255)
    data[y * gw + x] = a
    if (a > THRESHOLD) { count++; if (rows[y * 2] < 0) rows[y * 2] = x; rows[y * 2 + 1] = x }
  }
  // a blended photo is one solid thing: light parts inside its outline (a white label on the bottle) still take the click
  if (knock) for (let y = 0; y < gh; y++) for (let x = rows[y * 2]; x >= 0 && x <= rows[y * 2 + 1]; x++) if (data[y * gw + x] <= THRESHOLD) { data[y * gw + x] = 255; count++ }
  if (!count) return 'none'
  return { gw, gh, data, rows, fill: count / (gw * gh) }
}

/** Build maps for every image in a document. Resolves when all are ready. */
export async function prepareImages(doc: Document): Promise<void> {
  const jobs: Promise<void>[] = []
  doc.querySelectorAll<HTMLImageElement>('img[data-sid]').forEach((img) => {
    if (maps.has(img)) return
    maps.set(img, 'pending')
    // wait for the picture itself: a map built from a half-loaded image would be wrong forever
    const ready = img.complete && img.naturalWidth ? Promise.resolve() : new Promise<void>((res) => { img.addEventListener('load', () => res(), { once: true }); img.addEventListener('error', () => res(), { once: true }) })
    jobs.push(ready.then(() => build(img)).then((m) => { maps.set(img, m) }, () => { maps.set(img, 'none') }))
  })
  await Promise.all(jobs)
}

/** The element's own 2D transform (rotate, scale, transform), without translation. */
export function linear(el: Element): { a: number; b: number; c: number; d: number } {
  const cs = getComputedStyle(el)
  let m = new DOMMatrix()
  if (cs.rotate && cs.rotate !== 'none') m = m.rotate(parseFloat(cs.rotate) || 0)
  if (cs.scale && cs.scale !== 'none') { const [sx, sy] = cs.scale.split(' ').map(Number); m = m.scale(sx || 1, sy || sx || 1) }
  if (cs.transform && cs.transform !== 'none') m = m.multiply(new DOMMatrix(cs.transform))
  return { a: m.a, b: m.b, c: m.c, d: m.d }
}

/** Is the picture visibly there at this point (document coordinates)? True when unknown. */
export function opaqueAt(el: HTMLElement, x: number, y: number): boolean {
  const map = mapOf(el)
  if (!map) return true
  const r = el.getBoundingClientRect()
  const { a, b, c, d } = linear(el)
  const det = a * d - b * c || 1
  const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2)
  const w = el.offsetWidth, h = el.offsetHeight
  const u = ((d * dx - c * dy) / det + w / 2) / w, v = ((-b * dx + a * dy) / det + h / 2) / h
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return false
  return map.data[Math.floor(v * map.gh) * map.gw + Math.floor(u * map.gw)] > THRESHOLD
}

/** Bounds of the visible picture in document coordinates, or null to use the layout box. */
export function visibleRect(el: HTMLElement): { left: number; top: number; width: number; height: number } | null {
  const map = mapOf(el)
  if (!map) return null
  const r = el.getBoundingClientRect()
  const { a, b, c, d } = linear(el)
  const w = el.offsetWidth, h = el.offsetHeight
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  // push the outline of the visible pixels through the element's rotation, row by row
  for (let y = 0; y < map.gh; y++) {
    const lo = map.rows[y * 2]
    if (lo < 0) continue
    const hi = map.rows[y * 2 + 1] + 1
    for (const v of [y, y + 1]) for (const u of [lo, hi]) {
      const lx = (u / map.gw) * w - w / 2, ly = (v / map.gh) * h - h / 2
      const px = cx + a * lx + c * ly, py = cy + b * lx + d * ly
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py
    }
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 }
}

/** Share of a design's area that the picture visibly covers. */
export function coverage(el: HTMLElement, designArea: number): number | null {
  const map = mapOf(el)
  if (!map) return null
  const { a, b, c, d } = linear(el)
  return (map.fill * el.offsetWidth * el.offsetHeight * Math.abs(a * d - b * c)) / designArea
}
