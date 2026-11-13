import type { BrowserContext, Page } from 'playwright'
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

      if (!await waitForLoginOutcome(page, loginUrl)) {
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

/**
 * After submitting a login form, wait until the app has decided, then return
 * true when the login form is still shown (login failed).
 *
 * The URL alone can't tell: a login form often lives at a path that doesn't
 * say "login" (e.g. /admin shows the form until signed in, then the admin UI).
 * Signed in means the page left the login URL for a non-login path, or the
 * password field is gone. Waits for the network to settle afterwards so the
 * session cookie or token from the login response is stored before the page
 * closes.
 */
export async function waitForLoginOutcome(page: Page, loginUrl: string): Promise<boolean> {
  const loginPath = pathOf(loginUrl)
  await page.waitForFunction(
    ({ loginPath, loginPattern }) => {
      const path = location.pathname
      const leftLogin = path !== loginPath && !new RegExp(loginPattern, 'i').test(path)
      const passwordShown = Array.from(document.querySelectorAll('input[type="password"]'))
        .some(el => (el as HTMLElement).offsetParent !== null)
      return leftLogin || !passwordShown
    },
    { loginPath, loginPattern: LOGIN_PATH.source },
    { timeout: 10000, polling: 250 },
  ).catch(() => {})
  // Some apps unmount the form first and change the URL a moment later
  // (state machine, then redirect). Give the URL time to follow before judging.
  if (isStillOnLoginPage(page.url())) {
    await page.waitForFunction(
      ({ loginPattern }) => !new RegExp(loginPattern, 'i').test(location.pathname),
      { loginPattern: LOGIN_PATH.source },
      { timeout: 3000, polling: 100 },
    ).catch(() => {})
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  return loginFormStillShown(page, loginUrl)
}

/** True when the page is still the login page: on a login path, or on the login URL with a visible password field. */
export async function loginFormStillShown(page: Page, loginUrl: string): Promise<boolean> {
  const current = page.url()
  if (isStillOnLoginPage(current)) return true
  const leftLogin = pathOf(current) !== pathOf(loginUrl)
  if (leftLogin) return false
  return page.locator('input[type="password"]:visible').count().then(n => n > 0).catch(() => false)
}

function pathOf(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|auth)\b/

/** True when the URL's path is a login/auth page (the host is ignored). */
export function isStillOnLoginPage(url: string): boolean {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { pathname = url }
  return new RegExp(LOGIN_PATH.source, 'i').test(pathname)
}
