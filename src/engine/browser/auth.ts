import { BrowserContext } from 'playwright'
import { AuthConfig } from '../../types/config.js'
import { interpolateEnv } from '../../utils/env.js'
import { logger } from '../../utils/logger.js'

export async function performLogin(
  context: BrowserContext,
  baseUrl: string,
  auth: AuthConfig
): Promise<boolean> {
  if (auth.strategy === 'skip' || !auth.credentials) return true

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

    await page.fill(`[name="${emailField}"], [type="email"], #${emailField}`, email)
    await page.fill(`[name="${passwordField}"], [type="password"], #${passwordField}`, password)
    await page.click('[type="submit"], button:has-text("Login"), button:has-text("Sign in")')

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
