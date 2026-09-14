import { Page } from 'playwright'
import { TestScenario, ApiError, VerificationStatus } from '../../types/index.js'
import { hasExplicitAssertion, hasStrongExplicitAssertion } from './assertions.js'

export interface VerificationResult {
  passed: boolean
  explanation: string
  verification: VerificationStatus
}

export async function verifyResult(
  page: Page,
  scenario: TestScenario,
  _screenshotPath: string,
  navigatedUrl?: string,
  apiErrors?: ApiError[]
): Promise<VerificationResult> {
  const currentUrl  = page.url()

  const hasErrorMessage = await page.locator(
    '[role="alert"]:visible:not(:empty), [data-error]:visible:not(:empty), .toast-error:visible:not(:empty)'
  ).count().then(n => n > 0).catch(() => false)

  const hasSuccessIndicator = await page.locator(
    '[data-success]:visible:not(:empty), .toast-success:visible:not(:empty)'
  ).count().then(n => n > 0).catch(() => false)

  const toastInfo = await detectToast(page)
  const wasRedirected = detectRedirect(scenario, currentUrl, navigatedUrl)
  const currentPath = extractPath(currentUrl)

  // Hard fail: authenticated scenarios that ended up on a login/auth page
  if (scenario.requires_auth && /\/(login|signin|auth)\b/.test(currentPath)) {
    return {
      passed: false,
      explanation: `Authentication failed — expected ${scenario.route} but ended up on ${currentPath}`,
      verification: 'not_verified',
    }
  }

  const isFormScenario = scenario.steps.some(s => s.action === 'fill')
  const hasProofAssertion = scenario.steps.some(hasStrongExplicitAssertion)
  const expectsError = scenario.expected_outcome.toLowerCase().includes('error') ||
    scenario.expected_outcome.toLowerCase().includes('validation') ||
    scenario.name.toLowerCase().includes('invalid') ||
    scenario.name.toLowerCase().includes('empty')

  // API errors are a strong signal of failure for form submissions
  if (apiErrors?.length && isFormScenario && !expectsError) {
    const firstErr = apiErrors[0]
    return {
      passed: false,
      explanation: `API error: ${firstErr.status} ${firstErr.body.slice(0, 100)}`,
      verification: 'not_verified',
    }
  }

  // The runner already evaluated explicit assertions. Prose heuristics must not
  // override a successfully checked expected error UI or a short valid page.
  if (scenario.steps.some(hasExplicitAssertion)) {
    return {
      passed: true,
      explanation: 'All explicit page assertions passed',
      verification: hasProofAssertion ? 'outcome_verified' : 'smoke_check_passed',
    }
  }

  return heuristicVerification(scenario, currentUrl, hasErrorMessage, hasSuccessIndicator, page, wasRedirected, toastInfo, apiErrors)
}

interface RedirectInfo {
  redirected: boolean
  from?: string
  to?: string
}

interface ToastInfo {
  found: boolean
  text: string
  type: 'success' | 'error' | 'unknown'
}

async function detectToast(page: Page): Promise<ToastInfo> {
  const toastSelectors = [
    '[data-sonner-toast]',
    '[data-radix-toast-viewport] [data-state="open"]',
    '[role="status"][data-state="open"]',
    '.Toastify__toast',
    '[class*="toast"][data-state="open"]',
    'li[data-sonner-toast]',
    '[role="status"]:not(:empty)',
  ]

  for (const selector of toastSelectors) {
    try {
      const el = page.locator(selector).first()
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false)
      if (!visible) continue

      const text = await el.innerText({ timeout: 500 }).catch(() => '')
      if (!text.trim()) continue

      const lowerText = text.toLowerCase()
      const isError = /fail|error|invalid|wrong|expired|denied|unauthorized/i.test(lowerText)
      const isSuccess = /success|created|welcome|saved|updated|sent|logged|registered/i.test(lowerText)

      return {
        found: true,
        text: text.trim().slice(0, 200),
        type: isError ? 'error' : isSuccess ? 'success' : 'unknown',
      }
    } catch { continue }
  }

  return { found: false, text: '', type: 'unknown' }
}

function detectRedirect(scenario: TestScenario, currentUrl: string, navigatedUrl?: string): RedirectInfo {
  const currentPath = extractPath(currentUrl)
  const targetPath = scenario.route

  const expectsRedirect = scenario.name.toLowerCase().includes('redirect') ||
    scenario.expected_outcome.toLowerCase().includes('redirect')
  if (expectsRedirect) return { redirected: false }

  if (currentPath !== targetPath && !currentPath.startsWith(targetPath)) {
    return { redirected: true, from: targetPath, to: currentPath }
  }

  return { redirected: false }
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

async function heuristicVerification(
  scenario: TestScenario,
  currentUrl: string,
  hasErrorMessage: boolean,
  hasSuccessIndicator: boolean,
  page: Page,
  redirect: RedirectInfo,
  toastInfo: ToastInfo,
  apiErrors?: ApiError[]
): Promise<VerificationResult> {
  const bodyText = await page.locator('body').innerText().catch(() => '')
  const hasContent = bodyText.trim().length > 50
  const isErrorPage = /404|500|not found|server error/i.test(bodyText.slice(0, 500))
  const isBlankPage = bodyText.trim().length < 10
  const currentPath = extractPath(currentUrl)
  const isFormScenario = scenario.steps.some(s => s.action === 'fill')

  const expectsError = scenario.expected_outcome.toLowerCase().includes('error') ||
    scenario.expected_outcome.toLowerCase().includes('validation') ||
    scenario.name.toLowerCase().includes('invalid') ||
    scenario.name.toLowerCase().includes('empty')

  // API error check
  if (apiErrors?.length && isFormScenario) {
    const firstErr = apiErrors[0]
    if (expectsError) {
      return {
        passed: true,
        explanation: `Expected API error: ${firstErr.status} ${firstErr.body.slice(0, 80)}`,
        verification: 'not_verified',
      }
    }
    return {
      passed: false,
      explanation: `API returned error: ${firstErr.status} ${firstErr.body.slice(0, 80)}`,
      verification: 'not_verified',
    }
  }

  // Toast-based verdict
  if (toastInfo.found) {
    if (toastInfo.type === 'success') {
      return {
        passed: true,
        explanation: `Success toast: "${toastInfo.text}"`,
        verification: 'smoke_check_passed',
      }
    }
    if (toastInfo.type === 'error') {
      return {
        passed: expectsError,
        explanation: expectsError
          ? `Expected error toast: "${toastInfo.text}"`
          : `Error toast: "${toastInfo.text}"`,
        verification: expectsError ? 'outcome_verified' : 'not_verified',
      }
    }
  }

  // Redirect checks
  const nameAndOutcome = (scenario.name + ' ' + scenario.expected_outcome).toLowerCase()
  const expectsRedirectToLogin = nameAndOutcome.includes('redirects to login') ||
    nameAndOutcome.includes('redirect to login')
  const expectsNoRedirect = nameAndOutcome.includes('no redirect') ||
    nameAndOutcome.includes('without redirect')

  if (expectsNoRedirect) {
    if (currentPath === scenario.route || currentPath.startsWith(scenario.route)) {
      return {
        passed: true,
        explanation: `Page loaded at ${currentPath} without redirect`,
        verification: 'smoke_check_passed',
      }
    }
    if (currentPath.includes('login') || currentPath.includes('signin')) {
      return {
        passed: false,
        explanation: `Redirected to ${currentPath} — authentication may have failed`,
        verification: 'not_verified',
      }
    }
    return {
      passed: false,
      explanation: `Unexpected redirect from ${scenario.route} to ${currentPath}`,
      verification: 'not_verified',
    }
  }

  if (expectsRedirectToLogin) {
    if (currentPath.includes('login') || currentPath.includes('signin')) {
      return {
        passed: true,
        explanation: `Correctly redirected to login page (${currentPath})`,
        verification: 'smoke_check_passed',
      }
    }
    // SPAs often keep the URL on the protected route while showing an auth gate in-page
    const pwdVisible = await page.locator('input[type="password"]:visible').count().then(n => n > 0).catch(() => false)
    const authHeading = await page.getByRole('heading', { name: /sign in|log in|welcome back|authenticate/i }).first().isVisible().catch(() => false)
    const signInLink = await page.getByRole('link', { name: /sign in|log in/i }).first().isVisible().catch(() => false)
    if (pwdVisible || authHeading || signInLink) {
      return {
        passed: true,
        explanation: `Auth gate visible on page (SPA pattern) while URL remains ${currentPath}`,
        verification: 'outcome_verified',
      }
    }
    if (currentPath === scenario.route) {
      return {
        passed: false,
        explanation: `Expected redirect to login but stayed on ${currentPath}`,
        verification: 'not_verified',
      }
    }
    return {
      passed: true,
      explanation: `Redirected from ${scenario.route} to ${currentPath}`,
      verification: 'smoke_check_passed',
    }
  }

  // Navigation tests
  const isNavigationTest = nameAndOutcome.includes('navigate from') || nameAndOutcome.includes('navigation from')
  if (redirect.redirected && !isFormScenario && !isNavigationTest) {
    return {
      passed: false,
      explanation: `Unexpected redirect: navigated to ${redirect.from} but ended up on ${redirect.to} (likely requires authentication)`,
      verification: 'not_verified',
    }
  }

  if (isNavigationTest && currentPath !== scenario.route) {
    return {
      passed: true,
      explanation: `Successfully navigated to ${currentPath}`,
      verification: 'smoke_check_passed',
    }
  }

  // Form submission: URL changed = likely success
  if (isFormScenario && currentPath !== scenario.route) {
    if (redirect.redirected) {
      const landedOnAuth = redirect.to && /login|signin|auth/.test(redirect.to)
      if (landedOnAuth) {
        return {
          passed: false,
          explanation: `Form submitted but redirected to login (${redirect.to})`,
          verification: 'not_verified',
        }
      }
      return {
        passed: true,
        explanation: `Navigated from ${scenario.route} to ${currentPath} after form submission`,
        verification: 'smoke_check_passed',
      }
    }
    return {
      passed: true,
      explanation: `Navigated away from ${scenario.route} to ${currentPath} — form action succeeded`,
      verification: 'smoke_check_passed',
    }
  }

  // Smoke test: "page loads"
  const isSmokeTest = scenario.name.includes('page loads') || scenario.name.includes('accessible when')

  if (isSmokeTest) {
    if (isBlankPage)  return {
      passed: false,
      explanation: 'Page appears blank — no content rendered',
      verification: 'not_verified',
    }
    if (isErrorPage)  return {
      passed: false,
      explanation: 'Error page detected (404/500)',
      verification: 'not_verified',
    }
    if (hasContent && !hasErrorMessage) {
      return {
        passed: true,
        explanation: 'Page loaded with content, no errors detected',
        verification: 'smoke_check_passed',
      }
    }
    if (hasErrorMessage) {
      return {
        passed: false,
        explanation: 'Page loaded but error indicators found on page',
        verification: 'not_verified',
      }
    }
  }

  // DOM error/success signals
  if (hasErrorMessage) {
    return {
      passed: expectsError,
      explanation: expectsError
        ? 'Validation/error message displayed as expected'
        : 'Unexpected error message found on page',
      verification: expectsError ? 'outcome_verified' : 'not_verified',
    }
  }

  if (hasSuccessIndicator) {
    return {
      passed: true,
      explanation: 'Success indicator found on page',
      verification: 'smoke_check_passed',
    }
  }

  // Search/filter tests stay on same page
  const isSearchOrFilter = /search|filter|sort/i.test(scenario.name)
  if (isSearchOrFilter && currentPath === scenario.route) {
    return {
      passed: true,
      explanation: `Search/filter executed on ${currentPath} — page updated in place`,
      verification: 'smoke_check_passed',
    }
  }

  // Create/dialog tests
  const isCreateTest = /create|add new|cancel/i.test(scenario.name)
  if (isCreateTest && currentPath === scenario.route && !hasErrorMessage) {
    return {
      passed: true,
      explanation: 'Create action executed on page',
      verification: 'smoke_check_passed',
    }
  }

  // Data display verification
  const isDataTest = /data renders|content visible/i.test(scenario.name)
  if (isDataTest && hasContent && !isBlankPage && !isErrorPage) {
    return {
      passed: true,
      explanation: 'Page has content rendered',
      verification: 'smoke_check_passed',
    }
  }

  const hasSubmitClick = scenario.steps.some(s => s.action === 'click' && (s.selector?.includes('submit') || s.description.toLowerCase().includes('submit')))
  if (isFormScenario && hasSubmitClick && currentPath === scenario.route && !expectsError) {
    return {
      passed: false,
      explanation: `Form stayed on ${currentPath} with no success indication`,
      verification: 'not_verified',
    }
  }

  if (hasContent && !hasErrorMessage && !isErrorPage) {
    return {
      passed: true,
      explanation: 'Page rendered with content, no errors detected',
      verification: 'smoke_check_passed',
    }
  }

  return {
    passed: false,
    explanation: 'Could not determine result — review screenshot manually',
    verification: 'not_verified',
  }
}
