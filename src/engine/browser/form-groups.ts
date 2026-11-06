import type { Page } from 'playwright'
import { NUMERIC_HINT, type FormInfo } from './boundary-probes.js'

/**
 * Input groups that work like forms without a <form> element: a container
 * with fillable inputs and an Add / Create / Save-style button, wired up by
 * script (common in React/Vue admin screens).
 *
 * Each group is tagged like a form — `data-vibe-form="g<n>"` on the container,
 * `data-vibe-field` on its inputs, `data-vibe-submit` on its button — so the
 * same fill / submit / judge logic applies. Keys start with "g" so they never
 * collide with real forms.
 */
export async function tagInputGroups(page: Page, actionPattern: RegExp): Promise<FormInfo[]> {
  return await page.evaluate(
    `(${GROUP_SCRIPT})(${JSON.stringify(actionPattern.source)}, ${JSON.stringify(NUMERIC_HINT.source)})`,
  ) as FormInfo[]
}

/** Click the group's tagged action button. */
export async function submitGroup(page: Page, groupKey: string): Promise<void> {
  await page.locator(`[data-vibe-submit="${groupKey}"]`).first().click({ timeout: 3000, noWaitAfter: true })
}

export function isInputGroup(key: string): boolean {
  return key.startsWith('g')
}

const GROUP_SCRIPT = String.raw`function (actionSource, numericHintSource) {
  var action = new RegExp(actionSource, 'i')
  var numericHint = new RegExp(numericHintSource, 'i')
  var freeTextTypes = ['', 'text', 'search', 'textarea']
  var fillTypes = freeTextTypes.concat(['email', 'url', 'tel', 'number', 'date'])
  var MAX_LEVELS = 5
  function visible(el) {
    var style = window.getComputedStyle(el)
    var rect = el.getBoundingClientRect()
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
  }
  function typeOf(el) {
    return el.tagName.toLowerCase() === 'textarea' ? 'textarea' : (el.getAttribute('type') || '').toLowerCase()
  }
  function fillable(el) {
    return !el.closest('form') && fillTypes.indexOf(typeOf(el)) !== -1 && !el.disabled && !el.readOnly && visible(el)
  }
  function labelOf(el) {
    var parts = []
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].innerText || '')
    parts.push(el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id || '', el.getAttribute('data-testid') || '')
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  function displayName(el) {
    var label = el.labels && el.labels.length ? (el.labels[0].innerText || '').trim() : ''
    var primary = label || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.getAttribute('data-testid') || ''
    return primary.replace(/\s+/g, ' ').trim().slice(0, 40)
  }
  var result = []
  var used = []
  var buttons = document.querySelectorAll('button, input[type=button], [role=button]')
  Array.prototype.forEach.call(buttons, function (button) {
    if (button.closest('form') || !visible(button) || button.disabled) return
    var text = (button.innerText || button.value || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 30 || !action.test(text)) return
    // The nearest ancestor holding fillable inputs is the group.
    var container = button.parentElement
    var inputs = []
    for (var level = 0; container && container !== document.body && level < MAX_LEVELS; level++) {
      inputs = Array.prototype.filter.call(container.querySelectorAll('input, textarea'), fillable)
      if (inputs.length > 0) break
      container = container.parentElement
    }
    if (!container || container === document.body || inputs.length === 0 || used.indexOf(container) !== -1) return
    // One action button per group: two (e.g. Add + Save) make the intent unclear.
    var actions = Array.prototype.filter.call(container.querySelectorAll('button, input[type=button], [role=button]'), function (b) {
      return visible(b) && action.test((b.innerText || b.value || '').trim())
    })
    if (actions.length !== 1) return
    used.push(container)
    var key = 'g' + result.length
    container.setAttribute('data-vibe-form', key)
    button.setAttribute('data-vibe-submit', key)
    var hasPassword = !!container.querySelector('input[type=password]')
    var fields = []
    inputs.forEach(function (el, fieldIndex) {
      var type = typeOf(el)
      el.setAttribute('data-vibe-field', String(fieldIndex))
      var value = el.value || ''
      var labelText = labelOf(el)
      var numeric = type === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') || '') ||
        /^-?\d+(?:[.,]\d+)?$/.test(value.trim()) || (freeTextTypes.indexOf(type) !== -1 && numericHint.test(labelText))
      fields.push({
        key: String(fieldIndex), type: type, numeric: numeric,
        freeText: !numeric && freeTextTypes.indexOf(type) !== -1,
        value: value, label: displayName(el) || type,
      })
    })
    var heading = container.querySelector('h1,h2,h3,legend')
    var label = [heading ? heading.innerText : '', text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    result.push({
      key: key, label: label, probeable: !hasPassword && fields.length > 0,
      skipReason: hasPassword ? 'group has a password field (sign-in/sign-up)' : undefined,
      fields: fields,
    })
  })
  return result
}`
