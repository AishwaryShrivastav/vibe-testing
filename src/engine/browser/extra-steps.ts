import type { APIResponse, Page } from 'playwright'
import { createRequire } from 'module'
import fs from 'fs/promises'
import type { TestStep } from '../../types/index.js'
import { AssertionFailure, stepLocator } from './assertions.js'

/**
 * Steps for authored test cases: keys, HTTP/JSON checks, layout, motion and
 * accessibility. Check steps throw AssertionFailure (the scenario fails);
 * misuse (missing fields) throws a plain Error (the scenario errors).
 */

export interface StoredResponse {
  method: string
  url: string
  status: number
  headers: Record<string, string>
  text: string
  /** Parsed JSON body (an event-stream's last data line counts), or undefined. */
  json?: unknown
}

const lastResponses = new WeakMap<Page, StoredResponse>()
const pageHeaders = new WeakMap<Page, Record<string, string>>()

export function lastResponse(page: Page): StoredResponse | undefined {
  return lastResponses.get(page)
}

const fail = (message: string): never => { throw new AssertionFailure(`Assertion failed: ${message}`) }

/** Runs one of the extra actions; returns the selector used, if any. */
export async function executeExtraStep(page: Page, step: TestStep, baseUrl: string, timeout: number): Promise<string | undefined> {
  switch (step.action) {
    case 'press': {
      if (!step.value) throw new Error('press needs a key in value, e.g. Enter or Tab')
      if (step.selector) {
        await stepLocator(page, step.selector).first().press(step.value, { timeout })
        return step.selector
      }
      await page.keyboard.press(step.value)
      return undefined
    }
    case 'header': {
      if (!step.selector || step.value === undefined) throw new Error('header needs a name (selector) and a value')
      pageHeaders.set(page, { ...pageHeaders.get(page), [step.selector]: step.value })
      return undefined
    }
    case 'request':
      await runRequest(page, step, baseUrl, timeout)
      return undefined
    case 'expect_status':
      expectStatus(page, step)
      return undefined
    case 'expect_json':
      expectJson(page, step)
      return undefined
    case 'eval':
      await expectEval(page, step)
      return undefined
    case 'in_viewport':
      await expectInViewport(page, step, timeout)
      return step.selector
    case 'no_horizontal_scroll':
      await expectNoHorizontalScroll(page)
      return undefined
    case 'still':
      await expectStill(page, step)
      return undefined
    case 'a11y':
      await expectAccessible(page, step)
      return step.selector
    default:
      throw new Error(`Unsupported step action: ${String(step.action)}`)
  }
}

export function isExtraAction(action: string): boolean {
  return ['press', 'header', 'request', 'expect_status', 'expect_json', 'eval', 'in_viewport', 'no_horizontal_scroll', 'still', 'a11y'].includes(action)
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function runRequest(page: Page, step: TestStep, baseUrl: string, timeout: number): Promise<void> {
  if (!step.url) throw new Error('request needs a url')
  const method = (step.method ?? 'GET').toUpperCase()
  const url = /^[a-z]+:\/\//i.test(step.url) ? step.url : new URL(step.url, baseUrl).href
  const headers: Record<string, string> = { ...pageHeaders.get(page), ...step.headers }
  let data: string | undefined
  if (step.body !== undefined && step.body !== null && step.body !== '') {
    data = typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = looksLikeJson(data) ? 'application/json' : 'text/plain'
    }
  }
  // MCP streamable HTTP servers want both; harmless elsewhere.
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'accept')) headers.accept = 'application/json, text/event-stream, */*'
  let response: APIResponse
  try {
    response = await page.request.fetch(url, {
      method, headers, data, timeout,
      failOnStatusCode: false,
      ...(step.max_redirects !== undefined ? { maxRedirects: step.max_redirects } : {}),
    })
  } catch (err) {
    throw new Error(`request ${method} ${url} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
  const text = await response.text().catch(() => '')
  lastResponses.set(page, {
    method, url, status: response.status(), headers: response.headers(), text, json: parseBody(text, response.headers()['content-type'] ?? ''),
  })
}

function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

/** JSON body, or the last JSON `data:` line of an event stream (MCP over streamable HTTP). */
export function parseBody(text: string, contentType: string): unknown {
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }
  if (/event-stream/i.test(contentType) || /^(event|data):/m.test(text)) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
    for (let i = data.length - 1; i >= 0; i--) {
      const parsed = tryParse(data[i])
      if (parsed !== undefined) return parsed
    }
  }
  return tryParse(text)
}

function needResponse(page: Page, action: string): StoredResponse {
  const response = lastResponses.get(page)
  if (!response) throw new Error(`${action} needs an earlier request step`)
  return response
}

/** "200", "2xx", "4xx", "400|403", "!500". */
export function statusMatches(status: number, spec: string): boolean {
  return spec.split('|').map(s => s.trim()).filter(Boolean).some(part => {
    if (part.startsWith('!')) return !statusMatches(status, part.slice(1))
    if (/^\dxx$/i.test(part)) return Math.floor(status / 100) === Number(part[0])
    return Number(part) === status
  })
}

function expectStatus(page: Page, step: TestStep): void {
  if (!step.value) throw new Error('expect_status needs a value such as 200, 2xx or 400|403')
  const response = needResponse(page, 'expect_status')
  if (!statusMatches(response.status, step.value)) {
    fail(`${response.method} ${shortUrl(response.url)} returned ${response.status}, expected ${step.value}; body ${JSON.stringify(response.text.slice(0, 200))}`)
  }
}

/** " on /path" for page-check failures, so a multi-page case says which page broke. */
function onPage(page: Page): string {
  const url = page.url()
  if (!url || url === 'about:blank') return ''
  try { const u = new URL(url); return ` on ${u.protocol === 'file:' ? u.pathname.split('/').pop() + u.search : u.pathname + u.search}` } catch { return ` on ${url}` }
}

function shortUrl(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search } catch { return url }
}

// ─── JSON paths ──────────────────────────────────────────────────────────────

const MISSING = Symbol('missing')

/** Values at a path such as `a.b[0].c`, `items[*].id` or `$` (the whole body). Missing parts give MISSING. */
export function resolvePath(root: unknown, path: string): unknown[] {
  const tokens: Array<string | number | '*'> = []
  const clean = path.trim().replace(/^\$\.?/, '')
  for (const part of clean.match(/[^.[\]]+|\[(\*|\d+|"[^"]*"|'[^']*')\]/g) ?? []) {
    if (part.startsWith('[')) {
      const inner = part.slice(1, -1)
      tokens.push(inner === '*' ? '*' : /^\d+$/.test(inner) ? Number(inner) : inner.slice(1, -1))
    } else tokens.push(part)
  }
  let values: unknown[] = [root]
  for (const token of tokens) {
    const next: unknown[] = []
    for (const value of values) {
      if (token === '*') {
        if (Array.isArray(value)) next.push(...value)
        else if (value && typeof value === 'object') next.push(...Object.values(value))
        else next.push(MISSING)
      } else if (value !== null && typeof value === 'object' && (token as string | number) in (value as object)) {
        next.push((value as Record<string | number, unknown>)[token as string | number])
      } else next.push(MISSING)
    }
    values = next
  }
  return values
}

function expected(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return raw }
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    // "200" matches 200, "true" matches true.
    return a === b || (a !== MISSING && String(a) === String(b))
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Checks one value; returns a reason when it does not match. */
export function checkValue(value: unknown, op: NonNullable<TestStep['op']>, raw: string | undefined): string | undefined {
  const want = expected(raw)
  const shown = value === MISSING ? 'missing' : JSON.stringify(value)?.slice(0, 120)
  switch (op) {
    // exists / absent are about the key: a present key holding null exists (use `!= null` to require a value).
    case 'exists': return value === MISSING ? 'is missing' : undefined
    case 'absent': return value === MISSING ? undefined : `is ${shown}, expected absent`
    case 'equals': return same(value, want) ? undefined : `is ${shown}, expected ${JSON.stringify(want)}`
    case 'not_equals': return same(value, want) ? `is ${shown}, expected anything else` : undefined
    case 'contains': {
      // An array contains an equal item, a string item holding the text, or an object item with a field equal to the value
      // (so `json result.tools contains brain_read` finds the tool named brain_read).
      if (Array.isArray(value)) return value.some(item => same(item, want)
        || (typeof item === 'string' && typeof want === 'string' && item.includes(want))
        || (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some(field => same(field, want))))
        ? undefined : `${shown} has no ${JSON.stringify(want)}`
      if (typeof value === 'string') return value.includes(String(raw)) ? undefined : `${shown} does not contain ${JSON.stringify(raw)}`
      if (value && typeof value === 'object') return JSON.stringify(value).includes(String(raw)) ? undefined : `${shown} does not contain ${JSON.stringify(raw)}`
      return `is ${shown}, cannot contain ${JSON.stringify(raw)}`
    }
    case 'length': {
      const length = Array.isArray(value) || typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.keys(value).length : undefined
      if (length === undefined) return `is ${shown}, which has no length`
      const spec = String(raw ?? '').trim()
      const m = spec.match(/^(>=|<=|>|<|=)?\s*(\d+)$/)
      if (!m) throw new Error(`length needs a number such as 3, >=1 or <=5 (got ${spec})`)
      const n = Number(m[2])
      const ok = m[1] === '>=' ? length >= n : m[1] === '<=' ? length <= n : m[1] === '>' ? length > n : m[1] === '<' ? length < n : length === n
      return ok ? undefined : `has length ${length}, expected ${spec}`
    }
    case 'matches': return typeof value === 'string' && new RegExp(String(raw)).test(value) ? undefined : `${shown} does not match /${raw}/`
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(value), b = Number(want)
      if (value === MISSING || Number.isNaN(a) || Number.isNaN(b)) return `is ${shown}, not comparable with ${raw}`
      const ok = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
      return ok ? undefined : `is ${a}, expected ${op} ${b}`
    }
  }
}

function expectJson(page: Page, step: TestStep): void {
  const response = needResponse(page, 'expect_json')
  if (response.json === undefined) fail(`${shortUrl(response.url)} did not return JSON (status ${response.status}): ${JSON.stringify(response.text.slice(0, 160))}`)
  const path = step.path ?? '$'
  const op = step.op ?? (step.value === undefined ? 'exists' : 'equals')
  const values = resolvePath(response.json, path)
  const wildcard = path.includes('[*]')
  if (wildcard && values.length === 0 && op !== 'absent') fail(`${path} matched no items`)
  for (let i = 0; i < values.length; i++) {
    const reason = checkValue(values[i], op, step.value)
    if (reason) fail(`${path}${wildcard ? ` (item ${i + 1} of ${values.length})` : ''} ${reason}`)
  }
}

// ─── Page checks ─────────────────────────────────────────────────────────────

async function expectEval(page: Page, step: TestStep): Promise<void> {
  if (!step.value?.trim()) throw new Error('eval needs a JavaScript expression in value')
  let result: unknown
  try {
    result = await page.evaluate(`(async () => (${step.value}))()`)
  } catch (err) {
    fail(`${step.value} threw${onPage(page)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
  if (!result) fail(`${step.value} returned ${JSON.stringify(result)}${onPage(page)}`)
}

async function expectInViewport(page: Page, step: TestStep, timeout: number): Promise<void> {
  if (!step.selector) throw new Error('in_viewport needs a selector')
  const target = stepLocator(page, step.selector).first()
  try {
    await target.waitFor({ state: 'visible', timeout })
  } catch {
    fail(`${step.selector} is not visible${onPage(page)}`)
  }
  const box = await target.evaluate((el: Element) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight, sy: window.scrollY }
  })
  const off: string[] = []
  if (box.top < 0) off.push(`top ${Math.round(box.top)} above the fold`)
  if (box.bottom > box.vh + 0.5) off.push(`bottom at ${Math.round(box.bottom)} of ${box.vh}`)
  if (box.left < 0) off.push(`left ${Math.round(box.left)}`)
  if (box.right > box.vw + 0.5) off.push(`right at ${Math.round(box.right)} of ${box.vw}`)
  if (box.sy > 0) off.push(`page scrolled to ${Math.round(box.sy)}`)
  if (off.length) fail(`${step.selector} is not fully in the ${box.vw}x${box.vh} viewport${onPage(page)}: ${off.join(', ')}`)
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({
    scroll: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    client: document.documentElement.clientWidth,
  }))
  if (size.scroll > size.client + 1) fail(`page scrolls sideways${onPage(page)}: content ${size.scroll}px wide in a ${size.client}px viewport`)
}

/** Waits until no animation is running; fails with what still moves after the timeout (default 6s). */
async function expectStill(page: Page, step: TestStep): Promise<void> {
  const timeout = step.timeout ?? 6000
  const deadline = Date.now() + timeout
  let moving: string[] = []
  while (true) {
    moving = await page.evaluate((ignore: string | null) => {
      const describe = (el: Element | null | undefined) => {
        if (!el) return 'document'
        const id = el.id ? `#${el.id}` : ''
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
        return `${el.tagName.toLowerCase()}${id}${cls}`
      }
      return document.getAnimations()
        .filter(a => a.playState === 'running')
        .map(a => (a.effect as KeyframeEffect | null)?.target ?? null)
        .filter(target => !(ignore && target && (target.matches(ignore) || target.closest(ignore))))
        .map(target => describe(target))
    }, step.ignore ?? null)
    if (moving.length === 0) return
    if (Date.now() >= deadline) break
    await page.waitForTimeout(100)
  }
  fail(`${moving.length} animation(s) still running after ${timeout}ms${onPage(page)}: ${[...new Set(moving)].slice(0, 5).join(', ')}`)
}

// ─── Accessibility (axe-core) ────────────────────────────────────────────────

const IMPACTS = ['minor', 'moderate', 'serious', 'critical']
let axeSource: string | undefined

async function loadAxe(): Promise<string> {
  if (axeSource) return axeSource
  const require = createRequire(import.meta.url)
  axeSource = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8')
  return axeSource
}

interface AxeViolation { id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[] }> }

async function expectAccessible(page: Page, step: TestStep): Promise<void> {
  const threshold = (step.value ?? 'serious').toLowerCase()
  const min = IMPACTS.indexOf(threshold)
  if (min < 0) throw new Error(`a11y impact must be one of ${IMPACTS.join(', ')}`)
  const has = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== 'undefined')
  // evaluate, not a script tag: page CSP must not block the scan.
  if (!has) await page.evaluate(await loadAxe())
  const skip = (step.ignore ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const violations = await page.evaluate(async ({ scope, skip }) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> } }).axe
    const rules = Object.fromEntries(skip.map(id => [id, { enabled: false }]))
    const result = await axe.run(scope ?? document, { resultTypes: ['violations'], rules })
    return result.violations
  }, { scope: step.selector ?? null, skip }) as AxeViolation[]
  const failing = violations.filter(v => IMPACTS.indexOf(v.impact ?? 'minor') >= min)
  if (failing.length > 0) {
    const lines = failing.slice(0, 6).map(v => `${v.id} (${v.impact}, ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'}: ${v.nodes.slice(0, 2).map(n => n.target.join(' ')).join('; ')})`)
    fail(`${failing.length} accessibility violation(s) at ${threshold} or worse${onPage(page)}: ${lines.join(' | ')}`)
  }
}
