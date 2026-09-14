import type { Locator, Page } from 'playwright'
import type { TestStep } from '../../types/index.js'

export class AssertionFailure extends Error {}

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
        await target.waitFor({ state: 'visible', timeout })
        if (step.value !== undefined) {
          const deadline = Date.now() + timeout
          while (true) {
            const actual = await target.innerText({ timeout: Math.max(1, deadline - Date.now()) })
            if (actual.includes(step.value)) break
            if (Date.now() >= deadline) {
              throw new Error(`Expected ${step.selector ?? 'body'} to contain ${JSON.stringify(step.value)}; received ${JSON.stringify(actual.slice(0, 200))}`)
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
