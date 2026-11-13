import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertPage } from '../src/engine/browser/assertions.js'
import { performLoginDetailed } from '../src/engine/browser/auth.js'
import { explorePage } from '../src/engine/browser/explorer.js'
import { isGuessedTargetMissing, runOneScenario, runScenarioWithRetry } from '../src/engine/browser/runner.js'
import { describeErrorScreen } from '../src/engine/browser/verifier.js'
import { expandRoutePath, extractRouteTagsFromContent } from '../src/engine/context/router.js'
import { collectFailedScenarios } from '../src/engine/findings.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestResult, TestScenario } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/**
 * Found by running vibe-testing on cypress-realworld-app: the sign-in form
 * unmounts as soon as the login succeeds, and the URL leaves /signin a moment
 * later. Judging in that gap reported a good login as failed.
 */
const FORM_GONE_BEFORE_REDIRECT = page(`
  <div id="app"><form id="f">
    <input name="username"><input name="password" type="password">
    <button type="submit">Sign in</button></form></div>
  <script>
    document.getElementById('f').addEventListener('submit', e => {
      e.preventDefault()
      document.cookie = 'sid=1; path=/'
      document.getElementById('app').innerHTML = '<p>Loading…</p>'
      setTimeout(() => { history.pushState({}, '', '/'); document.getElementById('app').innerHTML = '<h1>Home</h1>' }, 700)
    })
  </script>`)

/** The login form is rendered well after the page has loaded (dev server compiling). */
const LATE_FORM = page(`
  <div id="app"></div>
  <script>
    setTimeout(() => {
      document.getElementById('app').innerHTML = '<form id="f"><input name="username">' +
        '<input name="password" type="password"><button type="submit">Sign in</button></form>'
      document.getElementById('f').addEventListener('submit', e => {
        e.preventDefault(); document.cookie = 'sid=1; path=/'; location.href = '/'
      })
    }, 2500)
  </script>`)

describe('first-run robustness: login', () => {
  let fx: BrowserFixture
  beforeAll(async () => {
    fx = await startBrowserFixture({ '/': page('<h1>Home</h1>'), '/signin': FORM_GONE_BEFORE_REDIRECT, '/late/signin': LATE_FORM })
  })
  afterAll(async () => { await fx?.close() })

  const auth = (login_url: string) => ({
    strategy: 'credentials' as const, login_url, credentials: { email: 'user', password: 'secret' },
  })

  it('accepts a login whose form disappears before the URL changes, on the first attempt', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const outcome = await performLoginDetailed(ctx, fx.baseUrl, auth('/signin'), 1)
      expect(outcome).toMatchObject({ ok: true, attempts: 1 })
    } finally { await ctx.close() }
  })

  it('waits for a login form that renders after the page loads', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const outcome = await performLoginDetailed(ctx, fx.baseUrl, auth('/late/signin'), 0)
      expect(outcome.ok).toBe(true)
    } finally { await ctx.close() }
  })
})

describe('first-run robustness: react-router routes outside App/router files', () => {
  it('expands react-router v5 regex paths', () => {
    expect(expandRoutePath('/(public|contacts|personal)?')).toEqual(['/', '/public', '/contacts', '/personal'])
    expect(expandRoutePath('/user/settings')).toEqual(['/user/settings'])
  })

  it('reads routes from Route and guard tags, marking guarded ones as signed-in', () => {
    const routes = extractRouteTagsFromContent(`
      <Switch>
        <PrivateRoute isLoggedIn={isLoggedIn} exact path={"/(public|contacts)?"}><Feed /></PrivateRoute>
        <PrivateRoute isLoggedIn={isLoggedIn} exact path="/user/settings"><Settings /></PrivateRoute>
        <Route exact path="/signin"><SignIn /></Route>
        <Route path="/*"><Redirect to="/signin" /></Route>
        <svg><path d="M0 0" /></svg>
      </Switch>`)
    expect(routes.map(r => [r.path, r.requires_auth])).toEqual([
      ['/', true], ['/public', true], ['/contacts', true], ['/user/settings', true], ['/signin', false],
    ])
  })
})

/**
 * Found by running vibe-testing on shadcn-admin: shadcn/ui puts
 * data-error="false" on every healthy form label, and the page-health check
 * read any [data-error] element as a visible error ("error visible on page: Email").
 */
describe('first-run robustness: shadcn/ui forms are not errors', () => {
  let fx: BrowserFixture
  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/healthy': page('<form><label data-error="false" for="e">Email</label><input id="e" name="email"><button>Sign in</button></form>'),
      '/invalid': page('<form><label data-error="true" for="e">Email</label><input id="e" name="email"><p data-error="true">Please enter your email.</p></form>'),
    })
  })
  afterAll(async () => { await fx?.close() })

  const health = { action: 'assert' as const, description: 'Page loaded without errors' }

  it('passes a page whose labels carry data-error="false"', async () => {
    const tab = await fx.browser.newPage()
    try {
      await tab.goto(`${fx.baseUrl}/healthy`)
      await expect(assertPage(tab, health, fx.baseUrl)).resolves.toBeUndefined()
    } finally { await tab.close() }
  })

  it('still fails a page that shows a real data-error', async () => {
    const tab = await fx.browser.newPage()
    try {
      await tab.goto(`${fx.baseUrl}/invalid`)
      await expect(assertPage(tab, health, fx.baseUrl)).rejects.toThrow(/error visible on page/)
    } finally { await tab.close() }
  })
})

/**
 * Found on shadcn-admin: 46 of the 56 controls on the sign-in page belonged to
 * the TanStack devtools overlay. Exploring them was slow and reported noise.
 */
describe('first-run robustness: dev overlays are not explored', () => {
  let fx: BrowserFixture
  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/app': page(`
        <button onclick="fetch('/hit/app')">Refresh</button>
        <div class="tsqd-parent-container"><button onclick="fetch('/hit/query-devtools')">Open query panel</button></div>
        <footer class="TanStackRouterDevtools"><button onclick="fetch('/hit/router-devtools')">Router panel</button></footer>
        <nextjs-portal><button onclick="fetch('/hit/next-overlay')">Issues</button></nextjs-portal>`),
    })
  })
  afterAll(async () => { await fx?.close() })

  it('clicks the app button and none of the overlay buttons', async () => {
    const context = await fx.browser.newContext()
    try {
      const exploration = await explorePage(context, '/app', fx.baseUrl, os.tmpdir(), undefined, { boundaryProbes: false })
      expect(fx.hits).toContain('/hit/app')
      expect(fx.hits.filter(hit => /devtools|overlay/.test(hit))).toEqual([])
      expect(exploration.elements_discovered).toBe(1)
    } finally { await context.close() }
  })
})

/**
 * Found on shadcn-admin: scenarios generated from the code clicked link text
 * and filled a field that the page does not have. Each waited 15s twice and
 * was listed under "Bugs Found" as a scenario error.
 */
describe('first-run robustness: a guessed target that is not on the page is skipped, not a bug', () => {
  let fx: BrowserFixture
  let shots: string
  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/apps': page('<h1>Apps</h1><p>Connect your tools and services from this page.</p><button>Refresh</button>'),
      '/covered': page(`<h1>Covered</h1><p>The button below is under an overlay and cannot be clicked.</p>
        <button id="go">Open users</button>
        <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>`),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-first-run-'))
  })
  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  const scenario = (id: string, route: string, steps: TestScenario['steps'], guessed: boolean): TestScenario => ({
    id, name: id, route, priority: 'low', steps, expected_outcome: 'x', is_gap: true, generated_by: 'heuristic',
    ...(guessed ? { targets_guessed: true } : {}),
  })
  const steps = (route: string, step: TestScenario['steps'][number]): TestScenario['steps'] => [
    { action: 'navigate', url: route, description: `Navigate to ${route}` },
    step,
    { action: 'assert', description: 'Page responds' },
  ]
  async function run(sc: TestScenario, retries = 1): Promise<TestResult> {
    const ctx = await fx.browser.newContext()
    try {
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, retries, browser: { headed: false, slowMo: 0 } })
      return await runScenarioWithRetry(sc, ctx, config, shots, shots)
    } finally { await ctx.close() }
  }

  it('skips quickly, with the reason, and does not retry', async () => {
    const started = Date.now()
    const result = await run(scenario('guessed-nav', '/apps',
      steps('/apps', { action: 'click', selector: "text='/users'", description: `Click "'/users'"` }), true))
    expect(result.status).toBe('skip')
    expect(result.failure_reason).toMatch(/the page has no element for the generated step/)
    expect(result.retry).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(collectFailedScenarios([result])).toEqual([])
  }, 30_000)

  it('skips a guessed fill whose field is not on the page', async () => {
    const result = await run(scenario('guessed-fill', '/apps',
      steps('/apps', { action: 'fill', selector: '[name="filter"]', value: 'abc', description: 'Fill filter' }), true))
    expect(result.status).toBe('skip')
  }, 30_000)

  it('still errors when the scenario was not guessed from the code (e.g. written by the user)', async () => {
    const result = await run(scenario('explicit-nav', '/apps',
      steps('/apps', { action: 'click', selector: 'text=Users', timeout: 1500, description: 'Click "Users"' }), false), 0)
    expect(result.status).toBe('error')
  }, 30_000)

  it('still errors when the guessed target exists but cannot be used', async () => {
    const result = await run(scenario('guessed-covered', '/covered',
      steps('/covered', { action: 'click', selector: '#go', description: 'Click "Open users"' }), true), 0)
    expect(result.status).toBe('error')
    expect(result.failure_reason).toMatch(/intercepts pointer events/)
  }, 30_000)

  it('only treats a target that was never found as missing', () => {
    const sc = scenario('s', '/x', [], true)
    const click = { action: 'click' as const, selector: 'text=Go', description: 'Click "Go"' }
    const notFound = new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for getByText('Go').first()")
    const covered = new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator('#go')\n  - locator resolved to <button id=\"go\">Go</button>\n  - <div></div> intercepts pointer events")
    expect(isGuessedTargetMissing(sc, click, notFound)).toBe(true)
    expect(isGuessedTargetMissing(sc, click, covered)).toBe(false)
    expect(isGuessedTargetMissing({ ...sc, targets_guessed: false }, click, notFound)).toBe(false)
    expect(isGuessedTargetMissing(sc, { action: 'click', selector: 'button[type="submit"]', description: 'Submit form' }, notFound)).toBe(false)
  })
})

/**
 * Found on shadcn-admin: a page that shows "No Publishable Key Found!" failed
 * three scenarios that open it, and the report listed the same error three times.
 */
describe('first-run robustness: one page error is reported once', () => {
  const failed = (name: string, route: string, reason: string, status: 'fail' | 'error' = 'fail'): TestResult => ({
    scenario: { id: name, name, route, priority: 'low', steps: [], expected_outcome: 'x', is_gap: true, generated_by: 'heuristic' },
    status, duration_ms: 1, step_logs: [],
    ...(status === 'fail' ? { ai_verdict: reason } : { failure_reason: reason }),
  })
  const KEY = 'Assertion failed: error visible on page: No Publishable Key Found!'

  it('merges scenarios on one page that hit the same error', () => {
    const findings = collectFailedScenarios([
      failed('/clerk redirects to login when unauthenticated', '/clerk', KEY),
      failed('/clerk accessible when authenticated', '/clerk', KEY),
      failed('Data renders on /clerk', '/clerk', `${KEY}\n`),
    ])
    expect(findings).toEqual([{
      name: '/clerk redirects to login when unauthenticated', route: '/clerk', status: 'fail',
      reason: `${KEY} (same error in 2 more scenarios on this page)`,
    }])
  })

  it('keeps different errors and different pages apart', () => {
    const findings = collectFailedScenarios([
      failed('A', '/a', KEY), failed('B', '/b', KEY), failed('A2', '/a', 'Form stayed on /a with no success indication'),
    ])
    expect(findings.map(f => f.name)).toEqual(['A', 'B', 'A2'])
    expect(findings.every(f => !f.reason.includes('same error'))).toBe(true)
  })
})

/**
 * Found on shadcn-admin: a link in the app leads to /dashboard/overview, which
 * renders the app's own "404 Page Not Found" screen. The page-health scenario
 * reported "Could not determine result — review screenshot manually".
 */
describe('first-run robustness: an error screen is a result, not an unknown', () => {
  let fx: BrowserFixture
  let shots: string
  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/dashboard/overview': page(`<h1>404</h1><span>Oops! Page Not Found!</span>
        <p>It seems like the page you're looking for does not exist or might have been removed.</p>
        <button>Go Back</button><button>Back to Home</button>`),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-first-run-'))
  })
  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  it('fails a page-health scenario with what the page shows', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, browser: { headed: false, slowMo: 0 } })
      const result = await runOneScenario({
        id: 'live-smoke-1', name: 'Live page health: /dashboard/overview', route: '/dashboard/overview', route_origin: 'live-crawl',
        priority: 'medium', is_gap: true, generated_by: 'heuristic',
        steps: [
          { action: 'navigate', url: '/dashboard/overview', description: 'Open /dashboard/overview' },
          { action: 'assert', description: 'Verify page health and visible content' },
        ],
        expected_outcome: 'The page loads on the same origin without visible fatal errors.',
      }, ctx, config, shots, shots)
      expect(result.status).toBe('fail')
      expect(result.ai_verdict).toBe('/dashboard/overview shows an error page: "404 Oops! Page Not Found!"')
    } finally { await ctx.close() }
  }, 30_000)

  it('recognises short error screens only', () => {
    expect(describeErrorScreen('404\nOops! Page Not Found!\nGo Back')).toBe('404 Oops! Page Not Found!')
    expect(describeErrorScreen('Something went wrong\nTry again')).toBe('Something went wrong Try again')
    expect(describeErrorScreen('Dashboard\nTotal Revenue\n$45,231.89\nSales\n+500 since last hour')).toBeUndefined()
    expect(describeErrorScreen(`Orders\n${'Order 404 shipped\n'.repeat(60)}`)).toBeUndefined()
    expect(describeErrorScreen('')).toBeUndefined()
  })
})
