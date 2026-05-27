import { Page, BrowserContext, Response } from 'playwright'
import { logger } from '../../utils/logger.js'
import { ensureDir } from '../../utils/file.js'
import { ActionBlocklist } from '../../utils/blocklist.js'
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
  duration_ms: number
  screenshot_path?: string
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = /\b(delete|remove|destroy|logout|sign.?out|cancel.?account|deactivate|revoke|terminate|unsubscribe)\b/i
const NAVIGATION_SKIP = /\b(login|register|signup|signin|logout|signout)\b/i

// ─── Element Discovery ───────────────────────────────────────────────────────

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

async function testButton(page: Page, element: DiscoveredElement, originalUrl: string): Promise<InteractionOutcome> {
  const start = Date.now()

  if (DESTRUCTIVE_PATTERNS.test(element.text)) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'skipped', details: 'Skipped — destructive action', duration_ms: 0 }
  }

  if (!element.selector) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'skipped', details: 'No reliable selector', duration_ms: 0 }
  }

  const before = await capturePageState(page)

  try {
    await resolveAndClick(page, element, 3000)
  } catch (err) {
    return { element: element.text, elementType: 'button', action: 'click', result: 'error', details: `Click failed: ${(err as Error).message.slice(0, 120)}`, duration_ms: Date.now() - start }
  }

  // Short settle — 400ms is enough for dialogs/toasts; 800ms was wasteful
  await page.waitForTimeout(400)
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
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})
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

async function testLink(page: Page, element: DiscoveredElement, originalUrl: string): Promise<InteractionOutcome> {
  const start = Date.now()

  if (!element.href || element.href === '#') {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'skipped', details: 'No valid href', duration_ms: 0 }
  }

  if (NAVIGATION_SKIP.test(element.text) || NAVIGATION_SKIP.test(element.href)) {
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
  const href = element.href
  const linkLocator = page.locator(`a[href="${href}"], a[href="${linkPath}"], a[href$="${linkPath}"]`).first()
  const isVisible = await linkLocator.isVisible({ timeout: 1500 }).catch(() => false)

  if (!isVisible) {
    return { element: element.text, elementType: 'link', action: 'verify', result: 'error', details: `Link not visible on page`, duration_ms: Date.now() - start }
  }

  // Actually navigate to verify the destination loads (use direct goto, not click —
  // avoids the ambiguous text-match timeout that was causing 5s stalls)
  try {
    const destUrl = new URL(linkPath, originalUrl).href
    const resp = await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 8000 })
    const status = resp?.status() ?? 0
    const finalPath = (() => { try { return new URL(page.url()).pathname } catch { return '' } })()

    // Check if we got redirected to login (auth wall)
    const hitAuthWall = /\/(login|signin|auth)\b/.test(finalPath) && !linkPath.includes('login')

    // Navigate back to original page
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})

    if (hitAuthWall) {
      return { element: element.text, elementType: 'link', action: 'navigate', result: 'error', details: `Redirected to ${finalPath} (auth wall)`, duration_ms: Date.now() - start }
    }

    if (status >= 400) {
      return { element: element.text, elementType: 'link', action: 'navigate', result: 'error', details: `HTTP ${status} at ${linkPath}`, duration_ms: Date.now() - start }
    }

    return { element: element.text, elementType: 'link', action: 'navigate', result: 'navigated', details: `${linkPath} loaded (${status})`, duration_ms: Date.now() - start }
  } catch (err) {
    // Navigate back on error
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})
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

export async function explorePage(
  context: BrowserContext,
  route: string,
  baseUrl: string,
  screenshotsDir: string,
  blocklist?: ActionBlocklist
): Promise<PageExploration> {
  const startTime = Date.now()
  const page = await context.newPage()
  const apiCalls: ApiObservation[] = []
  const errors: string[] = []

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
    if (/\/api\/|\/graphql|\/auth|\/v\d+\//.test(url) || method !== 'GET') {
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

  const fullUrl = new URL(route, baseUrl).href

  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    // Race: networkidle OR interactive elements appear (whichever first)
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}),
      page.waitForFunction(
        () => document.querySelectorAll('button, a, input, [role="button"], [role="tab"]').length > 2,
        { timeout: 5000 }
      ).catch(() => {}),
    ])
  } catch (err) {
    errors.push(`Navigation failed: ${(err as Error).message}`)
    await page.close().catch(() => {})
    return { route, url: fullUrl, elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: apiCalls, errors, duration_ms: Date.now() - startTime }
  }

  // Check for auth redirect
  const currentPath = (() => { try { return new URL(page.url()).pathname } catch { return '' } })()
  if (currentPath !== route && /\/(login|signin|auth)\b/.test(currentPath)) {
    await page.close().catch(() => {})
    return { route, url: fullUrl, elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: apiCalls, errors: [`Redirected to ${currentPath} — authentication may have failed`], duration_ms: Date.now() - startTime }
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

  const interactions: InteractionOutcome[] = []

  const isBlocked = (el: DiscoveredElement) =>
    blocklist?.isBlocked(el.selector, el.text) ?? false

  // ── Phase 1: Tabs (safe, helps reveal content) ──
  const tabs = elements.filter(e => e.type === 'tab' && !e.disabled && !isBlocked(e))
  for (const tab of tabs.slice(0, 12)) {
    interactions.push(await testTab(page, tab))
  }

  // ── Phase 2: Inputs (fill with test data) ──
  const inputs = elements.filter(e => e.type === 'input' && !e.disabled && !isBlocked(e))
  for (const input of inputs.slice(0, 20)) {
    interactions.push(await testInput(page, input))
  }

  // ── Phase 3: Checkboxes / toggles ──
  const checkboxes = elements.filter(e => e.type === 'checkbox' && !e.disabled && !isBlocked(e))
  for (const cb of checkboxes.slice(0, 10)) {
    interactions.push(await testCheckbox(page, cb))
  }

  // ── Phase 4: Buttons (click each, observe response) ──
  const buttons = elements.filter(e => e.type === 'button' && !e.disabled && !isBlocked(e))
  for (const btn of buttons.slice(0, 20)) {
    interactions.push(await testButton(page, btn, fullUrl))
  }

  // ── Phase 5: Links (verify + follow internal ones) ──
  const links = elements.filter(e => e.type === 'link' && !isBlocked(e))
  for (const link of links.slice(0, 12)) {
    interactions.push(await testLink(page, link, fullUrl))
  }

  // Take final screenshot
  await ensureDir(screenshotsDir)
  const screenshotPath = path.join(screenshotsDir, `explore-${route.replace(/\//g, '_').replace(/^_/, '')}.png`)
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true })
  } catch { /* non-critical */ }

  await page.close().catch(() => {})

  return {
    route,
    url: fullUrl,
    elements_discovered: elements.length,
    elements_by_type: elementsByType,
    interactions,
    api_calls: apiCalls,
    errors,
    duration_ms: Date.now() - startTime,
    screenshot_path: screenshotPath,
  }
}

// ─── Multi-page exploration orchestrator ──────────────────────────────────────

export async function exploreAllPages(
  context: BrowserContext,
  routes: string[],
  baseUrl: string,
  screenshotsDir: string,
  blocklist?: ActionBlocklist
): Promise<PageExploration[]> {
  const explorations: PageExploration[] = []

  for (const route of routes) {
    logger.info(`  Exploring: ${route}`)
    try {
      const exploration = await explorePage(context, route, baseUrl, screenshotsDir, blocklist)
      explorations.push(exploration)

      const tested = exploration.interactions.filter(i => i.result !== 'skipped').length
      const passed = exploration.interactions.filter(i => i.result === 'success' || i.result === 'content_updated' || i.result === 'dialog_opened' || i.result === 'navigated' || i.result === 'toast_shown').length
      const failed = exploration.interactions.filter(i => i.result === 'error').length
      const apis = exploration.api_calls.length
      const apiErrors = exploration.api_calls.filter(a => a.isError).length

      logger.dim(`    ${tested} tested, ${passed} working, ${failed} broken, ${apis} API calls${apiErrors > 0 ? ` (${apiErrors} errors)` : ''}`)
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
        duration_ms: 0,
      })
    }
  }

  return explorations
}
