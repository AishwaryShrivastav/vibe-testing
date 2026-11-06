import type { Page, Request } from 'playwright'

/**
 * "The page has finished rendering": no network request started or finished
 * for `quietMs`, nothing in flight (requests open longer than `longRequestMs`
 * — polling, streams — are ignored), and no DOM change for `quietMs`.
 *
 * Network idle alone is not enough (a client-rendered page renders after its
 * data arrives) and waiting for it alone is slow on apps that poll; DOM quiet
 * alone is too early (the page waits quietly for a fetch). Both together, with
 * a cap, settle fast on quiet pages and still wait for data-driven content.
 */

interface Tracker {
  inflight: Map<Request, number>
  lastActivity: number
}

const trackers = new WeakMap<Page, Tracker>()

/** Start counting the page's requests. Call before navigating; safe to call twice. */
export function trackRequests(page: Page): Tracker {
  const existing = trackers.get(page)
  if (existing) return existing
  const tracker: Tracker = { inflight: new Map(), lastActivity: Date.now() }
  const start = (request: Request) => { tracker.inflight.set(request, Date.now()); tracker.lastActivity = Date.now() }
  const end = (request: Request) => { tracker.inflight.delete(request); tracker.lastActivity = Date.now() }
  page.on('request', start)
  page.on('requestfinished', end)
  page.on('requestfailed', end)
  trackers.set(page, tracker)
  return tracker
}

export interface SettleOptions {
  /** Give up after this long (the page is used as it is). Default 4000. */
  capMs?: number
  /** How long network and DOM must both stay quiet. Default 300. */
  quietMs?: number
  /** Requests open longer than this don't hold the page (polling, streams). Default 2000. */
  longRequestMs?: number
}

export async function waitForSettled(page: Page, options: SettleOptions = {}): Promise<void> {
  const { capMs = 4000, quietMs = 300, longRequestMs = 2000 } = options
  const tracker = trackRequests(page)
  const deadline = Date.now() + capMs
  // DOM mutations are timestamped in the page; the clocks are the same machine's.
  await page.evaluate(`(() => {
    if (window.__vibeLastMutation !== undefined) return
    window.__vibeLastMutation = Date.now()
    new MutationObserver(() => { window.__vibeLastMutation = Date.now() })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })()`).catch(() => {})

  while (Date.now() < deadline) {
    const now = Date.now()
    const busy = [...tracker.inflight.values()].some(started => now - started < longRequestMs)
    const networkQuiet = !busy && now - tracker.lastActivity >= quietMs
    if (networkQuiet) {
      const lastMutation = await page.evaluate('window.__vibeLastMutation || 0').catch(() => 0) as number
      if (Date.now() - lastMutation >= quietMs) return
    }
    await page.waitForTimeout(100).catch(() => {})
    if (page.isClosed()) return
  }
}

/** Open a URL and wait until it has rendered (see waitForSettled). */
export async function gotoSettled(page: Page, url: string, timeout: number, capMs = 4000) {
  trackRequests(page)
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
  await waitForSettled(page, { capMs })
  return response
}
