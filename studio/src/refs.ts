// References you can paste to an AI: each one names exactly one frame, piece or planning object, with the file
// path an agent can open. A frame's file path is unique across every board, so it works wherever the frame is.
import { nameOf } from './canvas/Overlay'
import { label } from './dom'
import { get, toast } from './store'

const fileOf = (id: string) => `${get().root}/${id}`
const snippet = (t: string | null | undefined) => { const s = (t || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 57) + '…' : s }

export function frameRef(id: string) {
  const s = get()
  return `Studio frame "${nameOf(s.designs[id], id)}" (board "${s.board}"): ${fileOf(id)}`
}
export function elementRef(design: string, el: Element) {
  const s = get()
  const text = snippet((el as HTMLElement).innerText)
  const what = el.tagName === 'IMG' ? `image ${el.getAttribute('src') || ''}` : label(el)
  return `Studio element ${what}${text && el.tagName !== 'IMG' ? ` "${text}"` : ''} in frame "${nameOf(s.designs[design], design)}" (board "${s.board}"): ${fileOf(design)}`
}
export function itemRef(id: string) {
  const s = get()
  const it = s.items[id]
  if (!it) return ''
  const what = { box: 'step box', text: 'text', section: 'section', image: 'picture', video: 'video', link: 'link', arrow: 'arrow' }[it.kind]
  const extra = it.kind === 'image' || it.kind === 'video' ? ` ${s.root}/${it.src}` : it.url ? ` ${it.url}` : ''
  return `Studio planning ${what}${it.text ? ` "${snippet(it.text)}"` : ''}${extra} (board "${s.board}", item ${id}; see: studio plan "${s.board}")`
}
export function copyRef(text: string) {
  if (!text) return
  navigator.clipboard.writeText(text).then(() => toast('Copied. Paste it to any AI to point at exactly this.'), () => toast('Could not copy (the browser blocked the clipboard).'))
}
