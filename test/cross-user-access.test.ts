import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkCrossUserAccess, resolveAccounts, urlIdentifiers, urlPattern } from '../src/engine/browser/access-checks.js'
import { VibeConfigSchema } from '../src/types/config.js'

describe('cross-user access: accounts and URL identifiers', () => {
  it('pairs the main credentials with the first different account', () => {
    const auth = VibeConfigSchema.parse({
      url: 'http://x.test',
      auth: {
        strategy: 'credentials',
        credentials: { email: 'alice', password: 'a' },
        accounts: [{ credentials: { email: 'ALICE', password: 'a' } }, { name: 'Bob', credentials: { email: 'bob@x.test', password: 'b' } }],
      },
    }).auth
    const pair = resolveAccounts(auth)
    expect(pair?.map(account => account.name)).toEqual(['alice', 'Bob'])
    expect(pair?.[1].auth.credentials).toEqual({ email: 'bob@x.test', password: 'b' })
  })

  it('accepts two accounts without main credentials, and needs two distinct ones', () => {
    const two = { strategy: 'credentials' as const, accounts: [{ credentials: { email: 'a', password: '1' } }, { credentials: { email: 'b', password: '2' } }] }
    expect(resolveAccounts(two)?.map(account => account.name)).toEqual(['a', 'b'])
    expect(resolveAccounts({ strategy: 'credentials', credentials: { email: 'a', password: '1' } })).toBeUndefined()
    expect(resolveAccounts({ strategy: 'skip', accounts: two.accounts })).toBeUndefined()
  })

  it('finds ids in paths and id-named query parameters, not in ordinary words', () => {
    expect(urlIdentifiers('http://x.test/allocations/2')).toEqual(['2'])
    expect(urlIdentifiers('http://x.test/orders/3f2b9c1e-1a2b-4c3d-8e9f-001122334455')).toEqual(['3f2b9c1e-1a2b-4c3d-8e9f-001122334455'])
    expect(urlIdentifiers('http://x.test/u/5f8d0d55b54764421b7156c9')).toEqual(['5f8d0d55b54764421b7156c9'])
    expect(urlIdentifiers('http://x.test/invoice?accountId=77&page=2')).toEqual(['77'])
    expect(urlIdentifiers('http://x.test/learn?url=https://example.com')).toEqual([])
    expect(urlIdentifiers('http://x.test/settings/profile')).toEqual([])
    expect(urlPattern('http://x.test/allocations/2')).toBe(urlPattern('http://x.test/allocations/3'))
    expect(urlPattern('http://x.test/a?userId=1&tab=x')).toBe('/a?tab=x&userId=:id')
  })
})

// ─── Two-user fixture app ─────────────────────────────────────────────────────

const USERS: Record<string, { password: string; id: number; name: string; balance: string; post: number }> = {
  alice: { password: 'pw-a', id: 1, name: 'Alice Smith', balance: 'Balance: 1200', post: 11 },
  bob: { password: 'pw-b', id: 2, name: 'Bob Jones', balance: 'Balance: 75', post: 12 },
}

function html(body: string): string {
  return `<!doctype html><html><head><title>Bank</title></head><body>${body}</body></html>`
}

/**
 * /<variant>/account/:id shows any user's account in "bad" and only your own
 * in "good". Both share /shared/7 (linked for everyone) and per-user public
 * posts (readable logged out), which must never be flagged.
 */
function startApp(): Promise<{ baseUrl: string; hits: string[]; server: Server }> {
  const hits: string[] = []
  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    hits.push(url.pathname)
    const [, variant, page, id] = url.pathname.split('/')
    const user = Object.entries(USERS).find(([login]) => (req.headers.cookie ?? '').includes(`sid=${login}`))
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers })
      res.end(body)
    }
    const nav = (login: string) => `<nav><a href="/${variant}/home">Home</a> <a href="/${variant}/account/${USERS[login].id}">My account</a>
      <a href="/${variant}/shared/7">Handbook</a> <a href="/${variant}/posts/${USERS[login].post}">My post</a> <a href="/${variant}/logout">Log out</a></nav>`

    if (page === 'login') {
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const form = new URLSearchParams(body)
        const login = form.get('username') ?? ''
        if (USERS[login]?.password === form.get('password')) {
          return send(302, '', { location: `/${variant}/home`, 'set-cookie': `sid=${login}; Path=/` })
        }
        return send(200, html('<p>Invalid credentials</p>'))
      }
      return send(200, html(`<form method="post" action="/${variant}/login"><label>Username <input name="username"></label>
        <label>Password <input type="password" name="password"></label><button type="submit">Log in</button></form>`))
    }
    if (page === 'posts') {
      const author = Object.values(USERS).find(u => u.post === Number(id))
      return author ? send(200, html(`<h1>Post ${id}</h1><p>Thoughts on gardening by ${author.name}</p>`)) : send(404, html('Not found'))
    }
    if (!user) return send(302, '', { location: `/${variant}/login` })
    const [login, me] = user
    if (page === 'logout') return send(302, '', { location: `/${variant}/login`, 'set-cookie': 'sid=; Path=/; Max-Age=0' })
    if (page === 'home') return send(200, html(`${nav(login)}<h1>Welcome, ${me.name}</h1>`))
    if (page === 'shared') return send(200, html(`${nav(login)}<h1>Team handbook</h1><p>Office hours: 9 to 5</p>`))
    if (page === 'account') {
      const owner = Object.values(USERS).find(u => u.id === Number(id))
      if (!owner) return send(404, html('Not found'))
      if (variant === 'good' && owner.id !== me.id) return send(403, html(`${nav(login)}<h1>Access denied</h1>`))
      return send(200, html(`${nav(login)}<h1>Account of ${owner.name}</h1><p>${owner.balance}</p><p>Plan: ${owner.id === 1 ? 'Gold' : 'Basic'}</p>`))
    }
    return send(404, html('Not found'))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
    resolve({ baseUrl: `http://127.0.0.1:${address.port}`, hits, server })
  }))
}

describe('cross-user access against a two-user app', () => {
  let app: Awaited<ReturnType<typeof startApp>>
  let browser: Browser
  let shots: string

  beforeAll(async () => {
    app = await startApp()
    browser = await chromium.launch()
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cross-user-'))
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>(resolve => app?.server.close(() => resolve()))
    await fs.rm(shots, { recursive: true, force: true })
  })

  function check(variant: 'bad' | 'good', accounts = [{ credentials: { email: 'bob', password: 'pw-b' } }]) {
    const config = VibeConfigSchema.parse({
      url: app.baseUrl,
      auth: { strategy: 'credentials', login_url: `/${variant}/login`, credentials: { email: 'alice', password: 'pw-a' }, accounts },
      browser: { headed: false, slowMo: 0 },
    })
    return checkCrossUserAccess(browser, config, [`/${variant}/home`], shots)
  }

  it('fails when the other user can open the owner\'s account page', async () => {
    const result = await check('bad')
    expect(result).toMatchObject({ status: 'fail', scenario: { id: 'cross-user-access' }, verification_status: 'outcome_verified' })
    expect(result?.ai_verdict).toMatch(/^bob opened alice's page and saw their data: \/bad\/account\/1 showed identity "alice"/)
    expect(result?.ai_verdict).toContain('"Balance: 1200"')
    // Shared and public pages are not reported.
    expect(result?.ai_verdict).not.toMatch(/shared|posts/)
    expect(result?.screenshot_path).toBeTruthy()
  }, 90_000)

  it('passes when the app denies other users, without flagging shared or public pages', async () => {
    const result = await check('good')
    expect(result).toMatchObject({ status: 'pass', verification_status: 'outcome_verified' })
    expect(result?.ai_verdict).toContain('bob could not open alice\'s pages: /good/account/1 (403)')
    expect(result?.ai_verdict).toContain('/good/posts/11 (public)')
  }, 90_000)

  it('never follows sign-out links while collecting pages', async () => {
    app.hits.length = 0
    await check('good')
    expect(app.hits.filter(hit => hit.endsWith('/logout'))).toEqual([])
  }, 90_000)

  it('does nothing with a single account', async () => {
    expect(await check('bad', [])).toBeUndefined()
  }, 30_000)
})
