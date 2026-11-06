import type { Page, Response } from 'playwright'

/**
 * Server-failure signals that need no assertion: 5xx responses for page loads,
 * form posts and fetch/XHR calls, and crash text rendered on the page (stack
 * traces, "Internal Server Error", framework error screens).
 *
 * Deliberately conservative: 4xx responses are not treated as crashes here
 * (401/403/404 are often the intended outcome).
 */

export interface ServerErrorSignal {
  /** Where the failure was observed (request URL, or the page URL for crash text). */
  url: string
  method?: string
  /** HTTP status, when the signal came from a response. */
  status?: number
  /** Short evidence: response/page text excerpt or the matched crash text. */
  evidence: string
}

/** Text that only appears when a server or app crashed and leaked its error. */
const CRASH_TEXT_PATTERNS: RegExp[] = [
  /\b(?:Reference|Type|Syntax|Range|Eval|URI)Error:\s*[^\n]{1,160}/,
  /\bat\s+[\w.<>$]+\s+\((?:\/|[A-Za-z]:\\|file:|webpack:|node:)[^)]*:\d+:\d+\)/,
  /Traceback \(most recent call last\):/,
  /\bInternal Server Error\b/i,
  /\bUnhandled Runtime Error\b/,
  /Application error: a (?:client|server)-side exception has occurred/,
  /\bException in thread "[^"]+"/,
  /\b(?:Fatal|Parse) error:\s+[^\n]{1,160}\bon line \d+/,
  /We're sorry, but something went wrong/,
]

/** Return the crash text visible on the page, or undefined. */
export async function detectCrashText(page: Page): Promise<string | undefined> {
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
  return matchCrashText(text)
}

export function matchCrashText(text: string): string | undefined {
  const sample = text.slice(0, 20_000)
  for (const pattern of CRASH_TEXT_PATTERNS) {
    const match = sample.match(pattern)
    if (match) return match[0].replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return undefined
}

/** True for responses that signal a server failure we always report. */
export function isServerFailure(response: Response): boolean {
  if (response.status() < 500) return false
  const type = response.request().resourceType()
  return type === 'document' || type === 'xhr' || type === 'fetch'
}

/**
 * Collect server failures on a page until the returned stop() is called.
 * Every occurrence is recorded (so callers can tell that an action caused a
 * new failure even if an earlier one looked the same); use uniqueSignals()
 * when reporting.
 */
export function watchServerErrors(page: Page): { signals: ServerErrorSignal[]; stop: () => void } {
  const signals: ServerErrorSignal[] = []

  const onResponse = (response: Response) => {
    if (!isServerFailure(response)) return
    const signal: ServerErrorSignal = {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      evidence: '',
    }
    signals.push(signal)
    response.text().then(body => {
      signal.evidence = evidenceFromBody(body, signal.status)
    }).catch(() => { signal.evidence = `HTTP ${signal.status}` })
  }

  page.on('response', onResponse)
  return {
    signals,
    stop: () => { page.off('response', onResponse) },
  }
}

/** Short evidence from a failed response's body: crash text if any, else its first words. */
export function evidenceFromBody(body: string, status?: number): string {
  const text = stripTags(body)
  return matchCrashText(text) ?? (text.replace(/\s+/g, ' ').trim().slice(0, 200) || `HTTP ${status ?? ''}`.trim())
}

/** Wait for response bodies still being read by a watcher (bounded). */
export async function settleSignals(signals: ServerErrorSignal[], timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (signals.some(s => s.evidence === '') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One entry per (method, url, status, evidence), in first-seen order. */
export function uniqueSignals(signals: ServerErrorSignal[]): ServerErrorSignal[] {
  const seen = new Set<string>()
  return signals.filter(signal => {
    const key = `${signal.method ?? ''} ${signal.url} ${signal.status ?? ''} ${signal.evidence}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function describeSignal(signal: ServerErrorSignal): string {
  let where = signal.url
  try { where = new URL(signal.url).pathname } catch { /* keep full url */ }
  const head = signal.status ? `Server error ${signal.status} on ${signal.method ?? 'GET'} ${where}` : `Crash text on ${where}`
  return signal.evidence ? `${head}: ${signal.evidence}` : head
}

function splitUrl(url: string): { path: string; query: string } {
  try {
    const parsed = new URL(url)
    return { path: parsed.pathname, query: parsed.search }
  } catch { return { path: url, query: '' } }
}

/**
 * One line per (method, path, status, evidence): the same failure on one path
 * reached through different query strings is a single line with a count and
 * an example query, e.g. "Server error 500 on GET /a (×3, different query
 * strings, e.g. ?q=…): …". Signals that really differ stay separate lines.
 */
export function describeSignalGroups(signals: ServerErrorSignal[]): string[] {
  const groups = new Map<string, { signal: ServerErrorSignal; queries: string[] }>()
  for (const signal of signals) {
    const { path, query } = splitUrl(signal.url)
    const key = `${signal.method ?? ''} ${path} ${signal.status ?? ''} ${signal.evidence}`
    const group = groups.get(key)
    if (group) group.queries.push(query)
    else groups.set(key, { signal, queries: [query] })
  }
  return [...groups.values()].map(({ signal, queries }) => {
    const line = describeSignal(signal)
    if (queries.length < 2) return line
    const distinct = new Set(queries)
    let note = `×${queries.length}`
    if (distinct.size > 1) {
      const example = queries.find(Boolean) ?? ''
      const shown = example.replace(/=[^&]*/g, '=…').slice(0, 60)
      note += `, different query strings${example ? `, e.g. ${shown}` : ''}`
    }
    const colon = line.indexOf(': ')
    const head = colon === -1 ? line : line.slice(0, colon)
    return `${head} (${note})${colon === -1 ? '' : line.slice(colon)}`
  })
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
