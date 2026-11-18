// Edit an HTML file's source in place. Every element gets a "sid" (its index in document
// order); edits are text splices at that element's exact source offsets, so the rest of the
// file, including the agent's formatting, stays byte-for-byte the same.
import { parse } from 'parse5'
import type { Edit } from '../shared/types'

interface Loc { startOffset: number; endOffset: number; startLine: number; startCol: number }
export interface El {
  sid: number
  tag: string
  parent: number | null
  depth: number
  start: number
  end: number
  line: number
  startTag: { start: number; end: number }
  endTag: { start: number; end: number } | null
  attrs: Record<string, { value: string; start: number; end: number }>
  text: string // own text, collapsed
}

export function indexHtml(source: string): El[] {
  const doc = parse(source, { sourceCodeLocationInfo: true }) as any
  const out: El[] = []
  const walk = (node: any, parent: number | null, depth: number) => {
    let me = parent
    let d = depth
    const loc = node.sourceCodeLocation
    if (node.tagName && loc && loc.startTag) {
      const attrs: El['attrs'] = {}
      for (const a of node.attrs || []) {
        const al: Loc | undefined = loc.attrs?.[a.name]
        if (al) attrs[a.name] = { value: a.value, start: al.startOffset, end: al.endOffset }
      }
      const text = (node.childNodes || []).filter((c: any) => c.nodeName === '#text').map((c: any) => c.value).join(' ').replace(/\s+/g, ' ').trim()
      me = out.length
      d = depth + 1
      out.push({
        sid: me!, tag: node.tagName, parent, depth, start: loc.startOffset, end: loc.endOffset, line: loc.startLine,
        startTag: { start: loc.startTag.startOffset, end: loc.startTag.endOffset },
        endTag: loc.endTag ? { start: loc.endTag.startOffset, end: loc.endTag.endOffset } : null,
        attrs, text,
      })
    }
    for (const c of node.childNodes || []) walk(c, me, d)
    if (node.content) for (const c of node.content.childNodes || []) walk(c, me, d)
  }
  walk(doc, null, 0)
  return out
}

const EDITOR_CSS = '<style data-studio>html{scrollbar-width:none}::-webkit-scrollbar{display:none}[contenteditable]{outline:none!important;cursor:text;-webkit-user-modify:read-write}</style>'

/** Copy of the source for the editor: each element tagged with data-sid. Never saved. */
export function annotate(source: string): string {
  const els = indexHtml(source)
  let out = source
  for (let i = els.length - 1; i >= 0; i--) {
    const at = els[i].startTag.start + 1 + els[i].tag.length
    out = out.slice(0, at) + ` data-sid="${els[i].sid}"` + out.slice(at)
  }
  return out + EDITOR_CSS
}

export function parseDecls(style: string): [string, string][] {
  const out: [string, string][] = []
  let depth = 0, quote = '', cur = ''
  const push = () => {
    const i = cur.indexOf(':')
    if (i > 0) out.push([cur.slice(0, i).trim(), cur.slice(i + 1).trim()])
    cur = ''
  }
  for (const ch of style) {
    if (quote) { if (ch === quote) quote = ''; cur += ch; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) push()
    else cur += ch
  }
  if (cur.trim()) push()
  return out
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function setAttr(source: string, el: El, name: string, value: string | null): string {
  const a = el.attrs[name]
  if (a) {
    if (value === null) {
      const from = source[a.start - 1] === ' ' ? a.start - 1 : a.start
      return source.slice(0, from) + source.slice(a.end)
    }
    return source.slice(0, a.start) + `${name}="${escAttr(value)}"` + source.slice(a.end)
  }
  if (value === null) return source
  const selfClose = source[el.startTag.end - 2] === '/'
  const at = el.startTag.end - (selfClose ? 2 : 1)
  const pad = source[at - 1] === ' ' ? '' : ' '
  return source.slice(0, at) + `${pad}${name}="${escAttr(value)}"` + source.slice(at)
}

export interface Applied { source: string; structural: boolean; newSid: number | null; notes: string[] }

/** Apply edits one after another. Throws if an element is missing. */
export function applyEdits(source: string, edits: Edit[]): Applied {
  let structural = false
  let newSid: number | null = null
  const notes: string[] = []
  // delete later elements first so earlier sids stay valid within one batch
  const ordered = [...edits].sort((a, b) => (a.kind === 'remove' && b.kind === 'remove' ? b.sid - a.sid : 0))
  for (const e of ordered) {
    const els = indexHtml(source)
    const id = e.kind === 'insert' ? e.parent : e.sid
    const el = els[id]
    if (!el) throw new Error(`element ${id} not found (the file changed)`)
    const who = describe(el)
    if (e.kind === 'style') {
      const decls = parseDecls(el.attrs.style?.value || '')
      const changes: string[] = []
      for (const [k, v] of Object.entries(e.props)) {
        const i = decls.findIndex(([n]) => n === k)
        const before = i >= 0 ? decls[i][1] : null
        if (v === null) { if (i >= 0) decls.splice(i, 1) } else if (i >= 0) decls[i][1] = v; else decls.push([k, v])
        if (before !== v) changes.push(`${k}: ${before ?? '(from css)'} → ${v ?? '(removed)'}`)
      }
      if (!changes.length) continue
      source = setAttr(source, el, 'style', decls.length ? decls.map(([k, v]) => `${k}:${v}`).join(';') : null)
      notes.push(`${who}  ${changes.join(', ')}`)
    } else if (e.kind === 'attr') {
      const before = el.attrs[e.name]?.value ?? null
      if (before === e.value) continue
      source = setAttr(source, el, e.name, e.value)
      notes.push(`${who}  ${e.name}: ${short(before)} → ${short(e.value)}`)
    } else if (e.kind === 'inner') {
      const from = el.startTag.end, to = el.endTag ? el.endTag.start : el.end
      const before = source.slice(from, to)
      if (before === e.html) continue
      source = source.slice(0, from) + e.html + source.slice(to)
      structural = true
      notes.push(`${who}  content: ${short(before)} → ${short(e.html)}`)
    } else if (e.kind === 'remove') {
      source = source.slice(0, el.start) + source.slice(el.end)
      structural = true
      notes.push(`${who}  deleted`)
    } else if (e.kind === 'duplicate') {
      source = source.slice(0, el.end) + source.slice(el.start, el.end) + source.slice(el.end)
      structural = true
      newSid = indexHtml(source).find((x) => x.start === el.end)?.sid ?? null
      notes.push(`${who}  duplicated`)
    } else if (e.kind === 'insert') {
      const at = el.endTag ? el.endTag.start : el.end
      source = source.slice(0, at) + e.html + source.slice(at)
      structural = true
      newSid = indexHtml(source).find((x) => x.start === at)?.sid ?? null
      notes.push(`added ${short(e.html)} inside ${who}`)
    }
  }
  return { source, structural, newSid, notes }
}

const short = (v: string | null) => (v == null ? '(none)' : JSON.stringify(v.length > 90 ? v.slice(0, 87) + '…' : v))

export function describe(el: El): string {
  const cls = (el.attrs.class?.value || '').split(/\s+/).filter(Boolean).map((c) => '.' + c).join('')
  const id = el.attrs.id ? '#' + el.attrs.id.value : ''
  const txt = el.text ? ` "${el.text.length > 40 ? el.text.slice(0, 37) + '…' : el.text}"` : ''
  return `<${el.tag}${id}${cls}>${txt} (line ${el.line})`
}

/** Indented outline of the body for agents. */
export function outline(source: string): string {
  const els = indexHtml(source)
  const skip = new Set(['html', 'head', 'meta', 'link', 'style', 'script', 'title', 'br', 'path', 'circle', 'rect', 'line', 'g', 'defs', 'polyline', 'polygon', 'ellipse', 'stop', 'lineargradient'])
  const hidden = new Set<number>()
  const lines: string[] = []
  for (const el of els) {
    if (el.parent != null && hidden.has(el.parent)) { hidden.add(el.sid); continue }
    if (el.tag === 'head' || el.tag === 'svg') hidden.add(el.sid)
    if (skip.has(el.tag)) continue
    const st = el.attrs.style ? `  style="${el.attrs.style.value.length > 110 ? el.attrs.style.value.slice(0, 107) + '…' : el.attrs.style.value}"` : ''
    const src = el.attrs.src ? `  src=${el.attrs.src.value.startsWith('data:') ? 'data-uri' : el.attrs.src.value}` : ''
    lines.push(`${String(el.line).padStart(4)}  ${'  '.repeat(Math.max(0, el.depth - 1))}${describe(el).replace(/ \(line \d+\)$/, '')}${src}${st}`)
  }
  return lines.join('\n')
}

/** One tag per line, so a line diff of two versions reads element by element. */
export function oneTagPerLine(source: string): string {
  return source.replace(/>\s*</g, '>\n<')
}

const INLINE_TAGS = new Set(['em', 'i', 'b', 'strong', 'span', 'u', 'small', 'sup', 'sub', 'mark', 'a', 'br', 's', 'code', 'font'])

/**
 * Check a design against the authoring rules in AUTHORING.md: things that make it hard for
 * the user to select, move or retype elements on the board. Returns plain-language findings.
 */
export function lint(source: string): { level: 'fix' | 'note'; msg: string }[] {
  const out: { level: 'fix' | 'note'; msg: string }[] = []
  const els = indexHtml(source)
  const art = els.find((e) => (e.attrs.class?.value || '').split(/\s+/).includes('ad') || 'data-artboard' in e.attrs)
  const css = (source.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n')
  const inline = els.map((e) => e.attrs.style?.value || '').join('\n')
  if (!art) out.push({ level: 'note', msg: 'No .ad (or data-artboard) element: the board treats this as a flow page. Text, colours and images are editable, positions are not.' })
  const scripts = els.filter((e) => e.tag === 'script' && !e.attrs.src?.value?.includes('fonts'))
  if (scripts.length) out.push({ level: 'fix', msg: `<script> at line ${scripts[0].line}: anything it creates cannot be selected or edited on the board. Write the final HTML out instead.` })
  const pseudo = (css.match(/::?(before|after)\s*\{[^}]*content\s*:\s*(?!["']\s*["']|none|normal)[^;}]+/gi) || []).length
  if (pseudo) out.push({ level: 'fix', msg: `${pseudo} ::before/::after rule${pseudo > 1 ? 's' : ''} with visible content: pseudo-elements cannot be selected. Use a real element for anything they may want to move or change.` })
  // a backdrop on the artboard (or body) itself is fine; pictures on anything else should be <img>
  const bgRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background(-image)?\s*:[^;}]*url\(/i.test(m[2]) && !/^\s*(\.ad|body|html|\[data-artboard\])\s*$/.test(m[1].split(',')[0]))
  const bgInline = els.filter((e) => e.sid !== art?.sid && e.tag !== 'body' && /background(-image)?\s*:[^;]*url\(/i.test(e.attrs.style?.value || ''))
  const bgUrl = [...bgRules, ...bgInline]
  if (bgUrl.length) out.push({ level: 'fix', msg: `${bgUrl.length} picture${bgUrl.length > 1 ? 's' : ''} set as a CSS background: use an <img> so it can be grabbed, resized and replaced. (A full-bleed backdrop on .ad itself is fine.)` })
  const important = ((css + inline).match(/!important/gi) || []).length
  if (important && art) out.push({ level: 'fix', msg: `${important} use${important > 1 ? 's' : ''} of !important: their edits are inline styles and lose to !important.` })
  if (/pointer-events\s*:\s*none/i.test(css + inline)) out.push({ level: 'fix', msg: 'pointer-events:none found: those elements cannot be clicked on the board.' })
  if (art) {
    const kids = els.filter((e) => e.parent === art.sid && !['style', 'script', 'link'].includes(e.tag))
    const byParent = new Map<number, El[]>()
    for (const e of els) if (e.parent != null) byParent.set(e.parent, [...(byParent.get(e.parent) || []), e])
    // an inline icon counts as one piece, however many paths it has
    const count = (sid: number): number => (byParent.get(sid) || []).reduce((n, c) => n + 1 + (c.tag === 'svg' ? 0 : count(c.sid)), 0)
    for (const e of els) {
      const children = byParent.get(e.sid) || []
      const blocks = children.filter((c) => !INLINE_TAGS.has(c.tag) && c.tag !== 'svg')
      if (e.sid !== art.sid && e.text && blocks.length && e.tag !== 'svg' && !['style', 'script', 'title', 'head', 'html', 'body'].includes(e.tag))
        out.push({ level: 'fix', msg: `line ${e.line} ${describe(e).replace(/ \(line \d+\)$/, '')}: loose text mixed with <${blocks[0].tag}> inside one element. Give the text its own element so it can be selected and retyped.` })
    }
    const wrappers = kids.filter((k) => count(k.sid) > 20)
    for (const w of wrappers) out.push({ level: 'fix', msg: `line ${w.line} ${describe(w).replace(/ \(line \d+\)$/, '')}: holds ${count(w.sid)} elements, so the board treats it as background. Keep groups small (20 or fewer) or put the pieces directly in .ad.` })
    const unnamed = kids.filter((k) => !k.attrs.class && !k.attrs.id && k.tag !== 'svg')
    if (unnamed.length) out.push({ level: 'note', msg: `${unnamed.length} top-level element${unnamed.length > 1 ? 's have' : ' has'} no class (first at line ${unnamed[0].line}). Class names are the layer names they sees: name them (headline, hero, badge).` })
    const offEdge = kids.filter((k) => /(^|;)\s*(right|bottom)\s*:/i.test(k.attrs.style?.value || ''))
    if (offEdge.length) out.push({ level: 'note', msg: `${offEdge.length} element${offEdge.length > 1 ? 's are' : ' is'} placed with right/bottom (first at line ${offEdge[0].line}). left + top make their drags save as clean left/top values instead of a translate.` })
    if (/\.ad\s*>\s*\*\s*\{[^}]*position\s*:\s*absolute/i.test(css) === false && kids.some((k) => !/position\s*:/.test(k.attrs.style?.value || '')) && !/position\s*:\s*absolute/i.test(css))
      out.push({ level: 'note', msg: 'Top-level elements are not absolutely positioned. Add `.ad>*{position:absolute}` so each piece moves independently.' })
  }
  return out
}
