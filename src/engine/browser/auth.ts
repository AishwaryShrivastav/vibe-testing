import { BrowserContext, Page } from 'playwright'
import { AuthConfig } from '../../types/config.js'
import { interpolateEnv } from '../../utils/env.js'
import { logger } from '../../utils/logger.js'

export async function performLogin(
  context: BrowserContext,
  baseUrl: string,
  auth: AuthConfig
): Promise<boolean> {
  if (auth.strategy === 'skip' || !auth.credentials) return true

  // HTTP Basic Auth — set credentials on the context, no form interaction needed
  if (auth.strategy === 'basic') {
    const email = interpolateEnv(auth.credentials.email)
    const password = interpolateEnv(auth.credentials.password)
    await context.setHTTPCredentials({ username: email, password })
    logger.success('HTTP Basic Auth credentials set')
    return true
  }

  const page = await context.newPage()

  try {
    const loginUrl = auth.login_url
      ? new URL(auth.login_url, baseUrl).href
      : new URL('/login', baseUrl).href

    await page.goto(loginUrl, { waitUntil: 'networkidle' })

    const email    = interpolateEnv(auth.credentials.email)
    const password = interpolateEnv(auth.credentials.password)
    const emailField    = auth.fields?.email    ?? 'email'
    const passwordField = auth.fields?.password ?? 'password'

    // Try selectors in order of specificity — handles forms without name/id attributes
    const emailSelectors = [
      `[name="${emailField}"]`,
      '[type="email"]',
      `#${emailField}`,
      `[placeholder*="email" i]`,
      `[placeholder*="Email" i]`,
      `[aria-label*="email" i]`,
      'input[type="text"]:first-of-type',
    ]
    const passwordSelectors = [
      `[name="${passwordField}"]`,
      '[type="password"]',
      `#${passwordField}`,
      `[placeholder*="password" i]`,
      `[aria-label*="password" i]`,
    ]

    await fillFirstMatch(page, emailSelectors, email)
    await fillFirstMatch(page, passwordSelectors, password)
    await page.click('[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")')

    await page.waitForNavigation({ timeout: 10000 }).catch(() => {})

    const currentUrl = page.url()
    const loginFailed = currentUrl.includes('login') || currentUrl.includes('auth')

    if (loginFailed) {
      logger.warn('Login may have failed — still on login page after submission')
      return false
    }

    logger.success('Authenticated successfully')
    return true
  } catch (err) {
    logger.error(`Login failed: ${err}`)
    return false
  } finally {
    await page.close()
  }
}

async function fillFirstMatch(page: Page, selectors: string[], value: string): Promise<void> {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first()
      if (await el.isVisible({ timeout: 1000 })) {
        await el.fill(value)
        return
      }
    } catch { /* try next selector */ }
  }
  // Last resort: try the first visible input on the page
  throw new Error(`No matching input found for selectors: ${selectors.join(', ')}`)
}
