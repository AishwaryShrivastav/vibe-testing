import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { LiveRouteCrawl, Route, TestScenario } from '../../types/index.js'
import type { AuthConfig } from '../../types/config.js'
import { ActionBlocklist } from '../../utils/blocklist.js'
import { performLogin } from './auth.js'

const DESTRUCTIVE_PATH = /(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|cancel|unsubscribe|revoke)(?:\/|$)/i
const ASSET_PATH = /\.(?:css|js|mjs|map|json|xml|txt|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|zip)(?:$|\?)/i

export interface LiveRouteCrawlInput {
  baseUrl: string
  /** Page budget per crawl pass (the logged-in pass gets its own budget). */
  maxPages?: number
  maxDepth?: number
  timeoutMs?: number
  blockedPatterns?: string[]
  /** With credentials, also crawl logged in; pages only reachable then are marked requires_auth. */
  auth?: AuthConfig
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
    const options = { origin, maxPages, maxDepth, timeoutMs, blocklist }
    const publicPass = await crawlPass(context, options)
    const routes: Route[] = publicPass.paths.map(path => liveRoute(path, false))
    const attemptedPaths = [...publicPass.attempted]

    let auth: LiveRouteCrawl['auth']
    if (input.auth?.strategy === 'credentials' && input.auth.credentials) {
      // Crawl again in a separate, logged-in context so pages behind the
      // sign-in are discovered too. Logout links stay blocked (DESTRUCTIVE_PATH).
      const authBrowser = browser ?? context.browser()
      if (!authBrowser) {
        auth = { status: 'unavailable', pages: 0 }
      } else {
        const authContext = await authBrowser.newContext({ baseURL: origin })
        try {
          authContext.setDefaultTimeout(timeoutMs)
          if (await performLogin(authContext, origin, input.auth)) {
            const authPass = await crawlPass(authContext, options)
            const publicPaths = new Set(publicPass.paths)
            const added = authPass.paths.filter(path => !publicPaths.has(path))
            routes.push(...added.map(path => liveRoute(path, true)))
            attemptedPaths.push(...authPass.attempted)
            auth = { status: 'logged-in', pages: added.length }
          } else {
            auth = { status: 'login-failed', pages: 0 }
          }
        } finally {
          await authContext.close().catch(() => {})
        }
      }
    }

    const scenarios = routes.map(toSmokeScenario)
    return {
      status: scenarios.length > 0 ? 'completed' : 'unavailable',
      routes,
      scenarios,
      attemptedPaths,
      reason: scenarios.length > 0 ? undefined : 'No safe same-origin HTML pages were reachable.',
      ...(auth ? { auth } : {}),
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

interface CrawlPassOptions {
  origin: string
  maxPages: number
  maxDepth: number
  timeoutMs: number
  blocklist: ActionBlocklist
}

/** Breadth-first crawl from `/` within one browser context. Returns canonical page paths in visit order. */
async function crawlPass(
  context: BrowserContext,
  { origin, maxPages, maxDepth, timeoutMs, blocklist }: CrawlPassOptions,
): Promise<{ paths: string[]; attempted: string[] }> {
  const page = await context.newPage()
  const queue: Array<{ path: string; depth: number }> = [{ path: '/', depth: 0 }]
  const queued = new Set(['/'])
  const attempted: string[] = []
  const paths: string[] = []

  try {
    while (queue.length > 0 && attempted.length < maxPages) {
      const next = queue.shift()!
      attempted.push(next.path)
      try {
        const response = await page.goto(new URL(next.path, origin).href, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        })
        const finalUrl = new URL(page.url())
        if (finalUrl.origin !== origin || (response && response.status() >= 400)) continue
        const canonicalPath = normalizePath(finalUrl.pathname)
        if (!paths.includes(canonicalPath)) paths.push(canonicalPath)
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
  } finally {
    await page.close().catch(() => {})
  }
  return { paths, attempted }
}

function liveRoute(path: string, requiresAuth: boolean): Route {
  return {
    path,
    type: 'page',
    requires_auth: requiresAuth,
    dynamic_segments: [],
    origin: 'live-crawl',
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
    name: `Live page health: ${route.path}${route.requires_auth ? ' (logged in)' : ''}`,
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
    requires_auth: route.requires_auth,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}
