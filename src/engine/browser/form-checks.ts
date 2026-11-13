import type { Page } from 'playwright'
import { waitForSettled } from './settle.js'
import type { ActionBlocklist } from '../../utils/blocklist.js'
import { fillerValue, submit, tagForms, type FormInfo } from './boundary-probes.js'
import type { InteractionOutcome } from './explorer.js'
import { newFailureLines, newSuccessLines, visibleText } from './page-checks.js'
import { isInputGroup, submitGroup, tagInputGroups } from './form-groups.js'

/**
 * Create-then-verify: submit "add / create / save" forms with a unique marker
 * value and check the app shows what was just created.
 *
 * Flags only the clear failure pattern: the form accepted the submission (its
 * field was cleared), stayed on the same page, showed no success or error
 * message, and the marker is nowhere on the page — e.g. a list that does not
 * refresh after adding an item. Redirects, messages and forms that keep their
 * values are not judged.
 */

const CREATE_FORM = /\b(?:add|create|save|new|post|submit|send|publish)\b/i
const NOT_CREATE_FORM = /\b(?:search|filter|find|log ?in|sign ?in|sign ?up|register|subscribe|newsletter)\b/i
const MAX_FORMS = 2

/** Returns why a form must not be submitted (write policy), or undefined. */
export type FormGate = (form: FormInfo) => Promise<string | undefined>

export async function verifyCreatedValues(
  page: Page,
  pageUrl: string,
  blocklist?: ActionBlocklist,
  gate?: FormGate,
): Promise<InteractionOutcome[]> {
  const outcomes: InteractionOutcome[] = []
  if (!await reload(page, pageUrl)) return outcomes

  const candidates = (await tagFormsAndGroups(page)).filter(form =>
    form.probeable &&
    CREATE_FORM.test(form.label) && !NOT_CREATE_FORM.test(form.label) &&
    form.fields.some(field => field.freeText) &&
    !blocklist?.isBlocked(`form ${form.label}`, form.label),
  ).slice(0, MAX_FORMS)

  for (const form of candidates) {
    const skip = await gate?.(form)
    if (skip) {
      outcomes.push({ element: `form ${form.label}`, elementType: 'form', action: 'create-then-verify', result: 'skipped', details: skip, duration_ms: 0 })
      continue
    }
    outcomes.push(await checkForm(page, pageUrl, form))
  }
  return outcomes
}

async function checkForm(page: Page, pageUrl: string, form: FormInfo): Promise<InteractionOutcome> {
  const start = Date.now()
  const result = (outcome: InteractionOutcome['result'], details: string): InteractionOutcome => ({
    element: `form ${form.label}`, elementType: 'form', action: 'create-then-verify', result: outcome, details,
    duration_ms: Date.now() - start,
  })

  if (!await reload(page, pageUrl)) return result('skipped', 'Could not reload the page')
  await tagFormsAndGroups(page)

  const target = form.fields.find(field => field.freeText)!
  const marker = `vibe-${Math.random().toString(36).slice(2, 8)}`
  const field = (key: string) => page.locator(`[data-vibe-form="${form.key}"] [data-vibe-field="${key}"]`).first()

  try {
    await field(target.key).fill(marker, { timeout: 3000 })
    for (const other of form.fields) {
      if (other.key === target.key) continue
      const filler = fillerValue(other)
      if (filler !== undefined) await field(other.key).fill(filler, { timeout: 3000 }).catch(() => {})
    }
  } catch (error) {
    return result('skipped', `Could not fill the form: ${(error as Error).message.slice(0, 100)}`)
  }

  const before = await visibleText(page)
  const urlBefore = page.url()
  try {
    if (isInputGroup(form.key)) await submitGroup(page, form.key)
    else await submit(page, form.key)
  } catch (error) {
    return result('error', `Submit failed: ${(error as Error).message.slice(0, 100)}`)
  }
  await waitForSettled(page, { capMs: 4000 })
  await page.waitForTimeout(400)

  const after = await visibleText(page)
  const label = target.label
  if (after.includes(marker)) return result('success', `Created value "${marker}" (${label}) is shown after submitting`)

  if (page.url() !== urlBefore) {
    return result('no_change', `Navigated to ${new URL(page.url()).pathname} after submitting; created value not on that page (not judged)`)
  }
  const failures = newFailureLines(before, after)
  if (failures.length > 0) return result('no_change', `Submission rejected: "${failures[0]}"`)
  const successes = newSuccessLines(before, after)
  if (successes.length > 0) return result('success', `Submission confirmed: "${successes[0]}"`)

  const valueAfter = await field(target.key).inputValue({ timeout: 1000 }).catch(() => undefined)
  if (valueAfter === '') {
    return result('error',
      `Submitted value not shown: the form accepted "${marker}" in ${label} (field cleared, no message) but the page does not show it`)
  }
  return result('no_change', 'Not judged: the form kept its values and showed no message')
}

/** Real <form>s plus input groups with an Add/Create/Save button and no <form> around them. */
async function tagFormsAndGroups(page: Page): Promise<FormInfo[]> {
  return [...await tagForms(page), ...await tagInputGroups(page, CREATE_FORM)]
}

async function reload(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await waitForSettled(page, { capMs: 4000 })
    return true
  } catch {
    return false
  }
}
