import { Page, BrowserContext, Response } from 'playwright'
import { logger } from '../../utils/logger.js'
import { ensureDir } from '../../utils/file.js'
import { ActionBlocklist } from '../../utils/blocklist.js'
import { describeSignal, describeSignalGroups, detectCrashText, evidenceFromBody, settleSignals, uniqueSignals, watchServerErrors, type ServerErrorSignal } from './error-signals.js'
import { probeForms } from './boundary-probes.js'
import { verifyCreatedValues } from './form-checks.js'
import { detectBrokenValues, findEmptyState, newSuccessLines, visibleText, watchConsoleErrors, watchResourceFailures } from './page-checks.js'
import { TotalsTracker, exerciseTotalActions } from './totals-check.js'
import { DEFAULT_WRITE_POLICY, editFormKeys, formSkipReason, isWriteButton, keepInputReason, looseEditReason, markSignupForms, pageContext, submitSkipReason, watchWrites, type AppChange, type WritePolicy } from './write-policy.js'
import { gotoSettled, trackRequests, waitForSettled } from './settle.js'
import { controlSignature, pageFingerprint, type PageFingerprint } from './fingerprint.js'
import { DEPTH_RANK, type Depth, type DepthDecision } from './depth.js'
import { isExplorerFailure } from '../finding-kinds.js'
import path from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredElement {
  tag: string
  type: 'button' | 'link' | 'input' | 'select' | 'checkbox' | 'radio' | 'tab' | 'other'
  text: string
  selector: string
  disabled: boolean
  role?: string
  href?: string
  inputType?: string
  placeholder?: string
}

export interface InteractionOutcome {
  element: string
  elementType: string
  action: string
  result: 'success' | 'error' | 'no_change' | 'dialog_opened' | 'navigated' | 'content_updated' | 'toast_shown' | 'skipped'
  details: string
  duration_ms: number
}

export interface ApiObservation {
  url: string
  method: string
  status: number
  path: string
  responseTime_ms: number
  isError: boolean
}

export interface PageExploration {
  route: string
  url: string
  elements_discovered: number
  elements_by_type: Record<string, number>
  interactions: InteractionOutcome[]
  api_calls: ApiObservation[]
  errors: string[]
  /** Lower-confidence findings, e.g. placeholder values such as "Category: Unknown". */
  warnings?: string[]
  /** Set when the page sent the explorer to a sign-in page instead of rendering (its path). */
  redirected_to?: string
  /** True for the signed-in exploration pass; false/undefined for the logged-out one. */
  signed_in?: boolean
  /** Data-changing requests exploration made (what to clean up afterwards). */
  changes?: AppChange[]
  /** How deeply the page was tested, and why (see depth.ts). */
  depth?: Depth
  depth_reason?: string
  /** Milliseconds spent per phase: load, discover, interact, links, journey, create, probes. */
  timings?: Record<string, number>
  /** The page's structure, compared between runs to spot changed pages. */
  fingerprint?: PageFingerprint
  /** The page's non-link controls; equal signatures mean one template. */
  control_signature?: string
  duration_ms: number
  screenshot_path?: string
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// Separators like "Log out", "log-out", "sign_out" are allowed between word parts.
const DESTRUCTIVE_PATTERNS = /\b(delete|remove|destroy|log.?out|sign.?out|cancel.?account|deactivate|revoke|terminate|unsubscribe)\b/i
const NAVIGATION_SKIP = /\b(log.?in|register|sign.?up|sign.?in|log.?out|sign.?out)\b/i

/** Buttons the explorer must never click on a real app (data loss, ending the session). */
export function isDestructiveAction(text: string | undefined): boolean {
  return DESTRUCTIVE_PATTERNS.test(text ?? '')
}

/** Links into auth flows the explorer skips so it doesn't log itself out or start sign-up. */
export function isAuthNavigation(text: string | undefined, href: string | undefined): boolean {
  return NAVIGATION_SKIP.test(text ?? '') || NAVIGATION_SKIP.test(href ?? '')
}

// ─── Element Discovery ───────────────────────────────────────────────────────

/**
 * Dev-only overlays injected by frameworks and data libraries (TanStack Query
 * and Router devtools, Next.js dev overlay, Vite error overlay, Vue/Nuxt
 * devtools, Astro dev toolbar). Elements inside them are never explored.
 */
export const DEV_OVERLAY_SELECTOR = [
  '[class*="devtools" i]', '[id*="devtools" i]', '[aria-label*="devtool" i]', '[data-testid*="devtools" i]',
  '.tsqd-parent-container', '[class*="tsqd-"]',
  'nextjs-portal', '[data-nextjs-toast]', '[data-nextjs-dialog-overlay]', '[data-next-badge-root]', '#__next-build-watcher',
  'vite-error-overlay', 'astro-dev-toolbar', 'nuxt-devtools-frame',
].join(', ')

async function discoverElements(page: Page): Promise<DiscoveredElement[]> {
  try {
    const elements = await page.evaluate(`(() => {
      var results = [];
      var seen = {};

      function getVisibleText(el) {
        var clone = el.cloneNode(true);
        var removable = clone.querySelectorAll('svg, img, .sr-only');
        for (var i = 0; i < removable.length; i++) removable[i].remove();
        return (clone.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      }

      function buildSelector(el) {
        var testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId + '"]';
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';
        var id = el.id;
        if (id && id[0] !== ':') return '#' + id;
        var name = el.name;
        if (name) return '[name="' + name + '"]';
        var placeholder = el.placeholder;
        if (placeholder) return '[placeholder="' + placeholder + '"]';
        var text = getVisibleText(el);
        if (text && text.length < 50 && text.length > 0) return 'text=' + text;
        return '';
      }

      function addElement(el, type) {
        // Framework dev overlays are not the app: clicking through them is slow and reports noise.
        if (el.closest(${JSON.stringify(DEV_OVERLAY_SELECTOR)})) return;
        var rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.width === 0) return;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        var text = getVisibleText(el);
        var selector = buildSelector(el);
        var key = type + ':' + (selector || text);
        if (seen[key] || (!text && !selector)) return;
        seen[key] = true;
        results.push({
          tag: el.tagName.toLowerCase(),
          type: type,
          text: text.slice(0, 80),
          selector: selector,
          disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
          role: el.getAttribute('role') || undefined,
          href: el.href || undefined,
          inputType: el.type || undefined,
          placeholder: el.placeholder || undefined
        });
      }

      document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(function(el) { addElement(el, 'button'); });
      document.querySelectorAll('a[href]:not([href="#"]):not([href="javascript:void(0)"])').forEach(function(el) { addElement(el, 'link'); });
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea').forEach(function(el) { addElement(el, 'input'); });
      document.querySelectorAll('select, [role="combobox"], [role="listbox"]').forEach(function(el) { addElement(el, 'select'); });
      document.querySelectorAll('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"]').forEach(function(el) { addElement(el, 'checkbox'); });
      document.querySelectorAll('[role="tab"]').forEach(function(el) { addElement(el, 'tab'); });

      return results;
    })()`)
    return (elements as DiscoveredElement[]) ?? []
  } catch (err) {
    logger.warn(`    discoverElements failed: ${(err as Error).message.slice(0, 100)}`)
    return []
  }
}

async function discoverElementsSimple(page: Page): Promise<DiscoveredElement[]> {
  const elements: DiscoveredElement[] = []

  // Buttons
  const buttons = await page.locator('button:visible, [role="button"]:visible').all().catch(() => [])
  for (const btn of buttons.slice(0, 15)) {
    const text = await btn.innerText().catch(() => '')
    if (!text.trim()) continue
    elements.push({
      tag: 'button', type: 'button', text: text.trim().slice(0, 80),
      selector: `text=${text.trim().slice(0, 50)}`,
      disabled: await btn.isDisabled().catch(() => false),
    })
  }

  // Inputs
  const inputs = await page.locator('input:visible:not([type="hidden"]):not([type="submit"]), textarea:visible').all().catch(() => [])
  for (const inp of inputs.slice(0, 15)) {
    const ph = await inp.getAttribute('placeholder').catch(() => '') ?? ''
    const id = await inp.getAttribute('id').catch(() => '') ?? ''
    const type = await inp.getAttribute('type').catch(() => 'text') ?? 'text'
    const selector = ph ? `[placeholder="${ph}"]` : id ? `#${id}` : `[type="${type}"]`
    elements.push({
      tag: 'input', type: 'input', text: ph || id || type,
      selector, disabled: await inp.isDisabled().catch(() => false),
      inputType: type, placeholder: ph || undefined,
    })
  }

  // Links
  const links = await page.locator('a[href]:visible').all().catch(() => [])
  for (const link of links.slice(0, 10)) {
    const text = await link.innerText().catch(() => '')
    const href = await link.getAttribute('href').catch(() => '') ?? ''
    if (!text.trim() || href === '#') continue
    elements.push({
      tag: 'a', type: 'link', text: text.trim().slice(0, 80),
      selector: `text=${text.trim().slice(0, 50)}`,
      disabled: false, href,
    })
  }

  // Tabs
  const tabs = await page.locator('[role="tab"]:visible').all().catch(() => [])
  for (const tab of tabs.slice(0, 8)) {
    const text = await tab.innerText().catch(() => '')
    if (!text.trim()) continue
    elements.push({
      tag: 'button', type: 'tab', text: text.trim().slice(0, 80),
      selector: `text=${text.trim().slice(0, 50)}`,
      disabled: false,
    })
  }

  // Checkboxes / switches
  const checks = await page.locator('[role="checkbox"]:visible, [role="switch"]:visible, input[type="checkbox"]:visible').all().catch(() => [])
  for (const cb of checks.slice(0, 5)) {
    const label = await cb.getAttribute('aria-label').catch(() => '') ?? ''
    elements.push({
      tag: 'input', type: 'checkbox', text: label,
      selector: label ? `[aria-label="${label}"]` : 'input[type="checkbox"]',
      disabled: await cb.isDisabled().catch(() => false),
    })
  }

  return elements
}

// ─── Page State Capture ───────────────────────────────────────────────────────

interface PageState {
  url: string
  contentLen: number
  dialogOpen: boolean
  toastVisible: boolean
}

async function capturePageState(page: Page): Promise<PageState> {
  const url = page.url()
  const contentLen = await page.evaluate(() => document.body.innerText.length).catch(() => 0)
  const dialogOpen = await page.locator('[role="dialog"], [data-state="open"][role="dialog"], .modal.show').count().then(n => n > 0).catch(() => false)
  const toastVisible = await page.locator('[data-sonner-toast], [role="status"]:not(:empty), .Toastify__toast, [data-radix-toast-viewport] > *').count().then(n => n > 0).catch(() => false)
  return { url, contentLen, dialogOpen, toastVisible }
}

// ─── Element Interaction Testers ──────────────────────────────────────────────

async function resolveAndClick(page: Page, element: DiscoveredElement, timeout = 3000): Promise<void> {
  // Common nav actions: role+name avoids ambiguous getByText matches (sidebar vs header)
  const t = element.text.trim()
  if (element.type === 'button' && /^(log\s*out|sign\s*out)$/i.test(t)) {
    const roleBtn = page.getByRole('button', { name: /log\s*out|sign\s*out/i }).first()
    if (await roleBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await roleBtn.click({ timeout })
      return
    }
  }

  // For links, strongly prefer href-based selector — text matching is ambiguous
  if (element.type === 'link' && element.href) {
    try {
      const href = element.href
      // Try exact href match first, then partial path match
      const hrefLocator = page.locator(`a[href="${href}"]`).first()
      if (await hrefLocator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await hrefLocator.click({ timeout })
        return
      }
      // Try path-only match (strips origin)
      const path = (() => { try { return new URL(href).pathname } catch { return href } })()
      const pathLocator = page.locator(`a[href="${path}"], a[href$="${path}"]`).first()
      if (await pathLocator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await pathLocator.click({ timeout })
        return
      }
    } catch { /* fall through to text-based */ }
  }

  const sel = element.selector
  if (!sel) throw new Error('No selector')

  if (sel.startsWith('text=')) {
    const text = sel.slice(5)
    // For short text that might match multiple elements, use exact match
    const exact = text.length < 20
    await page.getByText(text, { exact }).first().click({ timeout })
  } else if (sel.startsWith('[aria-label=') || sel.startsWith('#') || sel.startsWith('[')) {
    await page.locator(sel).first().click({ timeout })
  } else {
    await page.locator(sel).first().click({ timeout })
  }
}

async function testButton(
  page: Page,
  element: DiscoveredElement,
  originalUrl: string,
  serverSignals: ServerErrorSignal[] = [],
): Promise<InteractionOutcome> {
  const start = Date.now()

  if (isDestructiveAction(element.text)) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'skipped', details: 'Skipped — destructive action', duration_ms: 0 }
  }

  if (!element.selector) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'skipped', details: 'No reliable selector', duration_ms: 0 }
  }

  const before = await capturePageState(page)
  const crashBefore = await detectCrashText(page)
  const textBefore = await visibleText(page)
  const signalsBefore = serverSignals.length

  try {
    await resolveAndClick(page, element, 3000)
  } catch (err) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'error', details: `Click failed: ${(err as Error).message.slice(0, 120)}`, duration_ms: Date.now() - start }
  }

  // Short settle — 400ms is enough for dialogs/toasts; 800ms was wasteful
  await page.waitForTimeout(400)
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})

  // An action that reports success while the page shows an empty state
  // (e.g. "Checkout successful!" next to "No items in the cart") did nothing.
  const emptyState = findEmptyState(textBefore)
  if (emptyState) {
    const success = newSuccessLines(textBefore, await visibleText(page))[0]
    if (success) {
      return {
        element: element.text, elementType: 'button', action: 'click', result: 'error',
        details: `Empty-state action: clicking "${element.text}" while the page showed "${emptyState}" reported "${success}"`,
        duration_ms: Date.now() - start,
      }
    }
  }

  // A click that crashed the server is a broken element, whatever else changed.
  const crashAfter = await detectCrashText(page)
  if (serverSignals.length > signalsBefore || (crashAfter && crashAfter !== crashBefore)) {
    await settleSignals(serverSignals)
    const evidence = serverSignals.length > signalsBefore
      ? describeSignal(serverSignals[signalsBefore])
      : `Crash text after click: ${crashAfter}`
    if (page.url() !== originalUrl) await gotoSettled(page, originalUrl, 8000).catch(() => {})
    return { element: element.text, elementType: 'button', action: 'click', result: 'error', details: evidence, duration_ms: Date.now() - start }
  }

  const after = await capturePageState(page)

  if (after.dialogOpen && !before.dialogOpen) {
    const dialogInfo = await exploreDialog(page)
    await closeDialog(page)
    return { element: element.text, elementType: 'button', action: 'click', result: 'dialog_opened', details: `Dialog opened${dialogInfo}`, duration_ms: Date.now() - start }
  }

  if (after.toastVisible && !before.toastVisible) {
    const toastText = await page.locator('[data-sonner-toast], [role="status"]:not(:empty), .Toastify__toast').first().innerText({ timeout: 500 }).catch(() => '')
    return { element: element.text, elementType: 'button', action: 'click', result: 'toast_shown', details: `Toast: "${toastText.slice(0, 100)}"`, duration_ms: Date.now() - start }
  }

  if (after.url !== before.url) {
    const newPath = (() => { try { return new URL(after.url).pathname } catch { return after.url } })()
    await gotoSettled(page, originalUrl, 8000).catch(() => {})
    return { element: element.text, elementType: 'button', action: 'click', result: 'navigated', details: `Navigated to ${newPath}`, duration_ms: Date.now() - start }
  }

  if (Math.abs(after.contentLen - before.contentLen) > 50) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'content_updated', details: 'Page content changed after click', duration_ms: Date.now() - start }
  }

  return { element: element.text, elementType: 'button', action: 'click', result: 'no_change', details: 'No visible change after click', duration_ms: Date.now() - start }
}

async function testInput(page: Page, element: DiscoveredElement): Promise<InteractionOutcome> {
  const start = Date.now()
  const label = element.placeholder || element.text || element.inputType || 'input'

  if (!element.selector) {
    return { element: label, elementType: 'input', action: 'fill', result: 'skipped', details: 'No reliable selector', duration_ms: 0 }
  }

  const testValue = generateTestValue(element)

  try {
    if (element.selector.startsWith('[placeholder=')) {
      const ph = element.selector.match(/\[placeholder="([^"]+)"\]/)
      if (ph) await page.getByPlaceholder(ph[1], { exact: false }).first().fill(testValue, { timeout: 3000 })
    } else if (element.selector.startsWith('#') || element.selector.startsWith('[name=')) {
      await page.locator(element.selector).first().fill(testValue, { timeout: 3000 })
    } else {
      await page.locator(element.selector).first().fill(testValue, { timeout: 3000 })
    }
    return { element: label, elementType: 'input', action: 'fill', result: 'success', details: `Filled with "${testValue}"`, duration_ms: Date.now() - start }
  } catch (err) {
    return { element: label, elementType: 'input', action: 'fill', result: 'error', details: `Fill failed: ${(err as Error).message.slice(0, 120)}`, duration_ms: Date.now() - start }
  }
}

async function testTab(page: Page, element: DiscoveredElement): Promise<InteractionOutcome> {
  const start = Date.now()

  if (!element.selector && !element.text) {
    return { element: 'tab', elementType: 'tab', action: 'click', result: 'skipped', details: 'No selector', duration_ms: 0 }
  }

  const before = await capturePageState(page)
  try {
    await resolveAndClick(page, element, 3000)
    await page.waitForTimeout(500)
    const after = await capturePageState(page)

    if (Math.abs(after.contentLen - before.contentLen) > 20) {
      return { element: element.text, elementType: 'tab', action: 'click', result: 'content_updated', details: 'Tab content refreshed', duration_ms: Date.now() - start }
    }
    return { element: element.text, elementType: 'tab', action: 'click', result: 'success', details: 'Tab clicked successfully', duration_ms: Date.now() - start }
  } catch (err) {
    return { element: element.text, elementType: 'tab', action: 'click', result: 'error', details: `Tab click failed: ${(err as Error).message.slice(0, 120)}`, duration_ms: Date.now() - start }
  }
}

/**
 * True when any link on the page resolves to `href` and is visible. Matching
 * the resolved URL (a.href) rather than the attribute text handles relative
 * hrefs with query strings and several links sharing one label ("Book now").
 */
async function anyVisibleLinkTo(page: Page, href: string): Promise<boolean> {
  await page.evaluate(`(() => {
    const target = ${JSON.stringify(href)}
    document.querySelectorAll('a[href]').forEach(a => {
      if (a.href === target) a.setAttribute('data-vibe-link-check', '')
      else a.removeAttribute('data-vibe-link-check')
    })
  })()`).catch(() => {})
  for (const link of (await page.locator('[data-vibe-link-check]').all()).slice(0, 10)) {
    if (await link.isVisible().catch(() => false)) return true
  }
  return false
}

async function testLink(page: Page, element: DiscoveredElement, originalUrl: string, serverSignals: ServerErrorSignal[] = []): Promise<InteractionOutcome> {
  const start = Date.now()

  if (!element.href || element.href === '#') {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'skipped', details: 'No valid href', duration_ms: 0 }
  }

  if (isAuthNavigation(element.text, element.href)) {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'skipped', details: 'Skipped auth-related link', duration_ms: 0 }
  }

  const originalPath = (() => { try { return new URL(originalUrl).pathname } catch { return '' } })()
  let linkPath: string
  let isExternal = false

  try {
    const linkUrl = new URL(element.href)
    const baseUrl = new URL(originalUrl)
    isExternal = linkUrl.origin !== baseUrl.origin
    linkPath = linkUrl.pathname
  } catch {
    linkPath = element.href
  }

  if (isExternal) {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'success', details: `External link → ${element.href.slice(0, 60)}`, duration_ms: 0 }
  }

  // Skip links that point to the current page (sidebar "active" links)
  if (linkPath === originalPath) {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'success', details: `Same-page link (${linkPath})`, duration_ms: 0 }
  }

  // Verify the link element is visible on the page without clicking
  const isVisible = await anyVisibleLinkTo(page, element.href)

  if (!isVisible) {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'error', details: `Link not visible on page`, duration_ms: Date.now() - start }
  }

  // Fetch the destination with the page's session instead of navigating away
  // and back: same status, redirects and server errors, a fraction of the
  // time. (The in-app journey still navigates for real.)
  try {
    // Keep the query: some pages only render with it (/reservation/1?checkin=…).
    const destUrl = new URL(element.href, originalUrl).href
    const resp = await page.request.get(destUrl, { timeout: 8000, maxRedirects: 10, failOnStatusCode: false })
    const status = resp.status()
    const finalPath = (() => { try { return new URL(resp.url()).pathname } catch { return '' } })()
    if (status >= 500) {
      const body = await resp.text().catch(() => '')
      serverSignals.push({ url: destUrl, method: 'GET', status, evidence: evidenceFromBody(body, status) })
    }
    await resp.dispose().catch(() => {})

    // Check if we got redirected to login (auth wall)
    const hitAuthWall = /\/(login|signin|auth)\b/.test(finalPath) && !linkPath.includes('login')

    if (hitAuthWall) {
      return { element: element.text, elementType: 'link', action: 'navigate', result: 'error', details: `Redirected to ${finalPath} (auth wall)`, duration_ms: Date.now() - start }
    }

    if (status >= 400) {
      return { element: element.text, elementType: 'link', action: 'navigate', result: 'error', details: `HTTP ${status} at ${linkPath}`, duration_ms: Date.now() - start }
    }

    return { element: element.text, elementType: 'link', action: 'navigate', result: 'navigated', details: `${linkPath} loaded (${status})`, duration_ms: Date.now() - start }
  } catch (err) {
    return { element: element.text, elementType: 'link', action: 'navigate', result: 'error', details: `Navigation failed: ${(err as Error).message.slice(0, 100)}`, duration_ms: Date.now() - start }
  }
}

async function testCheckbox(page: Page, element: DiscoveredElement): Promise<InteractionOutcome> {
  const start = Date.now()
  const label = element.text || element.selector || 'checkbox'

  if (!element.selector) {
    return { element: label, elementType: 'checkbox', action: 'toggle', result: 'skipped', details: 'No reliable selector', duration_ms: 0 }
  }

  try {
    const locator = page.locator(element.selector).first()
    const wasBefore = await locator.isChecked().catch(() => null)

    await locator.click({ timeout: 3000 })
    await page.waitForTimeout(300)

    const isAfter = await locator.isChecked().catch(() => null)
    if (wasBefore !== null && isAfter !== null && wasBefore !== isAfter) {
      return { element: label, elementType: 'checkbox', action: 'toggle', result: 'success', details: `Toggled ${wasBefore ? 'off' : 'on'}`, duration_ms: Date.now() - start }
    }

    return { element: label, elementType: 'checkbox', action: 'toggle', result: 'success', details: 'Clicked', duration_ms: Date.now() - start }
  } catch (err) {
    return { element: label, elementType: 'checkbox', action: 'toggle', result: 'error', details: `Toggle failed: ${(err as Error).message.slice(0, 120)}`, duration_ms: Date.now() - start }
  }
}

// ─── Dialog Exploration ───────────────────────────────────────────────────────

async function exploreDialog(page: Page): Promise<string> {
  try {
    const dialog = page.locator('[role="dialog"]').first()
    const title = await dialog.locator('h1, h2, h3, [class*="title"], [class*="Title"]').first().innerText({ timeout: 1000 }).catch(() => '')
    const inputs = await dialog.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0)
    const buttons = await dialog.locator('button').count().catch(() => 0)
    const parts: string[] = []
    if (title) parts.push(`title: "${title}"`)
    if (inputs > 0) parts.push(`${inputs} input(s)`)
    if (buttons > 0) parts.push(`${buttons} button(s)`)
    return parts.length ? ` — ${parts.join(', ')}` : ''
  } catch {
    return ''
  }
}

async function closeDialog(page: Page): Promise<void> {
  try {
    // Try close button first
    const closeBtn = page.locator('[aria-label="Close"], button:has-text("Close"), button:has-text("Cancel"), [data-dismiss], button:has-text("×")').first()
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click({ timeout: 2000 })
      await page.waitForTimeout(300)
      return
    }
  } catch { /* fall through */ }

  // Fallback: press Escape
  try {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  } catch { /* best effort */ }
}

// ─── Value Generation ─────────────────────────────────────────────────────────

function generateTestValue(element: DiscoveredElement): string {
  const t = element.inputType?.toLowerCase() ?? ''
  const ph = (element.placeholder ?? '').toLowerCase()
  const name = element.text.toLowerCase()

  if (t === 'email' || ph.includes('email') || name.includes('email')) return 'vibe-test@example.com'
  if (t === 'password' || ph.includes('password')) return 'TestPass123!'
  if (t === 'number' || t === 'range') return '42'
  if (t === 'tel' || ph.includes('phone') || ph.includes('tel')) return '+15550001234'
  if (t === 'url' || ph.includes('url') || ph.includes('website')) return 'https://example.com'
  if (t === 'date') return '2025-06-15'
  if (t === 'time') return '14:30'
  if (t === 'color') return '#6366f1'
  if (ph.includes('search') || ph.includes('filter') || name.includes('search')) return 'test query'
  if (ph.includes('name') || name.includes('name')) return 'Vibe Test User'
  if (ph.includes(',') || name.includes('tag') || name.includes('issue')) return 'Tag One, Tag Two'

  return 'vibe test input'
}

// ─── Main Page Explorer ───────────────────────────────────────────────────────

export interface ExploreOptions {
  /** Submit forms with malformed/boundary values (G9). Default true. */
  boundaryProbes?: boolean
  /** Submit add/create forms with a marker and check it is shown. Default true. */
  createChecks?: boolean
  /** Repeat add actions and follow in-app links by clicking. Default true. */
  journey?: boolean
  /** What exploration may change in the app (see write-policy.ts). Default "safe". */
  writes?: WritePolicy
  /** How much to run (see depth.ts). Default "thorough". */
  depth?: Depth
  /** Why this depth, shown in the report. */
  depthReason?: string
  /**
   * Once the page's controls are known: a lighter decision when the page is
   * one more instance of a template already tested (same route pattern or
   * same controls under the same parent path).
   */
  templateCheck?: (signature: string) => DepthDecision | undefined
}

/** Input types that take no typed value. */
const NOT_FILLABLE = /^(?:checkbox|radio|file|submit|button|reset|image|hidden|range|color)$/i

export async function explorePage(
  context: BrowserContext,
  route: string,
  baseUrl: string,
  screenshotsDir: string,
  blocklist?: ActionBlocklist,
  options: ExploreOptions = {},
): Promise<PageExploration> {
  const startTime = Date.now()
  const page = await context.newPage()
  trackRequests(page)
  let depth: Depth = options.depth ?? 'thorough'
  let depthReason = options.depthReason ?? 'every page thoroughly'
  const timings: Record<string, number> = {}
  let phaseStart = Date.now()
  const endPhase = (name: string) => { timings[name] = Date.now() - phaseStart; phaseStart = Date.now() }
  const origin = (() => { try { return new URL(baseUrl).origin } catch { return '' } })()
  const apiCalls: ApiObservation[] = []
  const errors: string[] = []
  const serverWatch = watchServerErrors(page)
  const consoleWatch = watchConsoleErrors(page)
  const resourceWatch = watchResourceFailures(page, (() => { try { return new URL(baseUrl).origin } catch { return '' } })())
  const writes = options.writes ?? DEFAULT_WRITE_POLICY
  const writeLog = watchWrites(page, (() => { try { return new URL(baseUrl).origin } catch { return '' } })())

  // Intercept ALL network requests for API monitoring
  const requestTimings = new Map<string, number>()

  page.on('request', (req) => {
    requestTimings.set(req.url() + req.method(), Date.now())
  })

  page.on('response', (response: Response) => {
    const url = response.url()
    const method = response.request().method()
    if (url.match(/\.(js|css|png|jpg|svg|woff|woff2|ico|map|ttf|eot)(\?|$)/)) return
    if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) return
    // Record by resource type, not URL shape: fetch/XHR under any prefix
    // (e.g. /rest/), form posts, and page loads that failed.
    const type = response.request().resourceType()
    const isDataCall = type === 'xhr' || type === 'fetch'
    const isFailedDocument = type === 'document' && response.status() >= 400
    if (isDataCall || isFailedDocument || /\/api\/|\/graphql|\/auth|\/v\d+\//.test(url) || method !== 'GET') {
      const startMs = requestTimings.get(url + method)
      apiCalls.push({
        url,
        method,
        status: response.status(),
        path: (() => { try { return new URL(url).pathname } catch { return url } })(),
        responseTime_ms: startMs ? Date.now() - startMs : 0,
        isError: response.status() >= 400,
      })
    }
  })

  // Uncaught exceptions in the page are bugs even when nothing looks broken.
  page.on('pageerror', (error: Error) => {
    if (errors.length < 50) errors.push(`Uncaught exception: ${error.message.slice(0, 200)}`)
  })

  const fullUrl = new URL(route, baseUrl).href

  try {
    // Wait for the network to settle, not just for a few controls: a nav bar
    // renders first, while the page's own content waits on data (e.g. a
    // session check). Capped so apps that poll constantly don't stall.
    await gotoSettled(page, fullUrl, 15000, 6000)
  } catch (err) {
    errors.push(`Navigation failed: ${(err as Error).message}`)
    await page.close().catch(() => {})
    return { route, url: fullUrl, elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: apiCalls, errors, depth, depth_reason: depthReason, duration_ms: Date.now() - startTime }
  }
  endPhase('load')

  // Check for auth redirect
  const currentPath = (() => { try { return new URL(page.url()).pathname } catch { return '' } })()
  if (currentPath !== route && /\/(login|signin|auth)\b/.test(currentPath)) {
    await page.close().catch(() => {})
    return { route, url: fullUrl, elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: apiCalls, errors: [`Redirected to ${currentPath} — sign-in required`], redirected_to: currentPath, depth, depth_reason: depthReason, duration_ms: Date.now() - startTime }
  }

  // Discover all interactive elements
  let elements: DiscoveredElement[] = []
  try {
    elements = await discoverElements(page)
    if (elements.length === 0) {
      const fallbackCount = await page.evaluate('document.querySelectorAll("button, a, input, textarea, select").length').catch(() => 0) as number
      if (fallbackCount > 0) {
        errors.push(`Discovery returned 0 but page has ${fallbackCount} elements — retrying with simpler method`)
        elements = await discoverElementsSimple(page)
      }
    }
  } catch (err) {
    errors.push(`Element discovery failed: ${(err as Error).message}`)
  }

  const elementsByType: Record<string, number> = {}
  for (const el of elements) {
    elementsByType[el.type] = (elementsByType[el.type] ?? 0) + 1
  }

  logger.dim(`    ${elements.length} elements: ${Object.entries(elementsByType).map(([k, v]) => `${v} ${k}s`).join(', ')}`)

  // One more page of a template already tested gets the light checks only.
  const signature = controlSignature(elements)
  const template = options.templateCheck?.(signature)
  if (template && DEPTH_RANK[template.depth] < DEPTH_RANK[depth]) {
    depth = template.depth
    depthReason = template.reason
  }
  const fingerprint = await pageFingerprint(page, elements, apiCalls, origin)
  endPhase('discover')

  const interactions: InteractionOutcome[] = []
  const brokenValues = new Map<string, string>()   // finding -> where
  const placeholderValues = new Map<string, string>()
  const totals = new TotalsTracker()
  const scanValues = async (where: string) => {
    await totals.check(page, where)
    const found = await detectBrokenValues(page)
    for (const line of found.broken) if (!brokenValues.has(line)) brokenValues.set(line, where)
    for (const line of found.placeholders) if (!placeholderValues.has(line)) placeholderValues.set(line, where)
  }
  await scanValues(route)

  const isBlocked = (el: DiscoveredElement) =>
    blocklist?.isBlocked(el.selector, el.text) ?? false

  // Writes the page makes while loading are its own; from here on they're ours.
  writeLog.startTracking()
  const interact = depth !== 'light'
  const thorough = depth === 'thorough'
  const screenshotPath = path.join(screenshotsDir, `explore-${route.replace(/[/?&=]/g, '_').replace(/^_/, '')}.png`)
  await ensureDir(screenshotsDir)
  if (!interact) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})

  // ── Phase 1: Tabs (safe, helps reveal content) ──
  const tabs = interact ? elements.filter(e => e.type === 'tab' && !e.disabled && !isBlocked(e)) : []
  for (const tab of tabs.slice(0, 12)) {
    writeLog.setAction(`tab "${tab.text}"`)
    interactions.push(await testTab(page, tab))
  }

  // ── Phase 2: Inputs (fill with test data) ──
  // Checkboxes and radios are toggled in their own phase; they can't be filled.
  const inputs = interact ? elements.filter(e => e.type === 'input' && !e.disabled && !isBlocked(e) && !NOT_FILLABLE.test(e.inputType ?? '')) : []
  // Never overwrite what is already there unless explore.writes is "all": a
  // later Save would store the test values over real data.
  const editForms = writes === 'all' || !interact ? new Set<string>() : await editFormKeys(page)
  if (writes !== 'all' && interact) await markSignupForms(page)
  const looseEdit = writes === 'all' || !interact ? undefined : await looseEditReason(page)
  for (const input of inputs.slice(0, 20)) {
    const keep = await keepInputReason(page, input.selector, writes, editForms)
    if (keep) {
      interactions.push({ element: input.placeholder || input.text || input.inputType || 'input', elementType: 'input', action: 'fill', result: 'skipped', details: keep, duration_ms: 0 })
      continue
    }
    writeLog.setAction(`fill "${input.placeholder || input.text || input.inputType || 'input'}"`)
    interactions.push(await testInput(page, input))
  }

  // ── Phase 3: Checkboxes / toggles ──
  const checkboxes = interact ? elements.filter(e => e.type === 'checkbox' && !e.disabled && !isBlocked(e)) : []
  for (const cb of checkboxes.slice(0, 10)) {
    writeLog.setAction(`toggle "${cb.text || cb.selector}"`)
    interactions.push(await testCheckbox(page, cb))
  }

  // ── Phase 4: Buttons (click each, observe response) ──
  const buttons = elements.filter(e => e.type === 'button' && !e.disabled && !isBlocked(e))
  for (const btn of interact ? buttons.slice(0, 20) : []) {
    if (writes === 'none' && await isWriteButton(page, btn.selector, btn.text)) {
      interactions.push({ element: btn.text, elementType: 'button', action: 'click', result: 'skipped', details: 'Skipped — data-changing action (explore.writes: none)', duration_ms: 0 })
      continue
    }
    const submitSkip = await submitSkipReason(page, btn.selector, btn.text, writes, editForms, looseEdit)
    if (submitSkip) {
      interactions.push({ element: btn.text, elementType: 'button', action: 'click', result: 'skipped', details: submitSkip, duration_ms: 0 })
      continue
    }
    if (!thorough && await isWriteButton(page, btn.selector, btn.text)) {
      interactions.push({ element: btn.text, elementType: 'button', action: 'click', result: 'skipped', details: `Skipped — data-changing action (${depth} depth)`, duration_ms: 0 })
      continue
    }
    writeLog.setAction(`click "${btn.text}"`)
    interactions.push(await testButton(page, btn, fullUrl, serverWatch.signals))
  }
  if (interact) await scanValues(route)
  endPhase('interact')

  // ── Phase 5: Links (verify + follow internal ones) ──
  const links = elements.filter(e => e.type === 'link' && !isBlocked(e))
  for (const link of interact ? links.slice(0, 12) : []) {
    writeLog.setAction(`link "${link.text}"`)
    interactions.push(await testLink(page, link, fullUrl, serverWatch.signals))
  }
  endPhase('links')

  // ── Phase 5b: In-app journey — repeat "add" actions, then move through the
  // app by clicking (client-side navigation keeps app state, like a user) ──
  if (thorough && options.journey !== false) {
    writeLog.setAction('in-app journey')
    // "none": follow links only — repeating "add" actions and clicking
    // actions on pages with a total both create or change records.
    const canClickForTotals = (label: string) => writes !== 'none' &&
      !isDestructiveAction(label) && !isAuthNavigation(label, undefined) && !(blocklist?.isBlocked(undefined, label) ?? false)
    interactions.push(...await inAppJourney(page, fullUrl, writes === 'none' ? [] : buttons, links, isBlocked, scanValues,
      (where: string) => exerciseTotalActions(page, totals, where, canClickForTotals)))
  }
  endPhase('journey')

  // Take final screenshot
  if (interact) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})

  // ── Phase 6: Create-then-verify on add/create/save forms ──
  if (thorough && options.createChecks !== false) {
    writeLog.setAction('create-then-verify')
    interactions.push(...await verifyCreatedValues(page, fullUrl, blocklist, writeGate(page, writes)))
  }
  endPhase('create')

  // ── Phase 7: Boundary input probes on forms (G9) ──
  if (thorough && options.boundaryProbes !== false) {
    writeLog.setAction('boundary probes')
    const probes = await probeForms(page, fullUrl, serverWatch.signals, blocklist, writeGate(page, writes))
    interactions.push(...probes)
  }
  endPhase('probes')

  // Every server failure is reported once (page load, clicks, probes), plus
  // crash text, hangs and functional failures that interactions caused.
  await settleSignals(serverWatch.signals)
  errors.push(...describeSignalGroups(uniqueSignals(serverWatch.signals)))
  for (const interaction of interactions) {
    if (interaction.result === 'error' && /^(Crash text|No response|Empty-state action|Submitted value not shown)/.test(interaction.details)) {
      errors.push(`${interaction.element} (${interaction.action}): ${interaction.details}`)
    }
  }
  await consoleWatch.settle()
  for (const message of consoleWatch.messages) errors.push(`Console error: ${message}`)
  for (const [line, where] of brokenValues) errors.push(`Broken value on ${where}: "${line}"`)
  errors.push(...totals.findings)
  for (const resource of resourceWatch.broken) errors.push(`Broken resource: ${resource}`)
  const warnings = [
    ...[...placeholderValues].map(([line, where]) => `Placeholder value on ${where}: "${line}"`),
    ...resourceWatch.unavailable.map(resource => `Resource unavailable: ${resource}`),
  ]

  serverWatch.stop()
  consoleWatch.stop()
  resourceWatch.stop()
  writeLog.stop()
  await page.close().catch(() => {})

  return {
    route,
    url: fullUrl,
    elements_discovered: elements.length,
    elements_by_type: elementsByType,
    interactions,
    api_calls: apiCalls,
    errors,
    warnings,
    ...(writeLog.changes.length > 0 ? { changes: writeLog.changes } : {}),
    depth,
    depth_reason: depthReason,
    timings,
    fingerprint,
    control_signature: signature,
    duration_ms: Date.now() - startTime,
    screenshot_path: screenshotPath,
  }
}

/** Per-form gate for create checks and probes: a skip reason, or undefined to proceed. */
function writeGate(page: Page, writes: WritePolicy) {
  return async (form: { fields: Array<{ value?: string }>; label: string }) =>
    formSkipReason(writes, form.fields, `${form.label} ${await pageContext(page)}`)
}

const ADD_ACTION = /^\+$|\badd\b|\bplus\b|\bincrease\b/i

/**
 * Repeat each kind of "add" action twice (double-add is a classic source of
 * duplicates and stale totals), then follow in-app links by clicking them so
 * single-page apps keep their state, and scan each destination for broken
 * values. Console errors and server failures are collected by the page-level
 * watchers while this runs.
 */
async function inAppJourney(
  page: Page,
  pageUrl: string,
  buttons: DiscoveredElement[],
  links: DiscoveredElement[],
  isBlocked: (el: DiscoveredElement) => boolean,
  scanValues: (where: string) => Promise<void>,
  /** On a destination that shows a total, click its actions and re-check the total. */
  exerciseTotals?: (where: string) => Promise<InteractionOutcome[]>,
): Promise<InteractionOutcome[]> {
  const outcomes: InteractionOutcome[] = []
  const start = Date.now()
  const origin = (() => { try { return new URL(pageUrl).origin } catch { return '' } })()
  try {
    await gotoSettled(page, pageUrl, 15000)
  } catch {
    return outcomes
  }

  const addButtons = buttons.filter(b => ADD_ACTION.test(b.text) && !isDestructiveAction(b.text) && !isBlocked(b)).slice(0, 2)
  for (const button of addButtons) {
    try {
      await resolveAndClick(page, button, 3000)
      await page.waitForTimeout(250)
      await resolveAndClick(page, button, 3000)
      await page.waitForTimeout(250)
      outcomes.push({ element: button.text, elementType: 'button', action: 'journey: repeat add', result: 'success', details: 'Clicked twice', duration_ms: Date.now() - start })
      await scanValues(`${new URL(pageUrl).pathname} after clicking "${button.text}" twice`)
    } catch (err) {
      outcomes.push({ element: button.text, elementType: 'button', action: 'journey: repeat add', result: 'skipped', details: `Could not repeat: ${(err as Error).message.slice(0, 80)}`, duration_ms: Date.now() - start })
    }
  }

  const internal = links.filter(link => {
    if (!link.href || isBlocked(link) || isAuthNavigation(link.text, link.href) || isDestructiveAction(link.text)) return false
    try {
      const url = new URL(link.href)
      return url.origin === origin && url.pathname !== new URL(pageUrl).pathname && !url.hash
    } catch {
      return false
    }
  }).slice(0, 6)

  // A page that starts empty (a cart, a till, a basket) can only be exercised
  // with something in it: add an item on a linked page, come back in-app (so
  // the app keeps its state), then use the page's own actions and re-check
  // its total.
  if (addButtons.length === 0 && exerciseTotals && findEmptyState(await visibleText(page))) {
    outcomes.push(...await seedFromLinkedPage(page, pageUrl, internal, isBlocked, scanValues, exerciseTotals, start))
    await gotoSettled(page, pageUrl, 15000).catch(() => {})
  }

  for (const link of internal) {
    const path = new URL(link.href!).pathname
    const locator = page.locator(`a[href="${link.href}"], a[href="${path}"]`).first()
    if (!await locator.isVisible({ timeout: 800 }).catch(() => false)) continue
    try {
      await locator.click({ timeout: 3000 })
      await waitForSettled(page, { capMs: 4000 })
      await scanValues(`${path} (via in-app navigation)`)
      outcomes.push({ element: link.text || path, elementType: 'link', action: 'journey: navigate', result: 'navigated', details: `Opened ${path} in-app`, duration_ms: Date.now() - start })
      if (exerciseTotals) outcomes.push(...await exerciseTotals(`${path} (via in-app navigation)`))
    } catch (err) {
      outcomes.push({ element: link.text || path, elementType: 'link', action: 'journey: navigate', result: 'error', details: `In-app navigation failed: ${(err as Error).message.slice(0, 80)}`, duration_ms: Date.now() - start })
    }
  }
  return outcomes
}

/**
 * From an empty page: open linked pages in-app until one has an "add" action,
 * click it, return to the page in-app and exercise it (see inAppJourney).
 */
async function seedFromLinkedPage(
  page: Page,
  pageUrl: string,
  internal: DiscoveredElement[],
  isBlocked: (el: DiscoveredElement) => boolean,
  scanValues: (where: string) => Promise<void>,
  exerciseTotals: (where: string) => Promise<InteractionOutcome[]>,
  start: number,
): Promise<InteractionOutcome[]> {
  const startPath = new URL(pageUrl).pathname
  for (const link of internal.slice(0, 3)) {
    const linkPath = new URL(link.href!).pathname
    try {
      const out = page.locator(`a[href="${link.href}"], a[href="${linkPath}"]`).first()
      if (!await out.isVisible({ timeout: 800 }).catch(() => false)) continue
      await out.click({ timeout: 3000 })
      await waitForSettled(page, { capMs: 4000 })
      const add = page.getByRole('button', { name: ADD_ACTION }).first()
      const label = (await add.innerText({ timeout: 800 }).catch(() => '')).trim()
      const blocked = !label || isDestructiveAction(label) || isBlocked({ tag: 'button', type: 'button', text: label, selector: '', disabled: false })
      const back = page.locator(`a[href="${startPath}"], a[href="${new URL(pageUrl).origin}${startPath}"]`).first()
      if (blocked || !await add.isVisible().catch(() => false) || !await back.isVisible({ timeout: 800 }).catch(() => false)) {
        await gotoSettled(page, pageUrl, 15000)
        continue
      }
      await add.click({ timeout: 3000 })
      await page.waitForTimeout(250)
      await back.click({ timeout: 3000 })
      await waitForSettled(page, { capMs: 4000 })
      const where = `${startPath} after adding an item on ${linkPath}`
      const result: InteractionOutcome[] = [{
        element: label, elementType: 'button', action: 'journey: add elsewhere, return', result: 'success',
        details: `Clicked "${label}" on ${linkPath}, back on ${startPath} in-app`, duration_ms: Date.now() - start,
      }]
      await scanValues(where)
      result.push(...await exerciseTotals(where))
      return result
    } catch {
      await gotoSettled(page, pageUrl, 15000).catch(() => {})
    }
  }
  return []
}

// ─── Multi-page exploration orchestrator ──────────────────────────────────────

export interface ExploreAllOptions extends ExploreOptions {
  /** Depth per route; "skip" leaves the page out. Default: every page thoroughly. */
  decide?: (route: string) => DepthDecision | 'skip'
  /** The route pattern a concrete route belongs to (/tutorial/:page), for same-template grouping. */
  templateOf?: (route: string) => string | undefined
  /** After a light or standard pass: a reason to test the page thoroughly now (e.g. its fingerprint changed). */
  recheck?: (exploration: PageExploration) => string | undefined
  /** Routes whose scenarios failed: tested thoroughly whatever was planned. */
  failedRoutes?: Set<string>
  /** Called for each route the plan skipped. */
  onSkip?: (route: string) => void
  /** Group same-template pages (default true). */
  groupTemplates?: boolean
}

/** Parent path for template grouping: only below the top level ("/tutorial" for "/tutorial/a1"). */
function templateParent(route: string): string | undefined {
  const segments = route.split('?')[0].split('/').filter(Boolean)
  return segments.length >= 2 ? `/${segments.slice(0, -1).join('/')}` : undefined
}

/** A light or standard pass found a real problem in the app. */
function hasProblem(exploration: PageExploration): boolean {
  return exploration.errors.some(isExplorerFailure)
}

export async function exploreAllPages(
  context: BrowserContext,
  routes: string[],
  baseUrl: string,
  screenshotsDir: string,
  blocklist?: ActionBlocklist,
  options: ExploreAllOptions = {},
): Promise<PageExploration[]> {
  const explorations: PageExploration[] = []
  const templateFirst = new Map<string, string>()

  for (const route of routes) {
    const planned = options.decide ? options.decide(route) : { depth: 'thorough' as Depth, reason: 'every page thoroughly' }
    if (planned === 'skip') {
      options.onSkip?.(route)
      continue
    }
    let decision: DepthDecision = planned
    if (decision.depth !== 'thorough' && options.failedRoutes?.has(route)) {
      decision = { depth: 'thorough', reason: `upgraded after a failing scenario (planned ${planned.depth}: ${planned.reason})` }
    }
    const pattern = options.templateOf?.(route)
    const templateCheck = options.groupTemplates === false ? undefined : (signature: string): DepthDecision | undefined => {
      const parent = templateParent(route)
      const key = pattern ? `pattern ${pattern}` : parent ? `${parent}/* ${signature}` : undefined
      if (!key) return undefined
      const first = templateFirst.get(key)
      if (!first) {
        templateFirst.set(key, route)
        return undefined
      }
      return { depth: 'light', reason: `same template as ${first}${pattern ? ` (${pattern})` : ''}` }
    }

    logger.info(`  Exploring: ${route} (${decision.depth})`)
    try {
      let exploration = await explorePage(context, route, baseUrl, screenshotsDir, blocklist, {
        ...options, depth: decision.depth, depthReason: decision.reason, templateCheck,
      })
      // Safety net: a lighter pass that found a problem, or a page that changed
      // since the last run, gets the full treatment now.
      if (exploration.depth !== 'thorough' && !exploration.redirected_to) {
        const upgrade = hasProblem(exploration)
          ? `upgraded after a problem at ${exploration.depth} depth`
          : options.recheck?.(exploration)
        if (upgrade) {
          logger.dim(`    Re-testing thoroughly: ${upgrade}`)
          exploration = await explorePage(context, route, baseUrl, screenshotsDir, blocklist, {
            ...options, depth: 'thorough', depthReason: upgrade,
          })
        }
      }
      explorations.push(exploration)

      const tested = exploration.interactions.filter(i => i.result !== 'skipped').length
      const passed = exploration.interactions.filter(i => i.result === 'success' || i.result === 'content_updated' || i.result === 'dialog_opened' || i.result === 'navigated' || i.result === 'toast_shown').length
      const failed = exploration.interactions.filter(i => i.result === 'error').length
      const apis = exploration.api_calls.length
      const apiErrors = exploration.api_calls.filter(a => a.isError).length
      const phases = Object.entries(exploration.timings ?? {}).filter(([, ms]) => ms >= 50).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(', ')

      logger.dim(`    ${exploration.depth}: ${tested} tested, ${passed} working, ${failed} broken, ${apis} API calls${apiErrors > 0 ? ` (${apiErrors} errors)` : ''}${phases ? ` — ${phases}` : ''}`)
    } catch (err) {
      logger.warn(`    Exploration crashed: ${(err as Error).message}`)
      explorations.push({
        route,
        url: new URL(route, baseUrl).href,
        elements_discovered: 0,
        elements_by_type: {},
        interactions: [],
        api_calls: [],
        errors: [`Crash: ${(err as Error).message}`],
        depth: decision.depth,
        depth_reason: decision.reason,
        duration_ms: 0,
      })
    }
  }

  return explorations
}
