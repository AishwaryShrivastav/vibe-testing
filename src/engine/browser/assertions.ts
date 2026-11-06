import type { Locator, Page } from 'playwright'
import type { TestStep } from '../../types/index.js'

export class AssertionFailure extends Error {}

/** Minimum time given to each text read, so a failure can always report what the page showed. */
const MIN_READ_MS = 1000

/**
 * The part of the page text worth showing in a failure: the visible error or
 * message lines first, trimmed to a readable length. Keeps the start of the
 * text, plus any lines that share a word with the expected value (e.g. the
 * page said "Invalid username" while "Invalid username and/or password" was
 * expected), so the evidence is not cut off by navigation chrome.
 */
export function excerpt(text: string, expected: string, max = 300): string {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (clean.length <= max) return clean
  const words = expected.toLowerCase().split(/\W+/).filter(word => word.length > 3)
  const related = clean.split('\n').filter(line => words.some(word => line.toLowerCase().includes(word)))
  const head = clean.slice(0, Math.floor(max / 2))
  const extra = related.join(' | ').slice(0, max - head.length - 5)
  return extra ? `${head} … ${extra}` : clean.slice(0, max)
}

/** Explicit targets must not fall back to unrelated elements inferred from prose. */
export function stepLocator(page: Page, selector: string): Locator {
  if (selector.startsWith('label=')) return page.getByLabel(selector.slice(6), { exact: true })
  if (selector.startsWith('placeholder=')) return page.getByPlaceholder(selector.slice(12), { exact: true })
  if (selector.startsWith('text=')) return page.getByText(selector.slice(5), { exact: true })
  return page.locator(selector)
}

export function hasExplicitAssertion(step: TestStep): boolean {
  return step.action === 'assert' && (step.selector !== undefined || step.value !== undefined || step.url !== undefined)
}

/** Explicit assertions that can be used as outcome-level proof. */
export function hasStrongExplicitAssertion(step: TestStep): boolean {
  if (step.action !== 'assert') return false
  if (step.url !== undefined && step.url.trim() !== '') return true
  return (
    typeof step.selector === 'string' &&
    step.selector.trim() !== '' &&
    typeof step.value === 'string' &&
    step.value.trim() !== ''
  )
}

/** selector = visible target; value = contained visible text; url = exact URL. */
export async function assertPage(page: Page, step: TestStep, baseUrl: string): Promise<string | undefined> {
  const timeout = step.timeout ?? 15000
  for (const key of ['selector', 'value', 'url'] as const) {
    if (step[key] !== undefined && (typeof step[key] !== 'string' || !step[key]!.trim())) {
      throw new Error(`assert ${key} must be a nonempty string`)
    }
  }

  try {
    if (hasExplicitAssertion(step)) {
      if (step.url !== undefined) {
        const expected = new URL(step.url, baseUrl).href
        // Use a predicate so wildcard characters in URLs remain literal.
        await page.waitForURL(url => url.href === expected, { timeout })
      }
      if (step.selector !== undefined || step.value !== undefined) {
        const target = step.selector ? stepLocator(page, step.selector) : page.locator('body')
        // An explicit selector honours the step timeout; the implicit body
        // target gets a usable minimum so the text check can still report.
        await target.waitFor({ state: 'visible', timeout: step.selector ? timeout : Math.max(timeout, MIN_READ_MS) })
        if (step.value !== undefined) {
          const deadline = Date.now() + timeout
          let lastText: string | undefined
          let lastError: unknown
          while (true) {
            // Each read gets a usable minimum: near the deadline a 1ms timeout
            // used to throw before the failure could report the page's text.
            try {
              lastText = await target.innerText({ timeout: Math.max(MIN_READ_MS, deadline - Date.now()) })
              if (lastText.includes(step.value)) break
            } catch (error) {
              lastError = error
            }
            if (Date.now() >= deadline) {
              const received = lastText !== undefined
                ? `received ${JSON.stringify(excerpt(lastText, step.value))}`
                : `could not read its text (${lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError)})`
              throw new Error(`Expected ${step.selector ?? 'body'} to contain ${JSON.stringify(step.value)}; ${received}`)
            }
            await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())))
          }
        }
      }
      return step.selector
    }

    // Compatibility for generated description-only assertions: page health only.
    const errors = page.locator('[role="alert"], [data-error], .error-message, .toast-error')
    for (let i = 0; i < await errors.count(); i++) {
      const error = errors.nth(i)
      if (await error.isVisible()) {
        const text = await error.innerText({ timeout })
        if (text.trim()) throw new Error(`error visible on page: ${text.slice(0, 200)}`)
      }
    }
    const body = await page.locator('body').innerText({ timeout })
    if (body.trim().length < 10) throw new Error('page appears blank or crashed')
    return undefined
  } catch (err) {
    throw new AssertionFailure(`Assertion failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
