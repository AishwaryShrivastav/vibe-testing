import { BrowserContext } from 'playwright'
import { AuthConfig } from '../../types/config.js'
import { interpolateEnv } from '../../utils/env.js'
import { logger } from '../../utils/logger.js'
import { fillLoginForm } from './login-form.js'

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

    // `fields.email` names the identity field, which may be a username, phone
    // number or ID — the config key predates non-email logins.
    await fillLoginForm(
      page,
      {
        identity: interpolateEnv(auth.credentials.email),
        password: interpolateEnv(auth.credentials.password),
      },
      { identityField: auth.fields?.email, passwordField: auth.fields?.password },
    )

    await page.waitForURL(url => !isStillOnLoginPage(url.href), { timeout: 10000 }).catch(() => {})

    // Judge by the path only — a host such as auth.example.com is not a login page
    const loginFailed = isStillOnLoginPage(page.url())

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

/** True when the URL's path is a login/auth page (the host is ignored). */
export function isStillOnLoginPage(url: string): boolean {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { pathname = url }
  return /\/(login|log-in|signin|sign-in|auth)\b/i.test(pathname)
}
