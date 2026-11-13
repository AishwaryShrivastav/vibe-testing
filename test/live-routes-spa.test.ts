import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawlLiveRoutes } from '../src/engine/browser/live-routes.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/** Navigation rendered by script after a slow data call (a session check), as in client-rendered apps. */
const LATE_NAV = page(`
  <div id="nav"></div>
  <script>
    fetch('/api/session').then(() => {
      document.getElementById('nav').innerHTML =
        '<a href="/rooms">Rooms</a> <a href="/report">Report</a> <a href="/messages">Messages</a>'
    })
  </script>`)

describe('live crawl: client-rendered navigation', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/': LATE_NAV,
      '/rooms': page('<h1>Rooms</h1>'),
      '/report': page('<h1>Report</h1>'),
      '/messages': page('<h1>Messages</h1>'),
    })
  })
  afterAll(async () => { await fx?.close() })

  it('reads links that appear after scripts run', async () => {
    const context = await fx.browser.newContext({ baseURL: fx.baseUrl })
    // The session check answers slowly, so the nav appears well after DOMContentLoaded.
    await context.route('**/api/session', route =>
      setTimeout(() => route.fulfill({ status: 200, body: '{}' }).catch(() => {}), 1200))
    const crawl = await crawlLiveRoutes({ baseUrl: fx.baseUrl }, { context })
    await context.close()
    expect(crawl.routes.map(r => r.path).sort()).toEqual(['/', '/messages', '/report', '/rooms'])
  }, 60000)
})

describe('explorer: waits for content rendered after data loads', () => {
  let fx: BrowserFixture

  // The nav (3 controls) is there at once; the page's own form appears only
  // after a slow data request, as on a client-rendered admin page.
  const ADMIN = page(`
    <nav><a href="/">Home</a> <a href="/help">Help</a> <button>Logout</button></nav>
    <main id="main">Loading…</main>
    <script>
      fetch('/api/rooms').then(() => {
        document.getElementById('main').innerHTML =
          '<h1>Rooms</h1><input id="room" placeholder="Room name">' +
          '<label><input type="checkbox" id="wifi"> WiFi</label><button id="create">Create</button>'
      })
    </script>`)

  beforeAll(async () => {
    fx = await startBrowserFixture({ '/': page('<h1>Home</h1>'), '/help': page('<h1>Help</h1>'), '/admin': ADMIN })
  })
  afterAll(async () => { await fx?.close() })

  it('discovers controls that render after the data request', async () => {
    const { explorePage } = await import('../src/engine/browser/explorer.js')
    const os = await import('node:os')
    const context = await fx.browser.newContext()
    await context.route('**/api/rooms', route =>
      setTimeout(() => route.fulfill({ status: 200, body: '[]' }).catch(() => {}), 1200))
    try {
      const exploration = await explorePage(context, '/admin', fx.baseUrl, os.tmpdir(), undefined,
        { boundaryProbes: false, createChecks: false, journey: false })
      expect(exploration.interactions.map(i => i.element)).toEqual(expect.arrayContaining(['Create']))
      // A checkbox is toggled, never "filled" (which always fails and read as broken).
      expect(exploration.interactions.filter(i => /Fill failed/.test(i.details))).toEqual([])
      expect(exploration.interactions.some(i => i.elementType === 'checkbox' && i.result === 'success')).toBe(true)
    } finally {
      await context.close()
    }
  }, 60000)
})

describe('explorer: link verification by resolved URL', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/': page(`
        <div class="room"><h3>Single</h3><a href="/reservation/1?checkin=2026-01-01">Book now</a></div>
        <div class="room"><h3>Double</h3><a href="/reservation/2?checkin=2026-01-01">Book now</a></div>
        <a href="/hidden" style="display:none">Hidden</a>`),
      '/reservation/1': page('<h1>Reservation 1</h1>'),
      '/reservation/2': page('<h1>Reservation 2</h1>'),
      '/hidden': page('<h1>Hidden</h1>'),
    })
  })
  afterAll(async () => { await fx?.close() })

  it('finds relative links with a query string and visits them with the query', async () => {
    const { explorePage } = await import('../src/engine/browser/explorer.js')
    const os = await import('node:os')
    const context = await fx.browser.newContext()
    try {
      const exploration = await explorePage(context, '/', fx.baseUrl, os.tmpdir(), undefined,
        { boundaryProbes: false, createChecks: false, journey: false })
      const bookNow = exploration.interactions.filter(i => i.element === 'Book now')
      expect(bookNow.length).toBeGreaterThan(0)
      expect(bookNow.every(i => i.result === 'navigated')).toBe(true)
      expect(fx.hits).toContain('/reservation/1?checkin=2026-01-01')
    } finally {
      await context.close()
    }
  }, 60000)
})

describe('live crawl: pages only linked with a query string', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/': page(`
        <a href="/reservation/1?checkin=2026-01-01&checkout=2026-01-02">Book now</a>
        <a href="/reservation/1?checkin=2026-02-01&checkout=2026-02-02">Book now</a>
        <a href="/reservation/2?checkin=2026-01-01">Book now</a>
        <a href="/rooms?view=grid">Rooms (grid)</a>
        <a href="/rooms">Rooms</a>
        <a href="/account?action=delete">Delete my account</a>
        <a href="/session?logout=1">Sign out</a>`),
      '/reservation/1': page('<h1>Reservation 1</h1>'),
      '/reservation/2': page('<h1>Reservation 2</h1>'),
      '/rooms': page('<h1>Rooms</h1>'),
      '/account': page('<h1>Account</h1>'),
      '/session': page('<h1>Session</h1>'),
    })
  })
  afterAll(async () => { await fx?.close() })

  it('keeps one URL per path, prefers plain links, and skips acting queries', async () => {
    const crawl = await crawlLiveRoutes({ baseUrl: fx.baseUrl, maxPages: 10 }, { browser: fx.browser })
    expect(crawl.routes.map(r => r.path)).toEqual([
      '/', '/rooms', '/reservation/1?checkin=2026-01-01&checkout=2026-01-02', '/reservation/2?checkin=2026-01-01',
    ])
    expect(fx.hits).not.toContain('/reservation/1?checkin=2026-02-01&checkout=2026-02-02')
    expect(fx.hits.some(hit => hit.startsWith('/account'))).toBe(false)
    expect(fx.hits.some(hit => hit.startsWith('/session'))).toBe(false)
  }, 60000)
})
