// The board in plain language, for agents: sections, the steps in arrow order, notes tied to media,
// and every design frame with its file and open comments. Mirrors what the old card canvas digest wrote.
import path from 'node:path'
import type { Board, Item } from '../shared/types'

type Node = { id: string; x: number; y: number; w: number; h: number; kind: string; label: string }
const clean = (t?: string) => (t || '').replace(/\s+/g, ' ').trim()

export function planOf(name: string, root: string, b: Board): string {
  const items = b.items || []
  const byItem = new Map(items.map((i) => [i.id, i]))
  const notesOf = new Map<string, Item[]>()
  for (const i of items) if (i.attach && byItem.has(i.attach)) notesOf.set(i.attach, [...(notesOf.get(i.attach) || []), i])
  const comments = b.comments.filter((c) => !c.resolved)

  const label = (i: Item): string => {
    if (i.kind === 'box') return clean(i.text) ? `[${clean(i.text)}]` : '[empty box]'
    if (i.kind === 'text') return `"${clean(i.text)}"`
    if (i.kind === 'image') return `Image: ${path.join(root, i.src || '')}`
    if (i.kind === 'video') return `Video file: ${path.join(root, i.src || '')}`
    if (i.kind === 'link') return `Link: ${i.url}${clean(i.text) && clean(i.text) !== i.url ? ` (${clean(i.text)})` : ''}`
    return i.kind
  }
  const nodes = new Map<string, Node>()
  for (const i of items) if (i.kind !== 'arrow' && i.kind !== 'section' && !i.attach) nodes.set(i.id, { ...i, label: label(i) })
  for (const d of b.designs) {
    const open = comments.filter((c) => c.design === d.id)
    const what = d.loose ? 'Loose piece' : 'Design'
    const lab = `${what}: ${d.title || d.id} — file ${path.join(root, d.id)} (${d.w}×${d.h})` + (open.length ? `\n    Open comments: ${open.map((c) => `"${clean(c.text)}"${c.target ? ` on ${c.target}` : ''}`).join('; ')}` : '')
    nodes.set(d.id, { id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, kind: 'design', label: lab })
  }
  const line = (n: Node) => {
    const notes = notesOf.get(n.id)
    return notes ? `${n.label}\n    Note attached to it: "${notes.map((x) => clean(x.text)).join(' / ')}"` : n.label
  }

  const sections = items.filter((i) => i.kind === 'section').sort((a, b) => Math.round(a.y / 300) - Math.round(b.y / 300) || a.x - b.x)
  const inside = (n: Node, s: Item) => { const cx = n.x + n.w / 2, cy = n.y + n.h / 2; return cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h }
  const sectionOf = (n: Node) => sections.filter((s) => inside(n, s)).sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id ?? null
  const home = new Map([...nodes.values()].map((n) => [n.id, sectionOf(n)]))

  const edges = items.filter((i) => i.kind === 'arrow' && i.from && i.to && nodes.has(i.from) && nodes.has(i.to)).map((a) => ({ a: a.from!, b: a.to!, lab: clean(a.text) }))
  const pos = (id: string) => nodes.get(id)!

  function flows(ids: string[]) {
    const set = new Set(ids)
    const out = new Map<string, { b: string; lab: string }[]>()
    const indeg = new Map(ids.map((i) => [i, 0]))
    for (const e of edges) if (set.has(e.a) && set.has(e.b)) { out.set(e.a, [...(out.get(e.a) || []), { b: e.b, lab: e.lab }]); indeg.set(e.b, indeg.get(e.b)! + 1) }
    const used = new Set<string>()
    const res: { id: string; lab: string }[][] = []
    const order = (xs: { b: string; lab: string }[]) => [...xs].sort((p, q) => pos(p.b).x - pos(q.b).x || pos(p.b).y - pos(q.b).y)
    const walk = (seq: { id: string; lab: string }[], seen: Set<string>) => {
      let cur = seq[seq.length - 1].id
      for (;;) {
        const nxt = order((out.get(cur) || []).filter((x) => !seen.has(x.b) && !used.has(x.b)))[0]
        if (!nxt) break
        seq.push({ id: nxt.b, lab: nxt.lab }); seen.add(nxt.b); cur = nxt.b
      }
      seen.forEach((x) => used.add(x))
      res.push(seq)
    }
    const starts = ids.filter((i) => indeg.get(i) === 0 && out.has(i)).sort((p, q) => pos(p).y - pos(q).y || pos(p).x - pos(q).x)
    for (const s of [...starts, ...ids.filter((i) => out.has(i))]) if (!used.has(s)) walk([{ id: s, lab: '' }], new Set([s]))
    // branches: a step that splits into several next steps; each extra path is listed from its split point
    for (let changed = true; changed;) {
      changed = false
      for (const [a, outs] of out) for (const o of order(outs)) if (used.has(a) && !used.has(o.b)) { walk([{ id: a, lab: '' }, { id: o.b, lab: o.lab }], new Set([a, o.b])); changed = true }
    }
    return { res, used }
  }

  function section(ids: string[]): string[] {
    const lines: string[] = []
    const { res, used } = flows(ids)
    res.forEach((seq, n) => {
      const branch = n > 0 && res.slice(0, n).some((f) => f.some((x) => x.id === seq[0].id))
      lines.push(`- Flow ${n + 1} (in order)${branch ? ' — branches off the step above:' : ':'}`)
      seq.forEach((x, i) => lines.push(`  ${i + 1}. ${line(pos(x.id))}${x.lab ? ` (arrow says: ${x.lab})` : ''}`))
    })
    const rest = ids.filter((i) => !used.has(i)).map(pos).sort((p, q) => Math.round(p.y / 80) - Math.round(q.y / 80) || p.x - q.x)
    for (const n of rest) lines.push(`- ${n.kind === 'box' ? 'Box: ' : n.kind === 'text' ? 'Text: ' : ''}${line(n)}`)
    return lines
  }

  const out = [`# Studio board: ${name}`, '', `Board folder: ${root}`, '', 'Sections are separate parts of the plan. Flows are steps connected by arrows, listed in order. Designs are the HTML files on the board.', '']
  for (const s of sections) {
    const ids = [...nodes.keys()].filter((id) => home.get(id) === s.id)
    out.push(`## ${clean(s.text) || 'Section'}`)
    const body = section(ids)
    out.push(...(body.length ? body : ['- (empty)']), '')
  }
  const loose = [...nodes.keys()].filter((id) => home.get(id) === null)
  if (loose.length) { out.push(sections.length ? '## Outside any section' : '## Board'); out.push(...section(loose), '') }
  const cross = edges.filter((e) => home.get(e.a) !== home.get(e.b))
  if (cross.length && sections.length) {
    const sname = (id: string | null | undefined) => clean(sections.find((s) => s.id === id)?.text) || 'outside'
    out.push('## Connections between sections')
    for (const e of cross) out.push(`- ${pos(e.a).label.split('\n')[0]} (${sname(home.get(e.a))}) -> ${pos(e.b).label.split('\n')[0]} (${sname(home.get(e.b))})${e.lab ? ` (arrow says: ${e.lab})` : ''}`)
    out.push('')
  }
  const elsewhere = comments.filter((c) => !nodes.has(c.design))
  if (elsewhere.length) { out.push('## Other open comments'); for (const c of elsewhere) out.push(`- ${c.design}: "${clean(c.text)}"`); out.push('') }
  return out.join('\n').trimEnd() + '\n'
}
