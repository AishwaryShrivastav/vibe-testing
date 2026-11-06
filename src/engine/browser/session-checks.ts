import path from 'node:path'
import type { Browser, Page } from 'playwright'
import type { VibeConfig } from '../../types/config.js'
import type { TestResult, TestScenario } from '../../types/index.js'
import type { ActionBlocklist } from '../../utils/blocklist.js'
import { isStillOnLoginPage, performLoginDetailed } from './auth.js'

// Word match rather than an exact name: icon fonts (e.g. <i class="fa fa-power-off">)
// add a glyph to the accessible name, so "Logout" is often " Logout".
const LOGOUT_NAME = /(?:^|[^a-z])(?:log\s*-?\s*out|sign\s*-?\s*out)(?:[^a-z]|$)/i
const MAX_LOGOUT_LABEL = 24

/**
 * Logout round-trip: in its own browser session, log in, use the app's
 * Log out / Sign out control, then reopen a protected page. If that page
 * still opens without signing in again, logout does not end the session.
 *
 * Returns undefined (nothing to judge) when there are no configured
 * credentials, login fails, the app has no visible logout control, or the
 * blocklist covers logging out.
 */
export async function checkLogoutRoundTrip(
  browser: Browser,
  config: VibeConfig,
  protectedRoute: string,
  screenshotsDir: string,
  blocklist?: ActionBlocklist,
): Promise<TestResult | undefined> {
  if (config.auth?.strategy !== 'credentials' || !config.auth.credentials) return undefined
  if (blocklist?.isBlocked(undefined, 'Logout') || blocklist?.isBlocked(undefined, 'Sign out')) return undefined

  const scenario: TestScenario = {
    id: 'logout-round-trip',
    name: 'Logout ends the session',
    route: protectedRoute,
    priority: 'high',
    steps: [
      { action: 'navigate', url: config.auth.login_url ?? '/login', description: 'Log in with the configured credentials' },
      { action: 'click', description: 'Click the Log out / Sign out control' },
      { action: 'navigate', url: protectedRoute, description: `Reopen protected page ${protectedRoute}` },
      { action: 'assert', description: 'Expect to be sent to sign-in' },
    ],
    expected_outcome: 'After logging out, protected pages require signing in again',
    is_gap: true,
    generated_by: 'heuristic',
    requires_auth: true,
  }

  const context = await browser.newContext({ baseURL: config.url, viewport: { width: 1280, height: 800 } })
  const started = Date.now()
  try {
    const login = await performLoginDetailed(context, config.url, config.auth, config.retries)
    if (!login.ok) return undefined

    const page = await context.newPage()
    await page.goto(login.landingUrl ?? new URL(protectedRoute, config.url).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

    const control = await findLogoutControl(page)
    if (!control) return undefined
    const controlText = (await control.innerText({ timeout: 1000 }).catch(() => 'Log out')).trim()

    await control.click({ timeout: 5000 })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    const afterLogout = page.url()

    await page.goto(new URL(protectedRoute, config.url).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)

    const landed = page.url()
    const signInShown = isStillOnLoginPage(landed) ||
      await page.locator('input[type="password"]:visible').count().then(n => n > 0).catch(() => false)

    const screenshotPath = path.join(screenshotsDir, `${scenario.id}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
    const pathOf = (url: string) => { try { return new URL(url).pathname } catch { return url } }

    return {
      scenario,
      status: signInShown ? 'pass' : 'fail',
      duration_ms: Date.now() - started,
      screenshot_path: screenshotPath,
      current_url: landed,
      ai_verdict: signInShown
        ? `After "${controlText}", ${protectedRoute} required signing in again (${pathOf(landed)})`
        : `Logout does not end the session: after "${controlText}" (landed on ${pathOf(afterLogout)}), ${protectedRoute} still opened without signing in (${pathOf(landed)})`,
      verification_status: signInShown ? 'outcome_verified' : 'not_verified',
      step_logs: [],
    }
  } catch {
    return undefined
  } finally {
    await context.close().catch(() => {})
  }
}

/** The first visible Log out / Sign out control (layouts often also hide one in a closed menu). */
async function findLogoutControl(page: Page) {
  for (const role of ['button', 'link', 'menuitem'] as const) {
    for (const control of await page.getByRole(role, { name: LOGOUT_NAME }).all()) {
      if (!await control.isVisible().catch(() => false)) continue
      const label = (await control.innerText({ timeout: 500 }).catch(() => '')).trim()
      if (label.length <= MAX_LOGOUT_LABEL) return control
    }
  }
  return undefined
}
