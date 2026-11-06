import type { Page, Request } from 'playwright'
import type { ActionBlocklist } from '../../utils/blocklist.js'
import { describeSignal, detectCrashText, settleSignals, type ServerErrorSignal } from './error-signals.js'
import type { InteractionOutcome } from './explorer.js'

/**
 * Boundary-input probes (G9): submit each form with malformed values and
 * report what the server did — crashed (5xx / crash text), hung, rejected the
 * input client-side, or handled it.
 *
 * Probes, each a separate submission of a freshly loaded form:
 *  - non-numeric: "abc" in fields that look numeric (type=text but numeric
 *    value, inputmode, or a name/label like amount, qty, percent, routing…)
 *  - long-input: 1000 characters in free-text fields, a 20-digit number in
 *    numeric-looking ones
 *  - special-chars: quotes, angle brackets, percent, semicolon and SQL comment
 *
 * Forms with a password field (sign-in, sign-up, password change) and forms
 * matching the action blocklist or destructive wording are never probed.
 */

export const PROBE_HANG_MS = 10_000
const MAX_FORMS_PER_PAGE = 2
const NOTHING_SENT_MS = 1500

const SPECIAL_CHARS = `O'Brien "quoted" <b>tag</b> 100% ; -- \\ {{7*7}}`
const LONG_TEXT = 'A'.repeat(1000)
const LARGE_NUMBER = '9'.repeat(20)

const NUMERIC_HINT = /amount|qty|quantity|price|cost|percent|pct|\bage\b|count|total|rate|tax|salary|income|zip|postal|routing|acc(?:oun)?t.?(?:no|num)|number|\byear|month|\bday|score|weight|height|days|hours|minutes|limit|balance|deposit|contribution|pretax|roth|quota/i

export interface FieldInfo {
  key: string
  type: string
  numeric: boolean
  freeText: boolean
  value: string
  label: string
}

export interface FormInfo {
  key: string
  label: string
  probeable: boolean
  skipReason?: string
  fields: FieldInfo[]
}

type ProbeKind = 'non-numeric' | 'long-input' | 'special-chars'

export async function probeForms(
  page: Page,
  pageUrl: string,
  serverSignals: ServerErrorSignal[],
  blocklist?: ActionBlocklist,
): Promise<InteractionOutcome[]> {
  const outcomes: InteractionOutcome[] = []
  if (!await reload(page, pageUrl)) return outcomes

  const forms = await tagForms(page)
  let probed = 0
  for (const form of forms) {
    if (probed >= MAX_FORMS_PER_PAGE) break
    const blocked = blocklist?.isBlocked(`form ${form.label}`, form.label) || DESTRUCTIVE.test(form.label)
    if (!form.probeable || blocked) {
      outcomes.push(outcome(form, 'boundary', 'skipped', blocked ? 'Skipped — blocked or destructive form' : `Skipped — ${form.skipReason}`, 0))
      continue
    }
    probed++

    for (const kind of probeKinds(form)) {
      const result = await runProbe(page, pageUrl, form, kind, serverSignals)
      outcomes.push(result)
      // A hung server would make every later probe hang too.
      if (result.details.startsWith('No response')) return outcomes
    }
  }
  return outcomes
}

const DESTRUCTIVE = /\b(delete|remove|destroy|cancel.?account|deactivate|revoke|terminate|unsubscribe|log.?out|sign.?out|pay|purchase|checkout|transfer)\b/i

function probeKinds(form: FormInfo): ProbeKind[] {
  const kinds: ProbeKind[] = []
  if (form.fields.some(f => f.numeric && f.type !== 'number')) kinds.push('non-numeric')
  if (form.fields.some(f => f.freeText || f.numeric)) kinds.push('long-input')
  if (form.fields.some(f => f.freeText || (f.numeric && f.type !== 'number'))) kinds.push('special-chars')
  return kinds
}

function probeValue(kind: ProbeKind, field: FieldInfo): string | undefined {
  switch (kind) {
    case 'non-numeric':
      return field.numeric && field.type !== 'number' ? 'abc' : undefined
    case 'long-input':
      if (field.numeric) return LARGE_NUMBER
      return field.freeText ? LONG_TEXT : undefined
    case 'special-chars':
      return field.freeText || (field.numeric && field.type !== 'number') ? SPECIAL_CHARS : undefined
  }
}

/** A valid value for fields a probe does not target, so required fields don't block submission. */
export function fillerValue(field: FieldInfo): string | undefined {
  if (field.value) return undefined
  if (field.type === 'email') return 'vibe-test@example.com'
  if (field.type === 'url') return 'https://example.com'
  if (field.type === 'tel') return '+15550001234'
  if (field.type === 'number' || field.numeric) return '1'
  if (field.type === 'date') return '2025-06-15'
  return 'vibe test'
}

async function runProbe(
  page: Page,
  pageUrl: string,
  form: FormInfo,
  kind: ProbeKind,
  serverSignals: ServerErrorSignal[],
): Promise<InteractionOutcome> {
  const start = Date.now()
  if (!await reload(page, pageUrl)) {
    return outcome(form, kind, 'error', 'Could not reload the page before probing', Date.now() - start)
  }
  await tagForms(page)

  const targeted: string[] = []
  try {
    for (const field of form.fields) {
      const locator = page.locator(`[data-vibe-form="${form.key}"] [data-vibe-field="${field.key}"]`).first()
      const value = probeValue(kind, field)
      if (value !== undefined) {
        await locator.fill(value, { timeout: 3000 })
        targeted.push(field.label)
      } else {
        const filler = fillerValue(field)
        if (filler !== undefined) await locator.fill(filler, { timeout: 3000 }).catch(() => {})
      }
    }
  } catch (err) {
    return outcome(form, kind, 'skipped', `Could not fill the form: ${(err as Error).message.slice(0, 100)}`, Date.now() - start)
  }

  const crashBefore = await detectCrashText(page)
  const signalsBefore = serverSignals.length
  const started: Request[] = []
  const done = new Set<Request>()
  const onRequest = (request: Request) => {
    if (['document', 'xhr', 'fetch'].includes(request.resourceType())) started.push(request)
  }
  const onDone = (request: Request) => { done.add(request) }
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)

  let hung = false
  try {
    const submittedAt = Date.now()
    await submit(page, form.key)
    const deadline = submittedAt + PROBE_HANG_MS
    while (Date.now() < deadline) {
      await page.waitForTimeout(100)
      if (started.length === 0 && Date.now() - submittedAt > NOTHING_SENT_MS) break
      if (started.length > 0 && started.every(request => done.has(request))) break
    }
    hung = started.some(request => !done.has(request))
    if (!hung) await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {})
  } catch (err) {
    return outcome(form, kind, 'error', `Submit failed: ${(err as Error).message.slice(0, 100)}`, Date.now() - start)
  } finally {
    page.off('request', onRequest)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)
  }

  const fields = targeted.join(', ')
  if (hung) {
    return outcome(form, kind, 'error',
      `No response within ${PROBE_HANG_MS / 1000}s after submitting ${kind} input in ${fields} (possible hang or ReDoS)`, Date.now() - start)
  }
  if (serverSignals.length > signalsBefore) {
    await settleSignals(serverSignals)
    return outcome(form, kind, 'error', `${describeSignal(serverSignals[signalsBefore])} (${kind} input in ${fields})`, Date.now() - start)
  }
  const crashAfter = await detectCrashText(page)
  if (crashAfter && crashAfter !== crashBefore) {
    return outcome(form, kind, 'error', `Crash text after ${kind} input in ${fields}: ${crashAfter}`, Date.now() - start)
  }
  if (started.length === 0) {
    return outcome(form, kind, 'no_change', `Not submitted — blocked client-side (${kind} input in ${fields})`, Date.now() - start)
  }
  return outcome(form, kind, 'success', `Handled ${kind} input in ${fields} without a server error`, Date.now() - start)
}

function outcome(
  form: FormInfo,
  kind: ProbeKind | 'boundary',
  result: InteractionOutcome['result'],
  details: string,
  duration: number,
): InteractionOutcome {
  return {
    element: `form ${form.label}`,
    elementType: 'form',
    action: kind === 'boundary' ? 'boundary probe' : `boundary: ${kind}`,
    result,
    details,
    duration_ms: duration,
  }
}

async function reload(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    // Single-page apps render their forms after the document has loaded.
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {})
    return true
  } catch {
    return false
  }
}

export async function submit(page: Page, formKey: string): Promise<void> {
  const form = page.locator(`[data-vibe-form="${formKey}"]`).first()
  const button = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first()
  if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
    await button.click({ timeout: 3000, noWaitAfter: true })
    return
  }
  await page.evaluate(`(() => {
    const form = document.querySelector('[data-vibe-form="${formKey}"]')
    if (form && form.requestSubmit) form.requestSubmit(); else if (form) form.submit()
  })()`)
}

/** Tag visible forms and their fillable fields; return what can be probed. */
export async function tagForms(page: Page): Promise<FormInfo[]> {
  return await page.evaluate(`(${TAG_SCRIPT})(${JSON.stringify(NUMERIC_HINT.source)})`) as FormInfo[]
}

const TAG_SCRIPT = String.raw`function (numericHintSource) {
  var numericHint = new RegExp(numericHintSource, 'i')
  var freeTextTypes = ['', 'text', 'search', 'textarea']
  var fillTypes = freeTextTypes.concat(['email', 'url', 'tel', 'number', 'date'])
  function visible(el) {
    var style = window.getComputedStyle(el)
    var rect = el.getBoundingClientRect()
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
  }
  function labelOf(el) {
    var parts = []
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].innerText || '')
    parts.push(el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id || '')
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  // One readable name for messages: the visible label (or aria-label /
  // placeholder), plus the field's name attribute when it differs.
  function displayName(el) {
    var label = el.labels && el.labels.length ? (el.labels[0].innerText || '').trim() : ''
    var primary = label || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || ''
    var name = el.getAttribute('name') || ''
    primary = primary.replace(/\s+/g, ' ').trim().slice(0, 40)
    return name && name !== primary ? primary + ' [' + name + ']' : primary
  }
  var result = []
  Array.prototype.forEach.call(document.forms, function (form, formIndex) {
    if (!visible(form)) return
    form.setAttribute('data-vibe-form', String(formIndex))
    var submitText = Array.prototype.map.call(
      form.querySelectorAll('button, input[type=submit]'),
      function (b) { return (b.innerText || b.value || '').trim() }
    ).join(' ')
    var heading = form.querySelector('h1,h2,h3,legend')
    var label = [form.getAttribute('action') || '', form.id || '', heading ? heading.innerText : '', submitText]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80) || ('#' + formIndex)
    var hasPassword = !!form.querySelector('input[type=password]')
    var fields = []
    Array.prototype.forEach.call(form.querySelectorAll('input, textarea'), function (el, fieldIndex) {
      var type = el.tagName.toLowerCase() === 'textarea' ? 'textarea' : (el.getAttribute('type') || '').toLowerCase()
      if (fillTypes.indexOf(type) === -1 || el.disabled || el.readOnly || !visible(el)) return
      el.setAttribute('data-vibe-field', String(fieldIndex))
      var text = labelOf(el)
      var value = el.value || ''
      var numeric = type === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') || '') ||
        /^-?\d+(?:[.,]\d+)?$/.test(value.trim()) || (freeTextTypes.indexOf(type) !== -1 && numericHint.test(text))
      fields.push({
        key: String(fieldIndex), type: type, numeric: numeric,
        freeText: !numeric && freeTextTypes.indexOf(type) !== -1,
        value: value, label: displayName(el) || type,
      })
    })
    var probeable = !hasPassword && fields.length > 0
    result.push({
      key: String(formIndex), label: label, probeable: probeable,
      skipReason: hasPassword ? 'form has a password field (sign-in/sign-up)' : (fields.length === 0 ? 'no fillable fields' : undefined),
      fields: fields,
    })
  })
  return result
}`
