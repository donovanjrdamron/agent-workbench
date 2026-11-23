// Higgsfield through your subscription: Studio signs in to Higgsfield's official MCP server (mcp.higgsfield.ai) with
// OAuth, the same way Claude's Higgsfield connector does, and calls its tools. Generations use your plan's credits.
// The sign-in (client id, tokens) is kept in <state dir>/settings.json under "higgsfieldMcp", never in code.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP = 'https://mcp.higgsfield.ai/mcp'
const AUTH = 'https://mcp.higgsfield.ai/oauth2/authorize'
const TOKEN = 'https://mcp.higgsfield.ai/oauth2/token'
const REGISTER = 'https://mcp.higgsfield.ai/oauth2/register'
const SCOPE = 'openid email offline_access'

export class HfError extends Error {}

interface Saved { clientId?: string; redirect?: string; access?: string; refresh?: string; expires?: number; email?: string }
const settingsPath = (dir: string) => path.join(dir, 'settings.json')
function readAll(dir: string): Record<string, any> { const p = settingsPath(dir); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {} }
function saved(dir: string): Saved { return readAll(dir).higgsfieldMcp || {} }
function save(dir: string, patch: Saved) {
  const all = readAll(dir)
  all.higgsfieldMcp = { ...(all.higgsfieldMcp || {}), ...patch }
  fs.writeFileSync(settingsPath(dir), JSON.stringify(all, null, 2), { mode: 0o600 })
  fs.chmodSync(settingsPath(dir), 0o600)
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pending = new Map<string, { verifier: string; redirect: string; at: number }>()

/** Where to send the browser to sign in. Registers Studio with Higgsfield the first time. */
export async function signInUrl(dir: string, redirect: string) {
  let s = saved(dir)
  if (!s.clientId || s.redirect !== redirect) {
    const r = await fetch(REGISTER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Studio (local)', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE }), signal: AbortSignal.timeout(30_000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.client_id) throw new HfError(`Higgsfield would not register Studio: ${j.error_description || j.error || r.status}`)
    save(dir, { clientId: j.client_id, redirect })
    s = saved(dir)
  }
  const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(16))
  pending.set(state, { verifier, redirect, at: Date.now() })
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k)
  const q = new URLSearchParams({ response_type: 'code', client_id: s.clientId!, redirect_uri: redirect, scope: SCOPE, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: MCP })
  return `${AUTH}?${q}`
}

async function tokenCall(body: Record<string, string>) {
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new HfError(`Higgsfield sign-in failed: ${j.error_description || j.error || r.status}`)
  return j as { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
}
function remember(dir: string, t: Awaited<ReturnType<typeof tokenCall>>) {
  let email: string | undefined
  try { if (t.id_token) email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email } catch { /* no name to show */ }
  save(dir, { access: t.access_token, ...(t.refresh_token ? { refresh: t.refresh_token } : {}), expires: Date.now() + (t.expires_in || 3600) * 1000, ...(email ? { email } : {}) })
}

/** The browser came back from Higgsfield's sign-in page. */
export async function finishSignIn(dir: string, code: string, state: string) {
  const p = pending.get(state)
  if (!p) throw new HfError('This sign-in link is old. Start again from Studio.')
  pending.delete(state)
  remember(dir, await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, client_id: saved(dir).clientId!, code_verifier: p.verifier, resource: MCP }))
}

async function accessToken(dir: string, force = false) {
  const s = saved(dir)
  if (!s.access) throw new HfError('Studio is not signed in to Higgsfield yet.')
  if (!force && s.expires && s.expires - Date.now() > 60_000) return s.access
  if (!s.refresh) throw new HfError('The Higgsfield sign-in ran out. Sign in again from Studio.')
  remember(dir, await tokenCall({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: s.clientId!, resource: MCP }))
  return saved(dir).access!
}

export const status = (dir: string) => { const s = saved(dir); return { connected: !!s.access, email: s.email || null } }
export function signOut(dir: string) { const all = readAll(dir); delete all.higgsfieldMcp; fs.writeFileSync(settingsPath(dir), JSON.stringify(all, null, 2), { mode: 0o600 }) }

/** One connection to the MCP server, opened when needed and reused. */
let client: Promise<Client> | null = null
async function connect(dir: string, force = false) {
  const token = await accessToken(dir, force)
  const c = new Client({ name: 'studio', version: '1.0.0' })
  const t = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await c.connect(t)
  return c
}
async function withClient<T>(dir: string, fn: (c: Client) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!client) client = connect(dir, attempt > 0).catch((e) => { client = null; throw e })
    try { return await fn(await client) } catch (e) {
      const msg = String((e as Error).message || e)
      client?.then((c) => c.close()).catch(() => {})
      client = null
      if (attempt === 0 && /401|unauthor|invalid_token|expired/i.test(msg)) continue // a stale token: refresh once
      throw e
    }
  }
}

export const listTools = (dir: string) => withClient(dir, async (c) => (await c.listTools()).tools)
export const callTool = (dir: string, name: string, args: Record<string, unknown>) =>
  withClient(dir, (c) => c.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000, resetTimeoutOnProgress: true }))
