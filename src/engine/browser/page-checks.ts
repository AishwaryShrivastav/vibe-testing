import type { ConsoleMessage, Page, Request } from 'playwright'

/**
 * Functional page checks that need no assertion and no knowledge of the app:
 * console errors, broken rendered values, and "empty state" text.
 * Each pattern is tuned to value positions on short lines, so ordinary prose
 * and documentation do not match.
 */

// ── Console errors ──────────────────────────────────────────────────────────

const CONSOLE_NOISE = [
  /favicon\.ico/i,
  /Download the React DevTools/i,
  /\[HMR\]|\[vite\]/i,
  // Network failures are reported by watchResourceFailures with their URL.
  /^Failed to load resource/i,
]

// ── Broken and unavailable resources ────────────────────────────────────────

const RESOURCE_TYPES = new Set(['image', 'script', 'stylesheet', 'font', 'media'])

/**
 * Watch sub-resources (images, scripts, styles, fonts, media) until stop():
 * - broken: same-origin resources answering 4xx/5xx (a missing image, a
 *   script that 404s) — a functional bug in the app itself;
 * - unavailable: resources on another origin that fail, or connection
 *   failures — usually environment (a dev tool or CDN that is not running).
 * Page loads and fetch/XHR are covered by the server-error watcher.
 */
export function watchResourceFailures(page: Page, pageOrigin: string): { broken: string[]; unavailable: string[]; stop: () => void } {
  const broken: string[] = []
  const unavailable: string[] = []
  const add = (list: string[], entry: string) => { if (!list.includes(entry)) list.push(entry) }
  const shortUrl = (url: string) => {
    try {
      const parsed = new URL(url)
      return parsed.origin === pageOrigin ? parsed.pathname + parsed.search : `${parsed.origin}${parsed.pathname}`
    } catch { return url }
  }
  const onResponse = (response: import('playwright').Response) => {
    const request = response.request()
    if (!RESOURCE_TYPES.has(request.resourceType()) || response.status() < 400) return
    if (/favicon\.ico/i.test(response.url())) return
    const sameOrigin = (() => { try { return new URL(response.url()).origin === pageOrigin } catch { return false } })()
    add(sameOrigin ? broken : unavailable, `${response.status()} ${request.resourceType()} ${shortUrl(response.url())}`)
  }
  const onFailed = (request: import('playwright').Request) => {
    if (!RESOURCE_TYPES.has(request.resourceType())) return
    const reason = request.failure()?.errorText ?? 'failed'
    if (/ERR_ABORTED/i.test(reason)) return // cancelled by navigation, not a failure
    add(unavailable, `${request.resourceType()} ${shortUrl(request.url())} (${reason})`)
  }
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  return {
    broken,
    unavailable,
    stop: () => { page.off('response', onResponse); page.off('requestfailed', onFailed) },
  }
}

/**
 * Collect console.error messages (React dev warnings use console.error) until
 * stop(). printf-style messages ("…the same key, `%s`…") get their arguments
 * filled in, so the message names the actual value. Call settle() before
 * reading `messages`.
 */
export function watchConsoleErrors(page: Page): { messages: string[]; settle: () => Promise<void>; stop: () => void } {
  const messages: string[] = []
  const seen = new Set<string>()
  const pending: Array<Promise<void>> = []
  const add = (raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text || CONSOLE_NOISE.some(pattern => pattern.test(text))) return
    const key = text.slice(0, 160)
    if (seen.has(key)) return
    seen.add(key)
    messages.push(text.slice(0, 300))
  }
  // A request cut off by a navigation (the explorer reloading, a link click)
  // makes apps log "Failed to fetch" — caused by leaving the page, not a bug.
  // Network-failure messages are held and dropped when a page navigation or an
  // aborted fetch/XHR happened just around them.
  const interruptions: number[] = []
  const networkFailures: Array<{ text: string; at: number }> = []
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) interruptions.push(Date.now())
  }
  const onRequestFailed = (request: Request) => {
    if (['fetch', 'xhr'].includes(request.resourceType()) && /ERR_ABORTED|aborted|cancel/i.test(request.failure()?.errorText ?? '')) {
      interruptions.push(Date.now())
    }
  }
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (NETWORK_FAILURE.test(text)) { networkFailures.push({ text, at: Date.now() }); return }
    if (!/%[sdifoOc]/.test(text)) return add(text)
    pending.push(formatConsoleMessage(message).then(add, () => add(text)))
  }
  page.on('console', onConsole)
  page.on('request', onRequest)
  page.on('requestfailed', onRequestFailed)
  return {
    messages,
    settle: async () => {
      await Promise.allSettled(pending.splice(0))
      for (const failure of networkFailures.splice(0)) {
        const interrupted = interruptions.some(at => at >= failure.at - INTERRUPTION_BEFORE_MS && at <= failure.at + INTERRUPTION_AFTER_MS)
        if (!interrupted) add(failure.text)
      }
    },
    stop: () => {
      page.off('console', onConsole)
      page.off('request', onRequest)
      page.off('requestfailed', onRequestFailed)
    },
  }
}

/** Console text of a fetch/XHR that failed at the network level (browser- and library-specific wording). */
const NETWORK_FAILURE = /Failed to fetch|NetworkError when attempting to fetch|Load failed|Network Error|AbortError|The (?:user|operation) aborted/i
const INTERRUPTION_BEFORE_MS = 3000
const INTERRUPTION_AFTER_MS = 1000

async function formatConsoleMessage(message: ConsoleMessage): Promise<string> {
  const args = await Promise.all(message.args().map(arg => arg.jsonValue().catch(() => '…')))
  if (typeof args[0] !== 'string') return message.text()
  let next = 1
  const formatted = args[0].replace(/%[sdifoOc]/g, spec => {
    if (spec === '%c') { next++; return '' }
    return next < args.length ? stringify(args[next++]) : spec
  })
  // React appends the component stack as an extra argument; keep the message itself.
  return formatted.split(/\n\s+at |\n\s*in /)[0]
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

// ── Broken values ───────────────────────────────────────────────────────────

/** Values that only appear when rendering went wrong. */
const BROKEN_VALUE_PATTERNS: Array<{ label: string; pattern: RegExp; shortLineOnly: boolean }> = [
  { label: '[object Object]', pattern: /\[object Object\]/, shortLineOnly: false },
  { label: 'Invalid Date', pattern: /\bInvalid Date\b/, shortLineOnly: false },
  { label: 'unrendered template', pattern: /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/, shortLineOnly: false },
  { label: 'NaN', pattern: /(?:^|[:=$€£¥]\s*|\(\s*)NaN\b|\bNaN\s*%|^NaN$/, shortLineOnly: true },
  { label: 'undefined', pattern: /(?:^|[:=$€£¥]\s*)undefined\b|\bundefined\s+undefined\b|^undefined$/, shortLineOnly: true },
  { label: 'null', pattern: /^null$|[:=]\s*null$/, shortLineOnly: true },
]

/** "Label: Unknown" style placeholders — usually a missing lookup, sometimes legitimate. */
const PLACEHOLDER_VALUE = /^[A-Za-z][\w ()/-]{1,40}:\s*(?:Unknown|None|N\/A|n\/a|-|—|\?)\s*$/

const SHORT_LINE = 80

export interface BrokenValues {
  /** Values that are always a rendering bug (e.g. "Total: $NaN", "[object Object]"). */
  broken: string[]
  /** Placeholder values that often mean missing data (e.g. "Category: Unknown"). */
  placeholders: string[]
}

export function findBrokenValues(text: string): BrokenValues {
  const broken = new Set<string>()
  const placeholders = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    for (const { pattern, shortLineOnly } of BROKEN_VALUE_PATTERNS) {
      if (shortLineOnly && line.length > SHORT_LINE) continue
      if (pattern.test(line)) broken.add(line.slice(0, 120))
    }
    if (line.length <= SHORT_LINE && PLACEHOLDER_VALUE.test(line)) placeholders.add(line)
  }
  return { broken: [...broken], placeholders: [...placeholders] }
}

export async function detectBrokenValues(page: Page): Promise<BrokenValues> {
  const text = await visibleText(page)
  return findBrokenValues(text)
}

// ── Empty state and outcome messages ────────────────────────────────────────

const EMPTY_STATE = /\b(?:no|0)\s+(?:\w+\s+)?(?:items?|results?|products?|records?|entries|data|orders?|rows?|files?|messages?|tasks?)\b|\b(?:is|are)\s+empty\b|\bempty\s+(?:cart|list|basket|bag|inbox|table)\b|\bnothing\s+(?:here|to show|yet|found)\b/i
const SUCCESS_TEXT = /\b(?:success(?:ful(?:ly)?)?|completed?|placed|confirmed|thank(?:s| you)|saved|submitted|created|added)\b/i
const FAILURE_TEXT = /\b(?:error|fail(?:ed|ure)?|invalid|unable|cannot|can't|denied|required|empty)\b/i

/** The empty-state line on the page ("No items in the cart."), or undefined. */
export function findEmptyState(text: string): string | undefined {
  return text.split('\n').map(line => line.trim()).find(line => line.length <= 100 && EMPTY_STATE.test(line))
}

/** Lines present in `after` but not in `before` that read as a success message. */
export function newSuccessLines(before: string, after: string): string[] {
  const seen = new Set(before.split('\n').map(line => line.trim()))
  return after.split('\n').map(line => line.trim())
    .filter(line => line && line.length <= 160 && !seen.has(line) && SUCCESS_TEXT.test(line) && !FAILURE_TEXT.test(line))
}

/** Lines present in `after` but not in `before` that read as an error or validation message. */
export function newFailureLines(before: string, after: string): string[] {
  const seen = new Set(before.split('\n').map(line => line.trim()))
  return after.split('\n').map(line => line.trim())
    .filter(line => line && line.length <= 160 && !seen.has(line) && FAILURE_TEXT.test(line))
}

export async function visibleText(page: Page): Promise<string> {
  return await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
}

/** Number of visible form controls and buttons — evidence that a short page rendered. */
export async function countVisibleControls(page: Page): Promise<number> {
  return await page.locator('input:visible, textarea:visible, select:visible, button:visible, [role="button"]:visible')
    .count().catch(() => 0)
}
