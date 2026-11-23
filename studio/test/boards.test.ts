import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A real server on its own port and state folder, with boards that go idle after a second.
const PORT = 4631
const BASE = `http://127.0.0.1:${PORT}`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'))
const folder = path.join(dir, 'designs')
let proc: ChildProcess

const call = async (url: string, body?: unknown) => (await fetch(BASE + url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })).json()
const boardRow = async (name: string) => ((await call('/api/boards')).boards as { name: string; closed?: boolean; loaded: boolean }[]).find((b) => b.name === name)!
const until = async (ok: () => Promise<boolean>, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; ) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 200)) } return false }
const stateOf = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, 'boards', name, 'state.json'), 'utf8'))

beforeAll(async () => {
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, 'a.html'), '<!doctype html><div class="ad"><p>Hello</p></div>\n')
  proc = spawn(path.resolve('node_modules/.bin/tsx'), ['server/index.ts'], { env: { ...process.env, STUDIO_PORT: String(PORT), STUDIO_DIR: dir, STUDIO_IDLE_MS: '1000' }, stdio: 'ignore' })
  expect(await until(async () => { try { return (await fetch(`${BASE}/api/health`)).ok } catch { return false } }, 30000)).toBe(true)
  await call('/api/boards', { name: 'T', root: folder })
}, 40000)
afterAll(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('closed and idle boards', () => {
  it('drops an idle board from memory, keeps what was pending, and loads it again on the next call', async () => {
    const box = { id: 'b1', kind: 'box', x: 0, y: 0, w: 400, h: 180, text: 'Keep me' }
    await call('/api/items', { board: 'T', put: [box], by: 'agent' })
    expect(await until(async () => !(await boardRow('T')).loaded)).toBe(true)
    expect(stateOf('T').items[0].text).toBe('Keep me')
    expect((await call('/api/board?board=T')).items[0].text).toBe('Keep me')
    expect((await boardRow('T')).loaded).toBe(true)
  }, 20000)

  it('closes a board at once with its pending save written, still answers for it by name, and reopens it', async () => {
    await call('/api/items', { board: 'T', put: [{ id: 'b2', kind: 'box', x: 0, y: 300, w: 400, h: 180, text: 'Second' }], by: 'agent' })
    expect((await call('/api/boards', { close: 'T' })).ok).toBe(true)
    // straight after the answer: within the 300ms a state save normally waits
    expect(stateOf('T').items.map((i: { id: string }) => i.id)).toEqual(['b1', 'b2'])
    expect(await until(async () => { const b = await boardRow('T'); return !!b.closed && !b.loaded })).toBe(true)
    expect((await call('/api/board?board=T')).designs.map((d: { id: string }) => d.id)).toEqual(['a.html'])
    expect(await until(async () => !(await boardRow('T')).loaded)).toBe(true) // loaded for that call only
    expect(fs.existsSync(path.join(folder, 'a.html'))).toBe(true)
    await call('/api/boards', { open: 'T' })
    expect((await boardRow('T')).closed).toBeUndefined()
    expect((await call('/api/boards', { close: 'nope' })).ok).toBe(false)
  }, 20000)
})
