import type { Page, Request } from 'playwright'
import { tagForms } from './boundary-probes.js'

/**
 * What exploration may change in the app under test, and a record of what it
 * did change.
 *
 *  - "safe" (default): create new records (add/create forms, "add" buttons,
 *    boundary probes on blank forms) but never overwrite data that is already
 *    there: prefilled values are left as they are, and forms that edit existing
 *    data (settings, profile, branding, prefilled with names/addresses/URLs…)
 *    are not probed or create-checked.
 *  - "all": also overwrite existing values and probe edit forms (the most
 *    coverage; may leave the app with test values in its settings).
 *  - "none": no data-changing submissions — inputs may be typed into, but
 *    submit/save-style buttons, create checks, probes and repeated "add"
 *    actions are skipped.
 *
 * Whatever the policy, every same-origin request that changed data during
 * exploration is recorded (see watchWrites) and reported, so users know what
 * to clean up.
 */
export type WritePolicy = 'safe' | 'all' | 'none'
export const DEFAULT_WRITE_POLICY: WritePolicy = 'safe'

/** A data-changing request made while exploring. */
export interface AppChange {
  /** What the explorer was doing, e.g. 'click "Submit"' or 'create-then-verify'. */
  action: string
  method: string
  path: string
  status?: number
  /** Field values sent (secrets masked, CSRF tokens dropped), when readable. */
  values?: string
}

// ── Edit-existing-data forms ────────────────────────────────────────────────

/** Words that mark a form or page as editing existing settings or account data. */
const EDIT_CONTEXT = /\b(?:settings?|preferences?|profile|account|branding|configuration|config|my details|personal (?:details|info(?:rmation)?)|billing|notifications?|security|password)\b/i
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/
const NUMBER_LIKE = /^[-+]?[\d.,\s%]+$/

/**
 * A value that is existing data rather than an input default: non-empty and
 * not just a number or a date (forms default those — quantity 1, 0 %, today).
 */
export function isExistingValue(value: string | undefined): boolean {
  const text = (value ?? '').trim()
  return text !== '' && !NUMBER_LIKE.test(text) && !DATE_LIKE.test(text)
}

/**
 * Why a form edits existing data (so submitting changed values overwrites it),
 * or undefined. It does when two or more text fields are already filled with
 * existing values, or one is and the form/page reads as settings, profile,
 * account or similar.
 */
export function editsExistingData(fields: Array<{ value?: string }>, context: string): string | undefined {
  const prefilled = fields.filter(field => isExistingValue(field.value)).length
  if (prefilled >= 2) return `${prefilled} fields already hold existing values`
  const word = context.match(EDIT_CONTEXT)?.[0]
  if (prefilled >= 1 && word) return `it edits existing ${word.toLowerCase()} data`
  return undefined
}

/**
 * Why a create check or boundary probe must not submit this form under the
 * policy, or undefined when it may.
 */
export function formSkipReason(policy: WritePolicy, fields: Array<{ value?: string }>, context: string): string | undefined {
  if (policy === 'all') return undefined
  if (policy === 'none') return 'Skipped — explore.writes is "none" (no data-changing submissions)'
  const reason = editsExistingData(fields, context)
  return reason ? `Skipped — form edits existing data (${reason}); set explore.writes to "all" to test it` : undefined
}

/** Headings, title and path of the page: context for editsExistingData. */
export async function pageContext(page: Page): Promise<string> {
  const headings = await page.locator('h1, h2, title').allInnerTexts().catch(() => [] as string[])
  let path = ''
  try { path = new URL(page.url()).pathname.replace(/[/_-]+/g, ' ') } catch { /* keep empty */ }
  return [await page.title().catch(() => ''), path, ...headings].join(' ')
}

// ── Write buttons ───────────────────────────────────────────────────────────

const WRITE_VERB = /\b(?:save|submit|update|apply|confirm|create|add|send|post|publish|upload|book|reserve|checkout|check ?out|order|pay|register|change|set|store|import|delete|remove)\b/i

/** True for a button that submits a form or reads as a data-changing action. */
export async function isWriteButton(page: Page, selector: string, text: string): Promise<boolean> {
  if (WRITE_VERB.test(text)) return true
  if (!selector || selector.startsWith('text=')) return false
  return await page.locator(selector).first().evaluate(el => {
    const button = el as HTMLButtonElement
    return !!button.form && (button.type === 'submit' || el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'submit')
  }, undefined, { timeout: 1000 }).catch(() => false)
}

/** The current value of an input, or undefined when it can't be read. */
export async function currentValue(page: Page, selector: string): Promise<string | undefined> {
  if (!selector || selector.startsWith('text=')) return undefined
  return await page.locator(selector).first().inputValue({ timeout: 1000 }).catch(() => undefined)
}

/**
 * Keys (data-vibe-form) of the forms on the page that edit existing data.
 * Tags the forms as a side effect; call on the freshly loaded page.
 */
export async function editFormKeys(page: Page): Promise<Set<string>> {
  const context = await pageContext(page)
  const forms = await tagForms(page).catch(() => [])
  return new Set(forms.filter(form => editsExistingData(form.fields, `${form.label} ${context}`)).map(form => form.key))
}

/**
 * Why the fill phase must leave this input alone under the policy, or
 * undefined to fill it: it holds an existing value, or it belongs to a form
 * that edits existing data (filling its blank fields and saving would still
 * change that record).
 */
export async function keepInputReason(page: Page, selector: string, policy: WritePolicy, editForms: Set<string>): Promise<string | undefined> {
  if (policy === 'all') return undefined
  // Any value already there — including a stored date or number — is kept.
  if ((await currentValue(page, selector) ?? '').trim() !== '') return `Kept existing value (explore.writes: ${policy})`
  if (editForms.size === 0 || !selector || selector.startsWith('text=')) return undefined
  const formKey = await page.locator(selector).first()
    .evaluate(el => el.closest('[data-vibe-form]')?.getAttribute('data-vibe-form') ?? null, undefined, { timeout: 1000 })
    .catch(() => null)
  return formKey !== null && editForms.has(formKey)
    ? `Left unchanged — its form edits existing data (explore.writes: ${policy})`
    : undefined
}

// ── Recording changes ───────────────────────────────────────────────────────

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Sign-in and session requests change no app data (sign-up does, and stays). */
const SIGN_IN_PATH = /\/(?:log-?in|sign-?in|auth(?:enticate)?|session|token|validate|refresh)(?:\/|$)/i
const SECRET_KEY = /pass|token|secret|otp|pin\b|cvv|card/i
const DROP_KEY = /csrf|xsrf|_token$|authenticity/i

/**
 * Record same-origin data-changing requests (POST/PUT/PATCH/DELETE) caused by
 * exploration. Requests the page makes on its own while loading (e.g. a POST
 * that validates the session) are learned before startTracking() and ignored.
 */
export function watchWrites(page: Page, origin: string) {
  const changes: AppChange[] = []
  const loadRequests = new Set<string>()
  const pending = new Map<Request, AppChange>()
  let tracking = false
  let action = 'page load'

  const keyOf = (request: Request, path: string) => `${request.method()} ${path}`
  const onRequest = (request: Request) => {
    if (READ_METHODS.has(request.method())) return
    let url: URL
    try { url = new URL(request.url()) } catch { return }
    if (url.origin !== origin || SIGN_IN_PATH.test(url.pathname)) return
    const key = keyOf(request, url.pathname)
    if (!tracking) { loadRequests.add(key); return }
    if (loadRequests.has(key)) return
    const change: AppChange = { action, method: request.method(), path: url.pathname, values: describeBody(request) }
    changes.push(change)
    pending.set(request, change)
  }
  const onResponse = (response: Awaited<ReturnType<Request['response']>>) => {
    if (!response) return
    const change = pending.get(response.request())
    if (change) { change.status = response.status(); pending.delete(response.request()) }
  }
  page.on('request', onRequest)
  page.on('response', onResponse)

  return {
    changes,
    /** Call once the page has loaded; earlier writes are the page's own. */
    startTracking: () => { tracking = true },
    setAction: (label: string) => { action = label },
    stop: () => { page.off('request', onRequest); page.off('response', onResponse) },
  }
}

/** "name=Vibe Test User, logoUrl=https://example.com" from a form or JSON body. */
function describeBody(request: Request): string | undefined {
  let body: string | null = null
  try { body = request.postData() } catch { return undefined }
  if (!body) return undefined
  const pairs: Array<[string, string]> = []
  const contentType = request.headers()['content-type'] ?? ''
  try {
    if (contentType.includes('json') || /^\s*[{[]/.test(body)) {
      flatten(JSON.parse(body), '', pairs)
    } else if (contentType.includes('x-www-form-urlencoded') || /^[^=&\s]+=[^&]*(&|$)/.test(body)) {
      for (const [key, value] of new URLSearchParams(body)) pairs.push([key, value])
    }
  } catch { /* unreadable body */ }
  if (pairs.length === 0) return undefined
  // A secret repeated under another name ("verify", "confirm") is masked too.
  const secrets = new Set(pairs.filter(([key, value]) => SECRET_KEY.test(key) && value).map(([, value]) => value))
  const text = pairs
    .filter(([key]) => !DROP_KEY.test(key))
    .map(([key, value]) => `${key}=${SECRET_KEY.test(key) || secrets.has(value) ? '***' : clip(value, 40)}`)
    .join(', ')
  return clip(text, 240) || undefined
}

function flatten(value: unknown, prefix: string, out: Array<[string, string]>) {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      flatten(inner, prefix ? `${prefix}.${key}` : key, out)
    }
  } else if (prefix) {
    out.push([prefix, String(value)])
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One line per change: 'click "Submit": PUT /api/branding (200) — name=…'. */
export function describeChange(change: AppChange): string {
  const status = change.status ? ` (${change.status})` : ''
  return `${change.action}: ${change.method} ${change.path}${status}${change.values ? ` — ${change.values}` : ''}`
}
