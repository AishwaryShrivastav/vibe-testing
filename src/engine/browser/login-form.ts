import type { Locator, Page } from 'playwright'
import { IDENTITY_PATTERNS, PASSWORD_PATTERN, type IdentityKind } from '../../utils/login-fields.js'

/**
 * Locate and fill a login form whatever identifier it asks for — email,
 * username, phone/mobile number, or an ID number (employee, customer, member…).
 *
 * Fields are scored in the page from their autocomplete, type, inputmode,
 * name, id, placeholder, aria-label and label text, using the same patterns as
 * utils/login-fields.ts. When nothing is recognisable (e.g. a label in another
 * language) the text input just before the password field in the same form is
 * used. A configured field name always wins.
 */

export interface LoginFieldHints {
  /** name, id, autocomplete or label of the identity field (e.g. "userName", "phoneNumber"). */
  identityField?: string
  /** name, id or label of the password field. */
  passwordField?: string
}

export interface LocatedLoginFields {
  identity: Locator | null
  password: Locator | null
  identityKind?: IdentityKind | 'positional'
  /** Short human-readable description of the chosen identity field. */
  identityDescription?: string
  /** Descriptions of visible inputs, for error messages when nothing matched. */
  visibleInputs: string[]
}

export interface FillLoginResult {
  identityKind?: IdentityKind | 'positional'
  identityDescription?: string
  /** True when the form showed the password field only after submitting the identifier. */
  multiStep: boolean
}

const IDENTITY_ATTR = 'data-vibe-login-identity'
const PASSWORD_ATTR = 'data-vibe-login-password'

type InPageResult = {
  identityKind?: IdentityKind | 'positional'
  identityDescription?: string
  hasIdentity: boolean
  hasPassword: boolean
  visibleInputs: string[]
}

export async function locateLoginFields(page: Page, hints: LoginFieldHints = {}): Promise<LocatedLoginFields> {
  const config = {
    identityAttr: IDENTITY_ATTR,
    passwordAttr: PASSWORD_ATTR,
    identityHint: hints.identityField?.trim().toLowerCase() || '',
    passwordHint: hints.passwordField?.trim().toLowerCase() || '',
    passwordPattern: PASSWORD_PATTERN.source,
    identityPatterns: IDENTITY_PATTERNS.map(({ kind, pattern }) => ({ kind, source: pattern.source })),
  }
  // A string script avoids helper functions injected by the TS toolchain, which
  // do not exist inside the page.
  const result = await page.evaluate(`(${LOCATE_SCRIPT})(${JSON.stringify(config)})`) as InPageResult
  return {
    identity: result.hasIdentity ? page.locator(`[${IDENTITY_ATTR}="1"]`).first() : null,
    password: result.hasPassword ? page.locator(`[${PASSWORD_ATTR}="1"]`).first() : null,
    identityKind: result.identityKind,
    identityDescription: result.identityDescription,
    visibleInputs: result.visibleInputs,
  }
}

/**
 * Fill identity + password and submit. Supports two-step forms that show the
 * password field only after the identifier is submitted.
 */
export async function fillLoginForm(
  page: Page,
  credentials: { identity: string; password: string },
  hints: LoginFieldHints = {},
  timeoutMs = 3000,
): Promise<FillLoginResult> {
  let fields = await locateLoginFields(page, hints)
  if (!fields.identity) {
    throw new Error(
      'No login identifier field (email, username, phone number or ID) found. ' +
      `Visible inputs: ${fields.visibleInputs.join('; ') || 'none'}. ` +
      'Pass the field name explicitly (identity_field / auth.fields.email).',
    )
  }
  const identityKind = fields.identityKind
  const identityDescription = fields.identityDescription
  await fields.identity.fill(credentials.identity, { timeout: timeoutMs })

  let multiStep = false
  if (!fields.password) {
    // Identifier-first flow: submit the identifier, then look for the password.
    multiStep = true
    await submitLoginForm(page, fields.identity, timeoutMs)
    await page.locator('input[type="password"]:visible').first().waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {})
    fields = await locateLoginFields(page, hints)
    if (!fields.password) {
      throw new Error('No password field appeared after submitting the identifier. Visible inputs: ' +
        (fields.visibleInputs.join('; ') || 'none'))
    }
  }

  await fields.password!.fill(credentials.password, { timeout: timeoutMs })
  await submitLoginForm(page, fields.password!, timeoutMs)
  return { identityKind, identityDescription, multiStep }
}

/**
 * The error a login page shows after a rejected submission, for evidence:
 * a visible alert/error element first, otherwise a body line that reads like
 * a credential error. Undefined when nothing recognisable is shown.
 */
export async function readLoginError(page: Page): Promise<string | undefined> {
  const alert = page.locator('[role="alert"]:visible, .error:visible, .alert:visible, [data-error]:visible, .toast-error:visible').first()
  const alertText = (await alert.innerText({ timeout: 500 }).catch(() => '')).trim()
  if (alertText) return alertText.replace(/\s+/g, ' ').slice(0, 160)
  const body = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  const line = body.split('\n').map(l => l.trim())
    .find(l => /invalid|incorrect|wrong|failed|denied|not (?:found|recognized|recognised)|try again|error/i.test(l) && l.length < 200)
  return line || undefined
}

/** Click the form's submit control, or a recognisable sign-in button, or press Enter in the field. */
export async function submitLoginForm(page: Page, field: Locator, timeoutMs = 3000): Promise<void> {
  const form = field.locator('xpath=ancestor::form[1]')
  const candidates: Locator[] = []
  if (await form.count() > 0) {
    candidates.push(form.locator('button[type="submit"], input[type="submit"], button:not([type])'))
  }
  candidates.push(
    page.locator('button[type="submit"], input[type="submit"]'),
    page.getByRole('button', { name: /^(log ?in|sign ?in|continue|next|submit)$/i }),
  )
  for (const candidate of candidates) {
    const button = candidate.first()
    if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
      await button.click({ timeout: timeoutMs })
      return
    }
  }
  await field.press('Enter', { timeout: timeoutMs })
}

/** Runs inside the page. Must be plain browser JavaScript. */
const LOCATE_SCRIPT = String.raw`function (cfg) {
  var identityPatterns = cfg.identityPatterns.map(function (p) { return { kind: p.kind, re: new RegExp(p.source, 'i') } })
  var passwordRe = new RegExp(cfg.passwordPattern, 'i')
  var skipTypes = ['hidden', 'password', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio',
    'search', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']

  document.querySelectorAll('[' + cfg.identityAttr + '], [' + cfg.passwordAttr + ']').forEach(function (el) {
    el.removeAttribute(cfg.identityAttr)
    el.removeAttribute(cfg.passwordAttr)
  })

  function visible(el) {
    if (el.disabled || el.readOnly) return false
    var style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    var rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  function labelText(el) {
    var parts = []
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].innerText || '')
    var by = el.getAttribute('aria-labelledby')
    if (by) by.split(/\s+/).forEach(function (id) {
      var ref = document.getElementById(id)
      if (ref) parts.push(ref.innerText || '')
    })
    return parts.join(' ')
  }
  function describe(el) {
    var text = [el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'),
      el.getAttribute('aria-label'), labelText(el)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    return (el.getAttribute('type') || el.tagName.toLowerCase()) + (text ? ' "' + text.slice(0, 60) + '"' : '')
  }
  function matchesHint(el, hint) {
    if (!hint) return false
    var values = [el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'),
      el.getAttribute('aria-label'), labelText(el)]
    return values.some(function (v) { return v && v.trim().toLowerCase() === hint })
  }

  var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea')).filter(visible)
  var visibleInputs = inputs.map(describe)

  // Password: configured name > current-password > any visible password input.
  var passwords = inputs.filter(function (el) { return (el.getAttribute('type') || '').toLowerCase() === 'password' })
  var password = passwords.find(function (el) { return matchesHint(el, cfg.passwordHint) }) ||
    passwords.find(function (el) { return (el.getAttribute('autocomplete') || '').toLowerCase() === 'current-password' }) ||
    passwords.find(function (el) { return (el.getAttribute('autocomplete') || '').toLowerCase() !== 'new-password' }) ||
    passwords[0] || null

  var best = null
  inputs.forEach(function (el, index) {
    var type = (el.getAttribute('type') || 'text').toLowerCase()
    if (el.tagName.toLowerCase() === 'textarea' || skipTypes.indexOf(type) !== -1) return
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
    var inputmode = (el.getAttribute('inputmode') || '').toLowerCase()
    var text = [el.getAttribute('name'), el.id, autocomplete, el.getAttribute('placeholder'),
      el.getAttribute('aria-label'), labelText(el)].filter(Boolean).join(' ')
    if (passwordRe.test(text)) return

    var score = 0
    var kind = null
    if (matchesHint(el, cfg.identityHint)) score += 1000
    if (autocomplete === 'username') { score += 100; kind = kind || 'username' }
    if (autocomplete === 'email') { score += 100; kind = kind || 'email' }
    if (/^tel(-national)?$/.test(autocomplete)) { score += 100; kind = kind || 'phone' }
    for (var i = 0; i < identityPatterns.length; i++) {
      if (identityPatterns[i].re.test(text)) { score += 80; kind = kind || identityPatterns[i].kind; break }
    }
    if (type === 'email') { score += 60; kind = kind || 'email' }
    if (type === 'tel') { score += 60; kind = kind || 'phone' }
    if (inputmode === 'email' || inputmode === 'tel') score += 30
    if (password && password.form && el.form === password.form) score += 20
    if (password && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)) score += 10

    if (score > 0 && (!best || score > best.score)) best = { el: el, score: score, kind: kind, index: index }
  })

  // Recognised by attributes/labels (score above the form/position bonuses alone)?
  var identity = best && best.score > 30 ? best : null
  if (!identity && password) {
    // Positional fallback: the text-like input right before the password in the same form.
    var before = inputs.filter(function (el) {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      return el.tagName.toLowerCase() !== 'textarea' && skipTypes.indexOf(type) === -1 &&
        el.form === password.form && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    if (before.length) identity = { el: before[before.length - 1], kind: 'positional' }
  }
  if (!identity && !password && best) identity = best

  if (identity) identity.el.setAttribute(cfg.identityAttr, '1')
  if (password) password.setAttribute(cfg.passwordAttr, '1')
  return {
    hasIdentity: !!identity,
    hasPassword: !!password,
    identityKind: identity ? (identity.kind || 'positional') : undefined,
    identityDescription: identity ? describe(identity.el) : undefined,
    visibleInputs: visibleInputs,
  }
}`
