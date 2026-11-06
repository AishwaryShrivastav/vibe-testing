import { BrowserContext } from 'playwright'
import { AuthConfig } from '../../types/config.js'
import { interpolateEnv } from '../../utils/env.js'
import { logger } from '../../utils/logger.js'
import { fillLoginForm, readLoginError } from './login-form.js'

export interface LoginOutcome {
  ok: boolean
  /** Form submissions made (0 when no form login was needed). */
  attempts: number
  /** What the page showed after the first failed submission, when one failed. */
  firstFailure?: string
  /** Where a successful form login landed (e.g. /dashboard). */
  landingUrl?: string
}

/** Log in and report only success. See performLoginDetailed for retries. */
export async function performLogin(
  context: BrowserContext,
  baseUrl: string,
  auth: AuthConfig,
  retries = 1,
): Promise<boolean> {
  return (await performLoginDetailed(context, baseUrl, auth, retries)).ok
}

/**
 * Log in with configured credentials. A rejected login is resubmitted on the
 * same page up to `retries` more times — some apps (and some bugs) only
 * accept the second submission, and page state such as "already tried once"
 * is lost on a fresh page. A login that needed a retry is reported through
 * `attempts` and `firstFailure` so callers can surface it as a finding.
 */
export async function performLoginDetailed(
  context: BrowserContext,
  baseUrl: string,
  auth: AuthConfig,
  retries = 1,
): Promise<LoginOutcome> {
  if (auth.strategy === 'skip' || !auth.credentials) return { ok: true, attempts: 0 }

  // HTTP Basic Auth — set credentials on the context, no form interaction needed
  if (auth.strategy === 'basic') {
    const email = interpolateEnv(auth.credentials.email)
    const password = interpolateEnv(auth.credentials.password)
    await context.setHTTPCredentials({ username: email, password })
    logger.success('HTTP Basic Auth credentials set')
    return { ok: true, attempts: 0 }
  }

  const page = await context.newPage()
  let attempts = 0
  let firstFailure: string | undefined

  try {
    const loginUrl = auth.login_url
      ? new URL(auth.login_url, baseUrl).href
      : new URL('/login', baseUrl).href

    await page.goto(loginUrl, { waitUntil: 'networkidle' })

    const credentials = {
      identity: interpolateEnv(auth.credentials.email),
      password: interpolateEnv(auth.credentials.password),
    }
    // `fields.email` names the identity field, which may be a username, phone
    // number or ID — the config key predates non-email logins.
    const hints = { identityField: auth.fields?.email, passwordField: auth.fields?.password }

    while (attempts <= retries) {
      attempts++
      await fillLoginForm(page, credentials, hints)
      await page.waitForURL(url => !isStillOnLoginPage(url.href), { timeout: 10000 }).catch(() => {})

      // Judge by the path only — a host such as auth.example.com is not a login page
      if (!isStillOnLoginPage(page.url())) {
        if (attempts > 1) logger.warn(`Login only succeeded on attempt ${attempts} (first attempt: ${firstFailure})`)
        else logger.success('Authenticated successfully')
        return { ok: true, attempts, firstFailure, landingUrl: page.url() }
      }
      if (attempts === 1) firstFailure = await readLoginError(page) ?? 'stayed on the login page'
    }

    logger.warn('Login may have failed — still on login page after submission')
    return { ok: false, attempts, firstFailure }
  } catch (err) {
    logger.error(`Login failed: ${err}`)
    return { ok: false, attempts, firstFailure: firstFailure ?? (err instanceof Error ? err.message : String(err)) }
  } finally {
    await page.close()
  }
}

/** Finding text for a login that only worked after a retry, or undefined. */
export function describeLoginRetry(outcome: LoginOutcome, where: string): string | undefined {
  if (!outcome.ok || outcome.attempts < 2) return undefined
  return `${where}: login with valid credentials only succeeded on attempt ${outcome.attempts} (first attempt: ${outcome.firstFailure ?? 'rejected'})`
}

/** True when the URL's path is a login/auth page (the host is ignored). */
export function isStillOnLoginPage(url: string): boolean {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { pathname = url }
  return /\/(login|log-in|signin|sign-in|auth)\b/i.test(pathname)
}
