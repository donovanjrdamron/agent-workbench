// The work board (another local server): which cards and Claude sessions work on a Studio board, kept boards, drops.
let base = 'http://127.0.0.1:4477'
// opened from the phone (over Tailscale): the work board answers on the same machine address, its own port
const remote = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)
const ready = fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c.workboard) base = c.workboard
  if (remote) base = `${location.protocol}//${location.hostname}:${new URL(base).port || '4477'}`
}).catch(() => {})
export async function wb(path: string, init?: RequestInit) { await ready; return fetch(`${base}${path}`, init) }
export const wbBase = async () => { await ready; return base }

export interface LinkedCard { id: string; title: string; brand: string; status: string; state: 'working' | 'waiting' | 'ended' | null }
export const cardsOn = (board: string): Promise<{ cards: LinkedCard[]; kept: boolean }> =>
  wb(`/api/studio-cards?board=${encodeURIComponent(board)}`).then((r) => r.json()).catch(() => ({ cards: [], kept: false }))
export const keptBoards = (): Promise<string[]> => wb('/api/kept').then((r) => r.json()).then((j) => j.boards || []).catch(() => [])
export const setKept = (board: string, keep: boolean): Promise<string[]> =>
  wb('/api/kept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board, keep }) }).then((r) => r.json()).then((j) => j.boards || [])
