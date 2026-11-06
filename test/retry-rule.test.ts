import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { performLoginDetailed } from '../src/engine/browser/auth.js'
import { crawlLiveRoutes } from '../src/engine/browser/live-routes.js'
import { runScenarioWithRetry } from '../src/engine/browser/runner.js'
import { collectRetryFindings } from '../src/engine/index.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestResult, TestScenario } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/**
 * A login form that rejects the first submission of the page and accepts the
 * second (react-simple-project bug B1). The "tried once" flag lives in page
 * state, so a retry on a fresh page would fail again.
 */
const FIRST_SUBMIT_FAILS = page(`
  <form id="f">
    <input name="username" placeholder="Username">
    <input type="password" name="password">
    <button type="submit">Log In</button>
  </form>
  <p id="err" role="alert"></p>
  <script>
    let triedOnce = false
    document.getElementById('f').addEventListener('submit', e => {
      e.preventDefault()
      const ok = triedOnce && document.querySelector('[name=username]').value === 'admin' &&
        document.querySelector('[name=password]').value === '1234'
      triedOnce = true
      if (ok) location.href = '/dashboard'
      else document.getElementById('err').textContent = 'Invalid credentials'
    })
  </script>`)

/** Shows "Ready" only from the second load on (a timing-dependent page). */
const READY_ON_SECOND_LOAD = page(`
  <h1 id="status"></h1>
  <script>
    const loads = Number(localStorage.getItem('loads') || '0') + 1
    localStorage.setItem('loads', String(loads))
    document.getElementById('status').textContent = loads >= 2 ? 'Ready' : 'Loading'
  </script>`)

describe('retry rule: retry once, never hide it', () => {
  let fx: BrowserFixture
  let shots: string

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/': page('<h1>Home</h1><a href="/login">Login</a>'),
      '/login': FIRST_SUBMIT_FAILS,
      '/dashboard': page('<h1>Dashboard</h1><a href="/orders">Orders</a>'),
      '/orders': page('<h1>Orders</h1>'),
      '/flaky': READY_ON_SECOND_LOAD,
      '/never': page('<h1>Loading</h1>'),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-retry-'))
  })

  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  const auth = (password = '1234') => ({
    strategy: 'credentials' as const,
    login_url: '/login',
    credentials: { email: 'admin', password },
  })

  it('resubmits a rejected login on the same page and reports the first failure', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const outcome = await performLoginDetailed(ctx, fx.baseUrl, auth(), 1)
      expect(outcome).toEqual({
        ok: true, attempts: 2, firstFailure: 'Invalid credentials', landingUrl: `${fx.baseUrl}/dashboard`,
      })
    } finally {
      await ctx.close()
    }
  }, 60_000)

  it('does not retry when retries is 0, and fails consistently-wrong credentials', async () => {
    const ctx = await fx.browser.newContext()
    try {
      expect(await performLoginDetailed(ctx, fx.baseUrl, auth(), 0)).toMatchObject({ ok: false, attempts: 1 })
      expect(await performLoginDetailed(ctx, fx.baseUrl, auth('wrong'), 1))
        .toMatchObject({ ok: false, attempts: 2, firstFailure: 'Invalid credentials' })
    } finally {
      await ctx.close()
    }
  }, 60_000)

  it('records a retried crawl login and still crawls behind it', async () => {
    const crawl = await crawlLiveRoutes({ baseUrl: fx.baseUrl, auth: auth() })
    expect(crawl.auth).toMatchObject({ status: 'logged-in', login_attempts: 2, first_failure: 'Invalid credentials' })
    expect(crawl.routes.find(route => route.path === '/orders')).toMatchObject({ requires_auth: true })
  }, 60_000)

  const scenario = (route: string): TestScenario => ({
    id: `retry${route.replace('/', '-')}`, name: `Status on ${route}`, route, priority: 'high',
    steps: [
      { action: 'navigate', url: route, description: 'Open' },
      { action: 'assert', value: 'Ready', timeout: 300, description: 'Page is ready' },
    ],
    expected_outcome: 'Ready', is_gap: true, generated_by: 'heuristic',
  })

  async function run(route: string, retries: number) {
    const ctx = await fx.browser.newContext()
    try {
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, retries, browser: { headed: false, slowMo: 0 } })
      return await runScenarioWithRetry(scenario(route), ctx, config, shots, shots)
    } finally {
      await ctx.close()
    }
  }

  it('keeps a pass on retry as a pass but records it, with the first failure', async () => {
    const result = await run('/flaky', 1)
    expect(result.status).toBe('pass')
    expect(result.retry).toMatchObject({ attempts: 2, passed_on_retry: true })
    expect(result.retry?.first_failure).toMatch(/Expected body to contain "Ready"; received "Loading"/)
    expect(collectRetryFindings([result])).toEqual([
      expect.stringMatching(/^Status on \/flaky \(\/flaky\): only passed on attempt 2 \(first attempt: .*Loading/),
    ])
  }, 60_000)

  it('returns the first failure as evidence when every attempt fails', async () => {
    const result = await run('/never', 1)
    expect(result.status).toBe('fail')
    expect(result.retry).toMatchObject({ attempts: 2, passed_on_retry: false })
    expect(result.failure_reason).toMatch(/received "Loading"/)
    expect(collectRetryFindings([result])).toEqual([])
  }, 60_000)

  it('does not retry when retries is 0', async () => {
    const result = await run('/never', 0)
    expect(result.retry).toBeUndefined()
  }, 60_000)

  const loginScenario = (password: string): TestScenario => ({
    id: 'login-saved', name: 'Login with saved credentials', route: '/login', priority: 'high',
    steps: [
      { action: 'navigate', url: '/login', description: 'Open login' },
      { action: 'fill', selector: 'input[name="username"]', value: 'admin', description: 'Fill username' },
      { action: 'fill', selector: 'input[type="password"]', value: password, description: 'Fill password' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit login form' },
      { action: 'assert', description: 'Login succeeded' },
    ],
    expected_outcome: 'Logged in', is_gap: true, generated_by: 'heuristic',
  })

  async function runLogin(password: string, retries: number) {
    const ctx = await fx.browser.newContext()
    try {
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, retries, browser: { headed: false, slowMo: 0 } })
      return await runScenarioWithRetry(loginScenario(password), ctx, config, shots, shots)
    } finally {
      await ctx.close()
    }
  }

  it('resubmits a rejected login submit on the same page and passes with retry info', async () => {
    const result = await runLogin('1234', 1)
    expect(result.status).toBe('pass')
    expect(result.retry).toMatchObject({ attempts: 2, passed_on_retry: true, first_failure: 'Invalid credentials' })
    expect(collectRetryFindings([result])).toEqual([
      expect.stringMatching(/^Login with saved credentials \(\/login\): only passed on attempt 2 \(first attempt: Invalid credentials\)/),
    ])
  }, 60_000)

  it('still fails a login that is never accepted', async () => {
    const wrong = await runLogin('wrong', 1)
    expect(wrong.status).not.toBe('pass')
    expect(wrong.retry?.passed_on_retry).toBe(false)
  }, 90_000)

  it('merges operation findings with scenario findings without duplicates', () => {
    const passed = { scenario: scenario('/x'), status: 'pass', duration_ms: 1, step_logs: [],
      retry: { attempts: 2, passed_on_retry: true, first_failure: 'boom' } } as TestResult
    const login = 'Configured login: login with valid credentials only succeeded on attempt 2 (first attempt: Invalid credentials)'
    expect(collectRetryFindings([passed], [login, login])).toEqual([
      login,
      'Status on /x (/x): only passed on attempt 2 (first attempt: boom)',
    ])
  })
})
