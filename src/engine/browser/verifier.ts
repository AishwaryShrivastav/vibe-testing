import { Page } from 'playwright'
import { TestScenario, ApiError } from '../../types/index.js'

export interface VerificationResult {
  passed: boolean
  explanation: string
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
    '[role="alert"]:not(:empty), [data-error]:not(:empty), .toast-error:not(:empty)'
  ).count().then(n => n > 0).catch(() => false)

  const hasSuccessIndicator = await page.locator(
    '[data-success]:not(:empty), .toast-success:not(:empty)'
  ).count().then(n => n > 0).catch(() => false)

  const toastInfo = await detectToast(page)
  const wasRedirected = detectRedirect(scenario, currentUrl, navigatedUrl)
  const currentPath = extractPath(currentUrl)

  // Hard fail: authenticated scenarios that ended up on a login/auth page
  if (scenario.requires_auth && /\/(login|signin|auth)\b/.test(currentPath)) {
    return {
      passed: false,
      explanation: `Authentication failed — expected ${scenario.route} but ended up on ${currentPath}`,
    }
  }

  const isFormScenario = scenario.steps.some(s => s.action === 'fill')
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
      return { passed: true, explanation: `Expected API error: ${firstErr.status} ${firstErr.body.slice(0, 80)}` }
    }
    return { passed: false, explanation: `API returned error: ${firstErr.status} ${firstErr.body.slice(0, 80)}` }
  }

  // Toast-based verdict
  if (toastInfo.found) {
    if (toastInfo.type === 'success') {
      return { passed: true, explanation: `Success toast: "${toastInfo.text}"` }
    }
    if (toastInfo.type === 'error') {
      return {
        passed: expectsError,
        explanation: expectsError
          ? `Expected error toast: "${toastInfo.text}"`
          : `Error toast: "${toastInfo.text}"`,
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
      return { passed: true, explanation: `Page loaded at ${currentPath} without redirect` }
    }
    if (currentPath.includes('login') || currentPath.includes('signin')) {
      return { passed: false, explanation: `Redirected to ${currentPath} — authentication may have failed` }
    }
    return { passed: false, explanation: `Unexpected redirect from ${scenario.route} to ${currentPath}` }
  }

  if (expectsRedirectToLogin) {
    if (currentPath.includes('login') || currentPath.includes('signin')) {
      return { passed: true, explanation: `Correctly redirected to login page (${currentPath})` }
    }
    if (currentPath === scenario.route) {
      return { passed: false, explanation: `Expected redirect to login but stayed on ${currentPath}` }
    }
    return { passed: true, explanation: `Redirected from ${scenario.route} to ${currentPath}` }
  }

  // Navigation tests
  const isNavigationTest = nameAndOutcome.includes('navigate from') || nameAndOutcome.includes('navigation from')
  if (redirect.redirected && !isFormScenario && !isNavigationTest) {
    return {
      passed: false,
      explanation: `Unexpected redirect: navigated to ${redirect.from} but ended up on ${redirect.to} (likely requires authentication)`,
    }
  }

  if (isNavigationTest && currentPath !== scenario.route) {
    return { passed: true, explanation: `Successfully navigated to ${currentPath}` }
  }

  // Form submission: URL changed = likely success
  if (isFormScenario && currentPath !== scenario.route) {
    if (redirect.redirected) {
      const landedOnAuth = redirect.to && /login|signin|auth/.test(redirect.to)
      if (landedOnAuth) {
        return { passed: false, explanation: `Form submitted but redirected to login (${redirect.to})` }
      }
      return { passed: true, explanation: `Navigated from ${scenario.route} to ${currentPath} after form submission` }
    }
    return { passed: true, explanation: `Navigated away from ${scenario.route} to ${currentPath} — form action succeeded` }
  }

  // Smoke test: "page loads"
  const isSmokeTest = scenario.name.includes('page loads') || scenario.name.includes('accessible when')

  if (isSmokeTest) {
    if (isBlankPage)  return { passed: false, explanation: 'Page appears blank — no content rendered' }
    if (isErrorPage)  return { passed: false, explanation: 'Error page detected (404/500)' }
    if (hasContent && !hasErrorMessage) {
      return { passed: true, explanation: 'Page loaded with content, no errors detected' }
    }
    if (hasErrorMessage) {
      return { passed: false, explanation: 'Page loaded but error indicators found on page' }
    }
  }

  // DOM error/success signals
  if (hasErrorMessage) {
    return {
      passed: expectsError,
      explanation: expectsError
        ? 'Validation/error message displayed as expected'
        : 'Unexpected error message found on page',
    }
  }

  if (hasSuccessIndicator) {
    return { passed: true, explanation: 'Success indicator found on page' }
  }

  // Search/filter tests stay on same page
  const isSearchOrFilter = /search|filter|sort/i.test(scenario.name)
  if (isSearchOrFilter && currentPath === scenario.route) {
    return { passed: true, explanation: `Search/filter executed on ${currentPath} — page updated in place` }
  }

  // Create/dialog tests
  const isCreateTest = /create|add new|cancel/i.test(scenario.name)
  if (isCreateTest && currentPath === scenario.route && !hasErrorMessage) {
    return { passed: true, explanation: 'Create action executed on page' }
  }

  // Data display verification
  const isDataTest = /data renders|content visible/i.test(scenario.name)
  if (isDataTest && hasContent && !isBlankPage && !isErrorPage) {
    return { passed: true, explanation: 'Page has content rendered' }
  }

  const hasSubmitClick = scenario.steps.some(s => s.action === 'click' && (s.selector?.includes('submit') || s.description.toLowerCase().includes('submit')))
  if (isFormScenario && hasSubmitClick && currentPath === scenario.route && !expectsError) {
    return { passed: false, explanation: `Form stayed on ${currentPath} with no success indication` }
  }

  if (hasContent && !hasErrorMessage && !isErrorPage) {
    return { passed: true, explanation: 'Page rendered with content, no errors detected' }
  }

  return { passed: false, explanation: 'Could not determine result — review screenshot manually' }
}
