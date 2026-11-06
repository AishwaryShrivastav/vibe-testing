import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { watchConsoleErrors } from '../src/engine/browser/page-checks.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/** Buttons whose fetch fails: one is cut off by leaving the page, one hits a closed port. */
const SEND_PAGE = page(`
  <button id="slow">Send</button>
  <button id="refused">Refused</button>
  <script>
    const send = url => fetch(url, { method: 'POST' })
      .catch(e => console.error('Error submitting message:', String(e)))
    document.getElementById('slow').onclick = () => send('/api/slow')
    document.getElementById('refused').onclick = () => send('http://127.0.0.1:59999/api')
  </script>`)

describe('console errors: requests cut off by navigation are not app errors', () => {
  let fx: BrowserFixture

  beforeAll(async () => { fx = await startBrowserFixture({ '/': SEND_PAGE }) })
  afterAll(async () => { await fx?.close() })

  it('ignores "Failed to fetch" from a request aborted by a reload', async () => {
    const tab = await fx.browser.newPage()
    // Hold the request open so the reload cuts it off.
    await tab.route('**/api/slow', route => setTimeout(() => route.fulfill({ status: 200, body: 'ok' }).catch(() => {}), 3000))
    try {
      await tab.goto(fx.baseUrl)
      const logged: string[] = []
      tab.on('console', m => { if (m.type() === 'error') logged.push(m.text()) })
      const watch = watchConsoleErrors(tab)
      await tab.click('#slow')
      await tab.waitForTimeout(100)
      await tab.reload()
      await tab.waitForTimeout(500)
      await watch.settle()
      watch.stop()
      expect(logged.some(text => /Failed to fetch/.test(text))).toBe(true)
      expect(watch.messages).toEqual([])
    } finally {
      await tab.close()
    }
  })

  it('still reports a fetch that failed on its own', async () => {
    const tab = await fx.browser.newPage()
    try {
      await tab.goto(fx.baseUrl)
      const watch = watchConsoleErrors(tab)
      await tab.click('#refused')
      await tab.waitForTimeout(1500)
      await watch.settle()
      watch.stop()
      expect(watch.messages).toHaveLength(1)
      expect(watch.messages[0]).toMatch(/^Error submitting message: TypeError: Failed to fetch/)
    } finally {
      await tab.close()
    }
  })
})

describe('console errors: browser policy notices are not app errors', () => {
  it('ignores "Permissions policy violation" but keeps app errors', async () => {
    const fx = await startBrowserFixture({ '/': page(`<script>
      console.error('Permissions policy violation: compute-pressure is not allowed in this document.')
      console.error('TypeError: cart is undefined')
    </script>`) })
    const tab = await fx.browser.newPage()
    try {
      const watch = watchConsoleErrors(tab)
      await tab.goto(fx.baseUrl)
      await tab.waitForTimeout(300)
      await watch.settle()
      watch.stop()
      expect(watch.messages).toEqual(['TypeError: cart is undefined'])
    } finally {
      await fx.close()
    }
  })
})
