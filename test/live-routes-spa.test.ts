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
