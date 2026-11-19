// The Claude session working on this board's card, beside the canvas: its conversation, and a box to send it a
// follow-up (typed into its Orca terminal). The work board (another local server) knows which card and session.
import { useEffect, useRef, useState } from 'react'
import { renderMd } from '../md'
import { useStore } from '../store'

type Card = { id: string; title: string; brand: string; status: string }
type Agent = { linked: boolean; state?: 'working' | 'waiting' | 'ended'; title?: string; messages?: { role: 'you' | 'claude'; text: string }[]; canSend?: boolean }

let WB = 'http://127.0.0.1:4477'
const ready = fetch('/api/config').then((r) => r.json()).then((c) => { if (c.workboard) WB = c.workboard }).catch(() => {})
const pref = () => { try { return localStorage.getItem('studioChat') !== '0' } catch { return true } }

export function AgentPanel() {
  const board = useStore((s) => s.board)
  const [card, setCard] = useState<Card | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [open, setOpen] = useState(pref)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const count = useRef(0)

  useEffect(() => {
    let off = false
    setCard(null); setAgent(null)
    ready.then(() => fetch(`${WB}/api/studio-card?board=${encodeURIComponent(board)}`)).then((r) => r.json()).then((j) => { if (!off) setCard(j.card) }).catch(() => {})
    return () => { off = true }
  }, [board])
  useEffect(() => {
    if (!card) return
    let off = false
    const tick = () => fetch(`${WB}/api/agent/${encodeURIComponent(card.id)}`).then((r) => r.json()).then((a) => { if (!off) setAgent(a) }).catch(() => {})
    tick()
    const t = setInterval(tick, open ? 3000 : 8000)
    return () => { off = true; clearInterval(t) }
  }, [card, open])
  useEffect(() => {
    const el = list.current
    if (!el || !agent?.messages) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (near || agent.messages.length !== count.current) el.scrollTop = el.scrollHeight
    count.current = agent.messages.length
  }, [agent, open])

  if (!card || !agent?.linked) return null
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem('studioChat', v ? '1' : '0') } catch { /* private window */ } }
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const r = await fetch(`${WB}/api/agent/${encodeURIComponent(card.id)}/send`, { method: 'POST', body: JSON.stringify({ text: t }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) alert(j.error || "Couldn't send")
      else setText('')
    } finally { setBusy(false) }
  }
  const openTerm = async () => {
    const r = await fetch(`${WB}/api/agent/${encodeURIComponent(card.id)}/open`, { method: 'POST' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || "Couldn't open it in Orca") }
  }
  const label = agent.state === 'waiting' ? 'Waiting on you' : agent.state === 'ended' ? 'Session closed' : 'Working…'
  if (!open) return <button className="ag-toggle" onClick={() => toggle(true)} title="Show the Claude session working on this"><span className={`ag-dot ${agent.state}`} />Claude</button>
  return (
    <aside className="ag-panel" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="ag-head">
        <span className={`ag-dot ${agent.state}`} />
        <div className="ag-titles"><b>{label}</b><span>{agent.title || card.title}</span></div>
        {agent.state !== 'ended' && <button className="ag-btn" onClick={openTerm} title="Jump to this terminal in Orca">Open ↗</button>}
        <button className="ag-btn" onClick={() => toggle(false)} title="Hide">✕</button>
      </div>
      <div className="ag-msgs" ref={list}>
        {agent.messages?.length ? agent.messages.map((m, i) => <div key={i} className={`ag-m ${m.role}`} dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />)
          : <div className="ag-m empty">No messages yet</div>}
      </div>
      {agent.canSend && (
        <form className="ag-send" onSubmit={send}>
          <textarea rows={2} value={text} placeholder="Message this Claude session" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e) }} />
          <button type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
    </aside>
  )
}
