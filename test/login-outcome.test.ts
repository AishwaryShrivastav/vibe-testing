import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { performLoginDetailed } from '../src/engine/browser/auth.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/**
 * The login form lives at /admin and the URL stays /admin after signing in
 * (restful-booker-platform style): the app swaps the form for the admin UI once
 * a slow login request returns and sets a session cookie.
 */
const ADMIN_IN_PLACE = page(`
  <nav><a href="/">Front Page</a> <button>Logout</button></nav>
  <div id="app"></div>
  <script>
    const app = document.getElementById('app')
    function render() {
      if (document.cookie.includes('token=')) {
        app.innerHTML = '<h1>Rooms</h1><a href="/admin/rooms">Rooms</a>'
        return
      }
      app.innerHTML = '<form id="f"><input id="username" placeholder="Enter username">' +
        '<input id="password" type="password" placeholder="Password">' +
        '<button type="submit">Login</button></form><p id="err" role="alert"></p>'
      document.getElementById('f').addEventListener('submit', async e => {
        e.preventDefault()
        const ok = document.getElementById('username').value === 'admin' &&
          document.getElementById('password').value === 'password'
        await new Promise(r => setTimeout(r, 600))
        if (ok) { document.cookie = 'token=abc; path=/'; render() }
        else document.getElementById('err').textContent = 'Invalid credentials'
      })
    }
    render()
  </script>`)

describe('login outcome: judged by the form, not only the URL', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({ '/': page('<h1>Home</h1>'), '/admin': ADMIN_IN_PLACE })
  })
  afterAll(async () => { await fx?.close() })

  const auth = (password: string) => ({
    strategy: 'credentials' as const,
    login_url: '/admin',
    credentials: { email: 'admin', password },
  })

  it('waits for the form to go away and keeps the session cookie', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const outcome = await performLoginDetailed(ctx, fx.baseUrl, auth('password'), 0)
      expect(outcome.ok).toBe(true)
      expect((await ctx.cookies()).map(c => c.name)).toContain('token')
    } finally {
      await ctx.close()
    }
  })

  it('reports failure when the form is still shown at a non-login URL', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const outcome = await performLoginDetailed(ctx, fx.baseUrl, auth('wrong'), 0)
      expect(outcome.ok).toBe(false)
      expect(outcome.firstFailure).toBe('Invalid credentials')
    } finally {
      await ctx.close()
    }
  }, 30000)
})
