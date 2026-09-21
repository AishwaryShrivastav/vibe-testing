import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { LiveRouteCrawl, Route, TestScenario } from '../../types/index.js'
import { ActionBlocklist } from '../../utils/blocklist.js'

const DESTRUCTIVE_PATH = /(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|cancel|unsubscribe|revoke)(?:\/|$)/i
const ASSET_PATH = /\.(?:css|js|mjs|map|json|xml|txt|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip)(?:$|\?)/i

export interface LiveRouteCrawlInput {
  baseUrl: string
  maxPages?: number
  maxDepth?: number
  timeoutMs?: number
  blockedPatterns?: string[]
}

export interface LiveRouteCrawlDependencies {
  browser?: Browser
  context?: BrowserContext
}

export async function crawlLiveRoutes(
  input: LiveRouteCrawlInput,
  dependencies: LiveRouteCrawlDependencies = {},
): Promise<LiveRouteCrawl> {
  const maxPages = clamp(input.maxPages ?? 12, 1, 30)
  const maxDepth = clamp(input.maxDepth ?? 2, 0, 4)
  const timeoutMs = clamp(input.timeoutMs ?? 10_000, 500, 30_000)
  const blocklist = new ActionBlocklist(input.blockedPatterns ?? [])
  let origin: string
  try {
    origin = new URL(input.baseUrl).origin
  } catch {
    return { status: 'unavailable', routes: [], scenarios: [], attemptedPaths: [], reason: 'The application URL is invalid.' }
  }

  let ownedBrowser: Browser | undefined
  let ownedContext: BrowserContext | undefined
  try {
    const browser = dependencies.browser ?? (dependencies.context ? undefined : await chromium.launch({ headless: true }))
    ownedBrowser = dependencies.browser || dependencies.context ? undefined : browser
    const context = dependencies.context ?? await browser!.newContext({ baseURL: origin })
    ownedContext = dependencies.context ? undefined : context
    context.setDefaultTimeout(timeoutMs)
    const page = await context.newPage()
    const queue: Array<{ path: string; depth: number }> = [{ path: '/', depth: 0 }]
    const queued = new Set(['/'])
    const attemptedPaths: string[] = []
    const routes: Route[] = []

    while (queue.length > 0 && attemptedPaths.length < maxPages) {
      const next = queue.shift()!
      attemptedPaths.push(next.path)
      try {
        const response = await page.goto(new URL(next.path, origin).href, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        })
        const finalUrl = new URL(page.url())
        if (finalUrl.origin !== origin || (response && response.status() >= 400)) continue
        const canonicalPath = normalizePath(finalUrl.pathname)
        if (!routes.some(route => route.path === canonicalPath)) {
          routes.push({
            path: canonicalPath,
            type: 'page',
            requires_auth: false,
            dynamic_segments: [],
            origin: 'live-crawl',
          })
        }
        if (next.depth >= maxDepth) continue

        const hrefs = await page.locator('a[href]').evaluateAll(elements =>
          elements.map(element => (element as HTMLAnchorElement).href)
        )
        for (const href of hrefs) {
          const safePath = safeSameOriginPath(href, origin, blocklist)
          if (!safePath || queued.has(safePath)) continue
          queued.add(safePath)
          queue.push({ path: safePath, depth: next.depth + 1 })
        }
      } catch {
        // A failed page is evidence for diagnostics, not a reason to abort the bounded crawl.
      }
    }
    await page.close().catch(() => {})

    const scenarios = routes.map(toSmokeScenario)
    return {
      status: scenarios.length > 0 ? 'completed' : 'unavailable',
      routes,
      scenarios,
      attemptedPaths,
      reason: scenarios.length > 0 ? undefined : 'No safe same-origin HTML pages were reachable.',
    }
  } catch (error) {
    return {
      status: 'failed',
      routes: [],
      scenarios: [],
      attemptedPaths: ['/'],
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await ownedContext?.close().catch(() => {})
    await ownedBrowser?.close().catch(() => {})
  }
}

function safeSameOriginPath(href: string, origin: string, blocklist: ActionBlocklist): string | undefined {
  try {
    const url = new URL(href, origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.hash || url.search || ASSET_PATH.test(url.pathname)) return undefined
    const path = normalizePath(url.pathname)
    if (DESTRUCTIVE_PATH.test(path) || blocklist.isBlocked(path, path)) return undefined
    return path
  } catch {
    return undefined
  }
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  return normalized || '/'
}

function toSmokeScenario(route: Route, index: number): TestScenario {
  return {
    id: `live-smoke-${index + 1}`,
    name: `Live page health: ${route.path}`,
    route: route.path,
    route_origin: 'live-crawl',
    priority: 'medium',
    steps: [
      { action: 'navigate', url: route.path, description: `Open ${route.path}` },
      { action: 'assert', description: 'Verify page health and visible content' },
    ],
    expected_outcome: 'The page loads on the same origin without visible fatal errors.',
    is_gap: true,
    generated_by: 'heuristic',
    requires_auth: false,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}
