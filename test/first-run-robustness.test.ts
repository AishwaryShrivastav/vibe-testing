import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertPage } from '../src/engine/browser/assertions.js'
import { performLoginDetailed } from '../src/engine/browser/auth.js'
import { explorePage } from '../src/engine/browser/explorer.js'
import { expandRoutePath, extractRouteTagsFromContent } from '../src/engine/context/router.js'
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
