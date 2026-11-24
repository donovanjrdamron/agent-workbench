// The Claude sessions working on this board's cards, beside the canvas: one conversation at a time (picked from a
// dropdown), and a box to send it a follow-up (typed into its Orca terminal). The work board (another local server)
// knows which cards and sessions work on this board.
import { useEffect, useRef, useState } from 'react'
import { renderMd } from '../md'
import { useStore } from '../store'
import { wb, wbBase } from '../workboard'

type State = 'working' | 'waiting' | 'ended' | 'starting'
type Session = { cid: string; card: string; done: boolean; pid: string; state: State; title: string; linked: number; resumable?: boolean }
type Cmd = { name: string; description: string; source: string }
type Agent = { linked: boolean; pid?: string; state?: State; title?: string; messages?: { role: 'you' | 'claude'; text: string }[]; canSend?: boolean; resumable?: boolean }

let WB = 'http://127.0.0.1:4477'
wbBase().then((b) => { WB = b })
const pickKey = (board: string) => `studioChatSession:${board}`
const sentKey = (board: string) => `studioCommentsSent:${board}`
const getSent = (board: string) => { try { return Number(localStorage.getItem(sentKey(board))) || 0 } catch { return 0 } }
const one = (t: string) => t.replace(/\s+/g, ' ').trim()
const norm = one
const pref = () => { try { return localStorage.getItem('studioChat') !== '0' } catch { return true } }
const stText = (s?: State) => (s === 'working' ? 'Working…' : s === 'starting' ? 'Turning on…' : s === 'waiting' ? 'Online · waiting on you' : 'Offline')
const name = (s: { title?: string; card?: string }) => s.title || s.card || 'Untitled session'
const ago = (t: number) => { const s = Date.now() / 1000 - t; return s < 3600 ? 'just now' : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

export const Spinner = () => (
  <svg className="ag-spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" /><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
)
const Status = ({ s }: { s?: State }) => <span className="ag-st">{s === 'working' || s === 'starting' ? <Spinner /> : <span className={`ag-dot ${s === 'ended' ? 'ended' : 'online'}`} />}</span>

export function AgentPanel() {
  const board = useStore((s) => s.board)
  const comments = useStore((s) => s.comments)
  const [sentAt, setSentAt] = useState(0) // comments you wrote (or replied to) after this went to the agent are "new"
  useEffect(() => setSentAt(getSent(board)), [board])
  const [sessions, setSessions] = useState<Session[]>([])
  const [pick, setPick] = useState<string | null>(null) // "<card id>:<pid>"
  const cur = sessions.find((s) => `${s.cid}:${s.pid}` === pick) || sessions[0] || null
  const [agent, setAgent] = useState<Agent | null>(null)
  const [open, setOpen] = useState(pref)
  const [menu, setMenu] = useState(false)
  const [cmMenu, setCmMenu] = useState(false) // several sessions on the board: pick which one gets the comments
  const cmRef = useRef<HTMLDivElement>(null)
  // "/" suggests commands and skills, as in the terminal
  const cmds = useRef<{ key: string; list: Promise<Cmd[]> } | null>(null)
  const [hits, setHits] = useState<Cmd[]>([])
  const [at, setAt] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null) // the name being typed (double-click the session name)
  const [text, setText] = useState('')
  // what you just sent shows at once; the session's own record catches up a moment later
  const [sent, setSent] = useState<{ text: string; n: string; at: number; k: string }[]>([])
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [dropping, setDropping] = useState(false)
  const [starting, setStarting] = useState('') // "<card>:<pid>" being turned back on, until it answers

  useEffect(() => {
    let off = false
    setSessions([]); setAgent(null)
    try { setPick(localStorage.getItem(pickKey(board))) } catch { setPick(null) }
    // new sessions join while the board is open: look again now and then
    const load = () => wb(`/api/studio-sessions?board=${encodeURIComponent(board)}`).then((r) => r.json()).then((j) => { if (!off) setSessions(j.sessions || []) }).catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => { off = true; clearInterval(t) }
  }, [board])
  const resume = async (s: { cid: string; pid: string }) => {
    setStarting(`${s.cid}:${s.pid}`)
    const r = await fetch(`${WB}/api/agent/${encodeURIComponent(s.cid)}/resume?pid=${encodeURIComponent(s.pid)}`, { method: 'POST' }).then((r) => r.json()).catch(() => ({ error: 'The work board is not answering' }))
    if (r.error) { setStarting(''); alert(r.error) }
    setTimeout(() => setStarting(''), 60000)
  }
  const choose = (s: Session) => {
    const k = `${s.cid}:${s.pid}`
    setMenu(false)
    if (s.state === 'ended' && s.resumable) resume(s)
    if (k === (cur && `${cur.cid}:${cur.pid}`)) return
    setPick(k); setAgent(null); count.current = 0
    try { localStorage.setItem(pickKey(board), k) } catch { /* private window */ }
  }
  useEffect(() => {
    if (!cur) return
    let off = false
    const tick = () => fetch(`${WB}/api/agent/${encodeURIComponent(cur.cid)}?pid=${encodeURIComponent(cur.pid)}`).then((r) => r.json()).then((a) => { if (!off) setAgent(a) }).catch(() => {})
    tick()
    const t = setInterval(tick, open ? 3000 : 8000)
    return () => { off = true; clearInterval(t) }
  }, [cur?.cid, cur?.pid, open])
  useEffect(() => {
    const el = list.current
    if (!el || !agent?.messages) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (near || agent.messages.length !== count.current) el.scrollTop = el.scrollHeight
    count.current = agent.messages.length
  }, [agent, open])
  useEffect(() => {
    if (!cmMenu) return
    const away = (e: PointerEvent) => { if (!cmRef.current?.contains(e.target as Node)) setCmMenu(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [cmMenu])
  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [menu])

  if (!cur || !agent?.linked) return null
  // the live state comes from the conversation itself (fresher than the list, which refreshes every 10s)
  const key = `${cur.cid}:${cur.pid}`
  const state: State = starting === key && agent.state === 'ended' ? 'starting' : agent.state || cur.state
  const live = sessions.map((s) => (s === cur ? { ...s, state } : starting === `${s.cid}:${s.pid}` && s.state === 'ended' ? { ...s, state: 'starting' as State } : s))
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem('studioChat', v ? '1' : '0') } catch { /* private window */ } }
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault()
    // empty box while it works: the button is Stop (Esc, as in the terminal)
    const t = !text.trim() && state === 'working' ? '\u001b' : text.trim()
    if (!t || busy) return
    const q = t === '\u001b' ? null : { text: t, n: norm(t), at: Date.now(), k: `${cur.cid}:${cur.pid}` }
    if (q) { setSent((l) => [...l, q]); setText(''); if (area.current) area.current.style.height = 'auto'; requestAnimationFrame(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }) }
    setBusy(true)
    try {
      const r = await fetch(`${WB}/api/agent/${encodeURIComponent(cur.cid)}/send?pid=${encodeURIComponent(cur.pid)}`, { method: 'POST', body: JSON.stringify({ text: t }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { if (q) { setSent((l) => l.filter((x) => x !== q)); setText((v) => v || t) } alert(j.error || "Couldn't send") }
    } catch { if (q) { setSent((l) => l.filter((x) => x !== q)); setText((v) => v || t) } } finally { setBusy(false) }
  }
  // your open comments (and your replies) since the last time they went to the agent: one click sends them all
  const lastYou = (c: (typeof comments)[number]) => Math.max(c.author === 'user' ? c.ts : 0, ...c.replies.filter((r) => r.by !== 'agent').map((r) => r.ts))
  const fresh = comments.filter((c) => !c.resolved && c.text.trim() && lastYou(c) > sentAt)
  const sendComments = async (to: { cid: string; pid: string }) => {
    setCmMenu(false)
    if (!fresh.length || busy) return
    const where = (c: (typeof fresh)[number]) => (c.design ? `${c.design}${c.target ? ` (${one(c.target).slice(0, 80)})` : ''}` : `the board${c.target ? ` (${one(c.target).slice(0, 80)})` : ''}`)
    const body = fresh.map((c, i) => {
      const yours = c.replies.filter((r) => r.by !== 'agent' && r.ts > sentAt)
      const said = c.author === 'user' && c.ts > sentAt ? `"${one(c.text)}"` : `on your note "${one(c.text).slice(0, 120)}", I replied: ${yours.map((r) => `"${one(r.text)}"`).join(' ')}`
      return `(${i + 1}) [${c.id}] on ${where(c)}: ${said}`
    }).join(' ')
    const n = fresh.length
    const t = `I left ${n} new comment${n > 1 ? 's' : ''} on the Studio board "${board}". Work through ${n > 1 ? 'each one' : 'it'}, then answer each with: studio reply "${board}" <id> "what you changed" --resolve (run studio comments "${board}" for the full detail). ${body}`
    setBusy(true)
    try {
      const r = await fetch(`${WB}/api/agent/${encodeURIComponent(to.cid)}/send?pid=${encodeURIComponent(to.pid)}`, { method: 'POST', body: JSON.stringify({ text: t }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { alert(j.error || "Couldn't send"); return }
      const now = Date.now()
      setSentAt(now)
      try { localStorage.setItem(sentKey(board), String(now)) } catch { /* private window */ }
    } finally { setBusy(false) }
  }
  const rename = async (v: string | null) => {
    setRenaming(null)
    const t = (v || '').trim()
    if (!t || t === agent.title) return
    setAgent({ ...agent, title: t })
    const r = await fetch(`${WB}/api/agent/${encodeURIComponent(cur.cid)}/rename?pid=${encodeURIComponent(cur.pid)}`, { method: 'POST', body: JSON.stringify({ title: t }) }).then((r) => r.json()).catch(() => ({ error: 'The work board is not answering' }))
    if (r.error) alert(r.error)
    else setSessions((l) => l.map((s) => (s.cid === cur.cid && s.pid === cur.pid ? { ...s, title: t } : s)))
  }
  const suggest = async (v: string, caret: number) => {
    if (!/^\/\S*$/.test(v) || caret !== v.length) { setHits([]); return }
    const key = `${cur.cid}:${cur.pid}`
    if (cmds.current?.key !== key) cmds.current = { key, list: fetch(`${WB}/api/agent/${encodeURIComponent(cur.cid)}/commands?pid=${encodeURIComponent(cur.pid)}`).then((r) => r.json()).then((j) => ((j.commands || []) as Cmd[]).filter((x) => !x.name.startsWith('_'))).catch(() => []) }
    const all = await cmds.current.list
    // what is in the box now: it may have changed while the list loaded
    const t = area.current, m = t?.value.match(/^\/(\S*)$/)
    if (!t || !m || t.selectionStart !== t.value.length) { setHits([]); return }
    const q = m[1].toLowerCase()
    const starts = all.filter((x) => x.name.toLowerCase().startsWith(q)), inName = all.filter((x) => !starts.includes(x) && x.name.toLowerCase().includes(q))
    setHits([...starts, ...inName, ...(q.length > 2 ? all.filter((x) => !starts.includes(x) && !inName.includes(x) && x.description.toLowerCase().includes(q)) : [])].slice(0, 40))
    setAt(0)
  }
  const pickCmd = (n: string) => { setText(`/${n} `); setHits([]); requestAnimationFrame(() => { const t = area.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) } }) }
  const openTerm = async () => {
    const r = await fetch(`${WB}/api/agent/${encodeURIComponent(cur.cid)}/open?pid=${encodeURIComponent(cur.pid)}`, { method: 'POST' })
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || "Couldn't open it in Orca") }
  }
  // drop, paste or pick files: each is saved by the work board (~/.claude/drops) and its full path goes into the message
  const attach = async (files: File[]) => {
    for (const f of files) {
      const tag = `[saving ${f.name || 'file'}…]`
      const ta = area.current, at = ta ? ta.selectionStart : text.length
      setText((t) => { const pre = t.slice(0, at), sp = pre && !/\s$/.test(pre) ? ' ' : ''; return `${pre}${sp}${tag} ${t.slice(at)}` })
      let path = ''
      try { const r = await fetch(`${WB}/api/drop?name=${encodeURIComponent(f.name || 'pasted.png')}`, { method: 'POST', body: f.slice(0, f.size, '') }); path = (await r.json()).path || '' } catch { /* shown below */ }
      setText((t) => t.replace(tag, path ? (/\s/.test(path) ? `"${path}"` : path) : `[couldn't save ${f.name}]`))
    }
    area.current?.focus()
  }
  const anyWorking = live.some((s) => s.state === 'working')
  const yours = (agent.messages || []).filter((m) => m.role === 'you').slice(-8).map((m) => norm(m.text))
  const waiting = sent.filter((q) => q.k === key && Date.now() - q.at < 120000 && !yours.some((y) => y === q.n || y.includes(q.n.slice(0, 60))))
  const shown: { role: string; text: string; pending?: boolean }[] = [...(agent.messages || []), ...waiting.map((q) => ({ role: 'you', text: q.text, pending: true }))]
  if (!open) return (
    <button className="ag-toggle" onClick={() => toggle(true)} title="Show the Claude sessions working on this">
      <Status s={anyWorking ? 'working' : live.some((s) => s.state !== 'ended') ? 'waiting' : 'ended'} />Claude{live.length > 1 ? ` · ${live.length}` : ''}
    </button>
  )
  return (
    <aside className={`ag-panel${dropping ? ' dropping' : ''}`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
      onDragOver={(e) => { if (agent.canSend && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDropping(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false) }}
      onDrop={(e) => { setDropping(false); if (!agent.canSend || !e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); attach([...e.dataTransfer.files]) }}>
      <div className="ag-head" ref={menuRef}>
        {renaming !== null ? (
          <input className="ag-rename" autoFocus value={renaming} placeholder="Name this session" onChange={(e) => setRenaming(e.target.value)}
            onFocus={(e) => e.target.select()} onBlur={() => rename(renaming)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') rename(renaming); if (e.key === 'Escape') setRenaming(null) }} />
        ) : (
        <button className={`ag-pick${menu ? ' on' : ''}`} onClick={() => live.length > 1 && setMenu((m) => !m)} onDoubleClick={() => { setMenu(false); setRenaming(agent.title || '') }}
          title={`${live.length > 1 ? `${live.length} sessions on this board. ` : ''}Double-click to rename`}>
          <Status s={state} />
          <span className="ag-name">{name({ title: agent.title || cur.title, card: cur.card })}{state !== 'working' && <i> · {stText(state)}</i>}</span>
          {live.length > 1 && <svg className="ag-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
        )}
        {state !== 'ended' && state !== 'starting' && <button className="ag-btn" onClick={openTerm} title="Jump to this terminal in Orca">Open ↗</button>}
        <button className="ag-btn" onClick={() => toggle(false)} title="Hide">✕</button>
        {menu && (
          <div className="ag-menu">
            {live.map((s) => (
              <button key={`${s.cid}:${s.pid}`} className={`ag-mi${s.state === 'ended' ? ' off' : ''}`} onClick={() => choose(s)}>
                <Status s={s.state} />
                <span className="ag-mt"><b>{name(s)}</b><span>{s.state === 'ended' && s.resumable ? 'Offline · click to turn on' : stText(s.state)} · {ago(s.linked)}{live.some((o) => o.cid !== s.cid) ? ` · ${s.card}` : ''}</span></span>
                <span className="ag-ck">{s === cur || (s.cid === cur.cid && s.pid === cur.pid) ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ag-msgs" ref={list}>
        {shown.length ? shown.map((m, i) => <div key={i} className={`ag-m ${m.role}${m.pending ? ' pending' : ''}`} dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />)
          : <div className="ag-m empty">No messages yet</div>}
      </div>
      {(state === 'ended' || state === 'starting') && (
        <div className="ag-off">
          <span>{state === 'starting' ? 'Turning it on in Orca…' : agent.resumable ? 'This session is offline.' : "This session is offline and can't be resumed."}</span>
          {state === 'ended' && agent.resumable && <button className="ag-on" onClick={() => resume(cur)}>Turn on</button>}
        </div>
      )}
      {agent.canSend && (
        <form className="ag-send" onSubmit={send} onPointerDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); area.current?.focus() } }}>
          <textarea ref={area} rows={1} value={text} placeholder="Write a message…  (/commands work too)"
            onChange={(e) => { setText(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; suggest(t.value, t.selectionStart) }}
            onBlur={() => setTimeout(() => setHits([]), 150)}
            onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); e.stopPropagation(); attach(fs) } }}
            onKeyDown={(e) => {
              if (hits.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => (a + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); pickCmd(hits[at].name); return }
                if (e.key === 'Escape') { e.preventDefault(); setHits([]); return }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
            }} />
          {hits.length > 0 && (
            <div className="ag-cmds">
              {hits.map((c, i) => (
                <button key={c.name} type="button" className={`ag-cmd${i === at ? ' on' : ''}`} ref={i === at ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseDown={(e) => { e.preventDefault(); pickCmd(c.name) }}>
                  <b>/{c.name}</b><span>{c.description}</span><i>{c.source}</i>
                </button>
              ))}
            </div>
          )}
          <div className="ag-tools">
            <button type="button" className="ag-clip" title="Attach files (their path goes in the message)" onClick={() => file.current?.click()}>
              <svg viewBox="0 0 16 16" width="16" height="16"><path d="M10.5 4.5l-5 5a1.4 1.4 0 0 0 2 2l5.2-5.2a2.8 2.8 0 0 0-4-4L3.5 7.5a4.2 4.2 0 0 0 6 6l4-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {fresh.length > 0 && (
              <div className="ag-cmw" ref={cmRef}>
                <button type="button" className={`ag-cm${cmMenu ? ' on' : ''}`} onClick={() => (live.length > 1 ? setCmMenu((m) => !m) : sendComments(cur))} disabled={busy}
                  title={`${fresh.length} new comment${fresh.length > 1 ? 's' : ''}:\n${fresh.map((c) => `• ${one(c.text).slice(0, 80)}`).join('\n')}`}>
                  <svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                  Send comments to agent<b>{fresh.length}</b>
                </button>
                {cmMenu && (
                  <div className="ag-menu ag-cmenu">
                    <div className="ag-mh">Send {fresh.length} comment{fresh.length > 1 ? 's' : ''} to…</div>
                    {live.map((s) => (
                      <button key={`${s.cid}:${s.pid}`} type="button" className={`ag-mi${s.state === 'ended' || s.state === 'starting' ? ' off' : ''}`} disabled={s.state === 'ended' || s.state === 'starting'} onClick={() => sendComments(s)}>
                        <Status s={s.state} />
                        <span className="ag-mt"><b>{name(s)}</b><span>{s.state === 'ended' ? 'Offline · turn it on first' : stText(s.state)}{live.some((o) => o.cid !== s.cid) ? ` · ${s.card}` : ''}</span></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button type="submit" className={`ag-go${!text.trim() && state === 'working' ? ' stop' : ''}`} title={!text.trim() && state === 'working' ? 'Stop (Esc)' : 'Send'} disabled={busy || (!text.trim() && state !== 'working')}>
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3.5M3.8 7.5L8 3.3l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
          <input ref={file} type="file" multiple hidden onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) attach(fs) }} />
        </form>
      )}
    </aside>
  )
}
