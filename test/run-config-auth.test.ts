import { createServer, type Server } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadRunConfig } from '../src/utils/run-config.js'
import { crawlLiveRoutes } from '../src/engine/browser/live-routes.js'
import { executeScenarios } from '../src/engine/browser/runner.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario } from '../src/types/index.js'

// ── vibe.config.json is honoured (V6: MCP run_full_test ignored it) ─────────

describe('loadRunConfig', () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-config-'))
    await fs.writeFile(path.join(dir, 'vibe.config.json'), JSON.stringify({
      url: 'http://localhost:4000',
      mode: 'fast',
      auth: { strategy: 'credentials', login_url: '/login', credentials: { email: 'user1', password: 'pw' } },
      never_interact: ['delete account'],
      browser: { headed: true, slowMo: 5 },
    }))
  })

  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('carries auth, never_interact and browser timing from the file', async () => {
    const config = await loadRunConfig({ projectRoot: dir })
    expect(config.auth).toMatchObject({ strategy: 'credentials', credentials: { email: 'user1' } })
    expect(config.never_interact).toEqual(['delete account'])
    expect(config.browser).toMatchObject({ headed: true, slowMo: 5 })
    expect(config).toMatchObject({ url: 'http://localhost:4000', mode: 'fast', codebase_path: dir })
  })

  it('lets per-run values win over the file', async () => {
    const config = await loadRunConfig({
      projectRoot: dir, url: 'http://localhost:5000', mode: 'deep', codebasePath: '/elsewhere', headed: false,
    })
    expect(config).toMatchObject({ url: 'http://localhost:5000', mode: 'deep', codebase_path: '/elsewhere' })
    expect(config.browser).toMatchObject({ headed: false, slowMo: 5 })
  })

  it('keeps MCP runs headless even when the file says headed', async () => {
    const config = await loadRunConfig({ projectRoot: dir, defaultHeaded: false, ignoreFileHeaded: true })
    expect(config.browser?.headed).toBe(false)
  })

  it('works without a config file', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-config-empty-'))
    try {
      const config = await loadRunConfig({ projectRoot: empty, url: 'http://x.test', defaultHeaded: false })
      expect(config).toMatchObject({ url: 'http://x.test', mode: 'deep', browser: { headed: false } })
      expect(config.auth).toBeUndefined()
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })
})

// ── Logged-in crawl and runner auth, against a cookie-session app ──────────

let server: Server
let baseUrl: string
const hits: string[] = []

const html = (body: string) => `<!doctype html><html><head><title>App</title></head><body>${body}</body></html>`

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push(`${req.method} ${url.pathname}`)
    const loggedIn = /(?:^|;\s*)sid=ok\b/.test(req.headers.cookie ?? '')
    const send = (body: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html(body)) }
    const redirect = (to: string, cookie?: string) => {
      res.writeHead(302, { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) })
      res.end()
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('userName') === 'user1' && form.get('password') === 'User1_123') {
          redirect('/dashboard', 'sid=ok; Path=/; HttpOnly')
        } else {
          send('<p>Invalid username</p><form method="post"><input name="userName"><input type="password" name="password"><button>Submit</button></form>')
        }
      })
      return
    }
    if (url.pathname === '/login') {
      return send('<form method="post"><input name="userName" placeholder="User Name"><input type="password" name="password"><button type="submit">Submit</button></form><a href="/signup">Sign up</a>')
    }
    if (url.pathname === '/signup') return send('<h1>Sign up</h1><a href="/login">Login</a>')
    if (url.pathname === '/') return loggedIn ? redirect('/dashboard') : redirect('/login')
    if (!loggedIn) return redirect('/login')
    if (url.pathname === '/dashboard') {
      return send('<h1>Secret dashboard</h1><a href="/contributions">Contributions</a><a href="/profile">Profile</a><a href="/logout">Logout</a>')
    }
    if (url.pathname === '/contributions') return send('<h1>Contributions</h1><a href="/dashboard">Dashboard</a>')
    if (url.pathname === '/profile') return send('<h1>Profile</h1>')
    if (url.pathname === '/logout') return redirect('/login', 'sid=; Path=/; Max-Age=0')
    res.writeHead(404); res.end()
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    resolve(address.port)
  }))
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const credentials = (password = 'User1_123') => ({
  strategy: 'credentials' as const,
  login_url: '/login',
  credentials: { email: 'user1', password },
})

describe('crawlLiveRoutes with configured credentials', () => {
  it('also crawls logged in and marks pages behind the sign-in as requires_auth', async () => {
    hits.length = 0
    const crawl = await crawlLiveRoutes({ baseUrl, auth: credentials() })

    const byPath = Object.fromEntries(crawl.routes.map(route => [route.path, route.requires_auth]))
    expect(byPath).toMatchObject({ '/login': false, '/signup': false, '/dashboard': true, '/contributions': true, '/profile': true })
    expect(crawl.auth).toEqual({ status: 'logged-in', pages: 3, login_attempts: 1 })
    expect(crawl.scenarios.find(s => s.route === '/dashboard')).toMatchObject({ requires_auth: true })
    expect(hits).not.toContain('GET /logout')
  }, 60_000)

  it('reports a failed login and keeps only the public pages', async () => {
    const crawl = await crawlLiveRoutes({ baseUrl, auth: credentials('wrong') })
    expect(crawl.auth).toEqual({ status: 'login-failed', pages: 0, login_attempts: 2, first_failure: 'Invalid username' })
    expect(crawl.routes.every(route => !route.requires_auth)).toBe(true)
  }, 60_000)

  it('does not attempt a logged-in pass without credentials', async () => {
    const crawl = await crawlLiveRoutes({ baseUrl })
    expect(crawl.auth).toBeUndefined()
    expect(crawl.routes.map(route => route.path)).not.toContain('/dashboard')
  }, 60_000)
})

describe('executeScenarios authenticates with configured credentials', () => {
  const dashboard: TestScenario = {
    id: 'auth-dashboard', name: 'Dashboard (logged in)', route: '/dashboard', priority: 'high',
    steps: [
      { action: 'navigate', url: '/dashboard', description: 'Open dashboard' },
      { action: 'assert', value: 'Secret dashboard', description: 'Dashboard content visible' },
    ],
    expected_outcome: 'Dashboard loads', is_gap: true, generated_by: 'heuristic', requires_auth: true,
  }

  async function run(auth?: ReturnType<typeof credentials>) {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-runner-auth-'))
    try {
      const config = VibeConfigSchema.parse({ url: baseUrl, auth, browser: { headed: false, slowMo: 0 } })
      return await executeScenarios([dashboard], config, projectRoot)
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true })
    }
  }

  it('runs requires_auth scenarios without a generated login scenario', async () => {
    const { results } = await run(credentials())
    expect(results[0]).toMatchObject({ status: 'pass' })
  }, 90_000)

  it('still skips them when no way to log in exists', async () => {
    const { results } = await run()
    expect(results[0]).toMatchObject({ status: 'fail', failure_reason: 'Skipped — authenticated session could not be established' })
  }, 90_000)
})
