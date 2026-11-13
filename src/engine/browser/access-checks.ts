import path from 'node:path'
import type { Browser, BrowserContext } from 'playwright'
import type { AuthConfig, VibeConfig } from '../../types/config.js'
import type { TestResult, TestScenario } from '../../types/index.js'
import type { ActionBlocklist } from '../../utils/blocklist.js'
import { interpolateEnv } from '../../utils/env.js'
import { isStillOnLoginPage, performLoginDetailed } from './auth.js'
import { isAuthNavigation, isDestructiveAction } from './explorer.js'

/** One configured account, ready to log in with. */
export interface Account {
  /** How the account is named in findings: its configured name or login identifier. */
  name: string
  auth: AuthConfig
}

/**
 * The two accounts to compare: the main credentials (or the first account)
 * and the first other account with a different login identifier. Undefined
 * when fewer than two distinct accounts are configured.
 */
export function resolveAccounts(auth: AuthConfig | undefined): [Account, Account] | undefined {
  if (!auth || (auth.strategy !== 'credentials' && auth.strategy !== 'basic')) return undefined
  const all = [
    ...(auth.credentials ? [{ name: undefined as string | undefined, credentials: auth.credentials }] : []),
    ...(auth.accounts ?? []),
  ]
  const [first] = all
  const second = all.find(account => account.credentials.email.trim().toLowerCase() !== first?.credentials.email.trim().toLowerCase())
  if (!first || !second) return undefined
  const toAccount = (account: typeof first): Account => ({
    name: account.name ?? interpolateEnv(account.credentials.email),
    auth: { ...auth, credentials: account.credentials, accounts: undefined },
  })
  return [toAccount(first), toAccount(second)]
}

// ─── URL identifiers ──────────────────────────────────────────────────────────

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})$/i
const ID_PARAM = /(?:^|[_-])(?:id|uid|user|account|owner|customer|profile|member)(?:[_-]?id)?$|id$/i

/** Identifier values in a URL: id-like path segments and id-named query parameters. */
export function urlIdentifiers(url: string): string[] {
  let parsed: URL
  try { parsed = new URL(url) } catch { return [] }
  const ids = parsed.pathname.split('/').filter(segment => ID_SEGMENT.test(segment))
  for (const [key, value] of parsed.searchParams) {
    if (value && ID_PARAM.test(key)) ids.push(value)
  }
  return ids
}

/** The URL with identifiers replaced, so /allocations/2 and /allocations/3 share a pattern. */
export function urlPattern(url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { return url }
  const pathname = parsed.pathname.split('/').map(segment => ID_SEGMENT.test(segment) ? ':id' : segment).join('/')
  const params = [...parsed.searchParams].map(([key, value]) => `${key}=${value && ID_PARAM.test(key) ? ':id' : value}`).sort()
  return `${pathname}${params.length ? `?${params.join('&')}` : ''}`
}

/** The URL with one identifier value replaced by another (path segment or id-named query value). */
function swapIdentifier(url: string, from: string, to: string): string | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  let swapped = false
  parsed.pathname = parsed.pathname.split('/').map(segment => {
    if (segment === from && ID_SEGMENT.test(segment)) { swapped = true; return to }
    return segment
  }).join('/')
  for (const [key, value] of [...parsed.searchParams]) {
    if (value === from && ID_PARAM.test(key)) { parsed.searchParams.set(key, to); swapped = true }
  }
  return swapped ? parsed.href : undefined
}

// ─── Page reading ─────────────────────────────────────────────────────────────

interface PageView {
  url: string
  /** Final URL after redirects. */
  landed: string
  status: number
  /** Redirected to sign-in or shown a sign-in form. */
  signIn: boolean
  lines: string[]
  links: Array<{ href: string; text: string }>
}

const SKIP_EXTENSION = /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|csv|xlsx?|docx?|mp4|mp3|ico|css|js|json|xml|txt)$/i

async function readPage(context: BrowserContext, url: string): Promise<PageView | undefined> {
  const page = await context.newPage()
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
    const landed = page.url()
    const text = await page.innerText('body', { timeout: 3000 }).catch(() => '')
    const passwordShown = await page.locator('input[type="password"]:visible').count().then(n => n > 0).catch(() => false)
    const links = await page.$$eval('a[href]', anchors => anchors.map(a => ({
      href: (a as HTMLAnchorElement).href,
      text: (a.textContent ?? '').trim().slice(0, 80),
    }))).catch(() => [] as Array<{ href: string; text: string }>)
    return {
      url,
      landed,
      status: response?.status() ?? 0,
      signIn: isStillOnLoginPage(landed) || passwordShown,
      lines: textLines(text),
      links,
    }
  } catch {
    return undefined
  } finally {
    await page.close().catch(() => {})
  }
}

function textLines(text: string): string[] {
  const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim())
  return [...new Set(lines.filter(line => line.length >= 2 && line.length <= 200 && /[a-z0-9]/i.test(line)))]
}

/**
 * Pages a signed-in user can reach: the seeds plus same-origin links, read by
 * direct navigation. Never follows sign-out, auth or destructive links.
 */
async function crawlAs(
  context: BrowserContext,
  seeds: string[],
  origin: string,
  blocklist: ActionBlocklist | undefined,
  maxPages: number,
): Promise<Map<string, PageView>> {
  const views = new Map<string, PageView>()
  const queue = [...new Set(seeds)]
  const seen = new Set(queue)
  while (queue.length > 0 && views.size < maxPages) {
    const url = queue.shift()!
    const view = await readPage(context, url)
    if (!view || view.signIn || view.status >= 400) continue
    views.set(normalizeUrl(view.landed), view)
    for (const link of view.links) {
      const next = followable(link, origin, blocklist)
      if (next && !seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return views
}

function followable(link: { href: string; text: string }, origin: string, blocklist: ActionBlocklist | undefined): string | undefined {
  let parsed: URL
  try { parsed = new URL(link.href) } catch { return undefined }
  if (parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) return undefined
  if (SKIP_EXTENSION.test(parsed.pathname)) return undefined
  // Links are opened with GET, so a "delete"/"logout" anywhere in the URL is skipped too.
  const target = `${parsed.pathname}${parsed.search}`
  if (isAuthNavigation(link.text, target) || isDestructiveAction(link.text) || isDestructiveAction(target)) return undefined
  if (blocklist?.isBlocked(parsed.pathname, link.text)) return undefined
  return normalizeUrl(parsed.href)
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch { return url }
}

// ─── The check ────────────────────────────────────────────────────────────────

export interface CrossUserFinding {
  url: string
  /** What the other user saw: the owner's identity or data lines. */
  evidence: string[]
}

export interface CrossUserOptions {
  /** Pages to read per user (default 15). */
  maxPages?: number
  /** Owner URLs to try as the other user (default 8). */
  maxCandidates?: number
}

/**
 * Cross-user access: log in as two configured accounts in separate sessions,
 * collect the pages the first (owner) can reach that carry an identifier
 * (/allocations/2, ?accountId=…), and open them as the second user. Also
 * swaps the owner's ids into the second user's own id-bearing URLs.
 *
 * A URL fails when the second user gets it (no sign-in, no 4xx) and sees
 * data that belongs to the owner:
 *  - the owner's identity (configured name / login identifier) where it never
 *    appears on the second user's own pages, or
 *  - at least two lines the owner also sees on that URL that never appear on
 *    the second user's own pages, when the second user has their own page of
 *    the same kind (same URL pattern) to compare against.
 * URLs the second user is linked to themselves, or that a logged-out visitor
 * can also read, are shared/public and are not judged.
 *
 * Returns undefined when fewer than two accounts are configured, a login
 * fails, or there are no owner URLs with identifiers to try.
 */
export async function checkCrossUserAccess(
  browser: Browser,
  config: VibeConfig,
  seedRoutes: string[],
  screenshotsDir: string,
  blocklist?: ActionBlocklist,
  options: CrossUserOptions = {},
): Promise<TestResult | undefined> {
  const accounts = resolveAccounts(config.auth)
  if (!accounts) return undefined
  const [owner, other] = accounts
  const maxPages = options.maxPages ?? 15
  const maxCandidates = options.maxCandidates ?? 8
  const origin = new URL(config.url).origin
  const started = Date.now()

  const scenario: TestScenario = {
    id: 'cross-user-access',
    name: 'Users cannot open each other\'s pages',
    route: seedRoutes[0] ?? '/',
    priority: 'high',
    steps: [
      { action: 'navigate', description: `Log in as ${owner.name} and collect pages with identifiers` },
      { action: 'navigate', description: `Log in as ${other.name} in a separate session` },
      { action: 'navigate', description: `Open ${owner.name}'s pages as ${other.name}` },
      { action: 'assert', description: `Expect a denial, sign-in or no ${owner.name}-specific data` },
    ],
    expected_outcome: 'Each user only sees their own data',
    is_gap: true,
    generated_by: 'heuristic',
    requires_auth: true,
  }

  const contextOptions = { baseURL: config.url, viewport: { width: 1280, height: 800 } }
  const ownerContext = await browser.newContext(contextOptions)
  const otherContext = await browser.newContext(contextOptions)
  const anonymousContext = await browser.newContext(contextOptions)
  try {
    const ownerLogin = await performLoginDetailed(ownerContext, config.url, owner.auth, config.retries)
    const otherLogin = await performLoginDetailed(otherContext, config.url, other.auth, config.retries)
    if (!ownerLogin.ok || !otherLogin.ok) return undefined

    const seedsFor = (landing: string | undefined) => [
      ...(landing ? [landing] : []),
      ...seedRoutes.filter(route => !/[:[*]/.test(route)).map(route => new URL(route, config.url).href),
    ].map(normalizeUrl)
    const ownerPages = await crawlAs(ownerContext, seedsFor(ownerLogin.landingUrl), origin, blocklist, maxPages)
    const otherPages = await crawlAs(otherContext, seedsFor(otherLogin.landingUrl), origin, blocklist, maxPages)

    // What the other user sees on their own pages: shared layout, labels, their own data.
    const otherBaseline = new Set([...otherPages.values()].flatMap(view => view.lines))
    const otherText = [...otherBaseline].join('\n').toLowerCase()
    const otherPatterns = new Set([...otherPages.keys()].map(urlPattern))
    const ownerText = [...ownerPages.values()].flatMap(view => view.lines).join('\n').toLowerCase()

    // The owner's identity, when the app shows it to the owner and not on the other user's pages.
    const identity = identityMarkers(owner).filter(marker => containsWord(ownerText, marker) && !containsWord(otherText, marker))

    const candidates = candidateUrls(ownerPages, otherPages, maxCandidates)
    if (candidates.length === 0) return undefined

    const findings: CrossUserFinding[] = []
    const denied: string[] = []
    const notSpecific: string[] = []
    let leakShot: string | undefined
    for (const url of candidates) {
      const ownerView = ownerPages.get(url) ?? await readPage(ownerContext, url)
      if (!ownerView || ownerView.signIn || ownerView.status >= 400) continue
      const otherView = await readPage(otherContext, url)
      if (!otherView) continue
      if (otherView.signIn || otherView.status >= 400) { denied.push(`${pathOf(url)} (${otherView.signIn ? 'sign-in' : otherView.status})`); continue }

      const otherSees = new Set(otherView.lines)
      const shown = ownerView.lines.filter(line => otherSees.has(line) && !otherBaseline.has(line))
      const identityShown = identity.filter(marker => containsWord(otherView.lines.join('\n').toLowerCase(), marker))
      const comparable = otherPatterns.has(urlPattern(url))
      const evidence = identityShown.length > 0
        ? [...identityShown.map(marker => `identity "${marker}"`), ...shown.slice(0, 3).map(line => `"${line}"`)]
        : comparable && shown.length >= 2 ? shown.slice(0, 4).map(line => `"${line}"`) : []
      if (evidence.length === 0) { notSpecific.push(pathOf(url)); continue }

      // Readable without signing in too: public content, not one user's private page.
      const anonymousView = await readPage(anonymousContext, url)
      if (anonymousView && !anonymousView.signIn && anonymousView.status < 400) {
        const anonymousSees = new Set(anonymousView.lines)
        if (shown.some(line => anonymousSees.has(line))) { notSpecific.push(`${pathOf(url)} (public)`); continue }
      }

      findings.push({ url, evidence })
      if (!leakShot) {
        const page = await otherContext.newPage()
        const shot = path.join(screenshotsDir, `${scenario.id}.png`)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
        if (await page.screenshot({ path: shot, fullPage: false }).then(() => true).catch(() => false)) leakShot = shot
        await page.close().catch(() => {})
      }
    }

    const checked = findings.length + denied.length + notSpecific.length
    if (checked === 0) return undefined
    const leaked = findings.length > 0
    const verdict = leaked
      ? `${other.name} opened ${owner.name}'s ${findings.length === 1 ? 'page' : 'pages'} and saw their data: ` +
        findings.map(finding => `${pathOf(finding.url)} showed ${finding.evidence.join(', ')}`).join('; ')
      : denied.length > 0
        ? `${other.name} could not open ${owner.name}'s pages: ${denied.join(', ')}${notSpecific.length ? `; no ${owner.name}-specific data on ${notSpecific.join(', ')}` : ''}`
        : `${other.name} opened ${owner.name}'s URLs but saw no ${owner.name}-specific data: ${notSpecific.join(', ')}`

    return {
      scenario,
      status: leaked ? 'fail' : 'pass',
      duration_ms: Date.now() - started,
      screenshot_path: leakShot,
      current_url: findings[0]?.url,
      ai_verdict: verdict,
      verification_status: leaked || denied.length > 0 ? 'outcome_verified' : 'smoke_check_passed',
      step_logs: [],
    }
  } catch {
    return undefined
  } finally {
    await Promise.all([ownerContext, otherContext, anonymousContext].map(context => context.close().catch(() => {})))
  }
}

/**
 * Owner URLs to try as the other user: the owner's id-bearing URLs the other
 * user is not linked to, then the other user's own id-bearing URLs with their
 * id swapped for one of the owner's.
 */
function candidateUrls(ownerPages: Map<string, PageView>, otherPages: Map<string, PageView>, max: number): string[] {
  const otherUrls = new Set(otherPages.keys())
  const ownerUrls = [...ownerPages.keys()]
  const candidates = ownerUrls.filter(url => urlIdentifiers(url).length > 0 && !otherUrls.has(url))

  const otherIds = new Set([...otherUrls].flatMap(urlIdentifiers))
  const ownerIds = [...new Set(ownerUrls.flatMap(urlIdentifiers))].filter(id => !otherIds.has(id))
  for (const url of otherUrls) {
    for (const otherId of urlIdentifiers(url).filter(id => !ownerUrls.some(owned => urlIdentifiers(owned).includes(id)))) {
      for (const ownerId of ownerIds.slice(0, 2)) {
        const swapped = swapIdentifier(url, otherId, ownerId)
        if (swapped && !otherUrls.has(normalizeUrl(swapped))) candidates.push(normalizeUrl(swapped))
      }
    }
  }
  return [...new Set(candidates)].slice(0, max)
}

/** Ways the app may show the owner: configured name, login identifier, the local part of an email. */
function identityMarkers(account: Account): string[] {
  const login = interpolateEnv(account.auth.credentials?.email ?? '').trim()
  const markers = [account.name.trim(), login, login.includes('@') ? login.split('@')[0] : '']
  return [...new Set(markers.filter(marker => marker.length >= 3).map(marker => marker.toLowerCase()))]
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(haystack)
}

function pathOf(url: string): string {
  try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` } catch { return url }
}
