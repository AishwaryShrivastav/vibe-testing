import type { Page } from 'playwright'
import type { InteractionOutcome } from './explorer.js'
import { findEmptyState } from './page-checks.js'

/**
 * Totals check: a labelled total ("Total: $2000.00", "Amount due", "Grand
 * total") must equal the sum of the line items shown with it. Catches totals
 * computed once and never updated (stale after add/remove/checkout), wrong
 * arithmetic, and totals left over next to an emptied list.
 *
 * Conservative by design — only unambiguous arithmetic is judged:
 * - a page with prices but no labelled total (a product listing) is not judged;
 * - items are read from the closest container around the total, so prices
 *   elsewhere on the page are not summed in;
 * - tax/shipping/discount/fee lines are applied when they are shown as
 *   "Label: amount"; a total with no items and no empty-state text is skipped.
 */

// ── Patterns (sources shared with the browser-side reader) ──────────────────

/** A money amount with a currency marker. Bare numbers (room 101, qty 2) are not money. */
const MONEY = /(?:[$€£¥₹]\s?-?\d[\d,]*(?:\.\d{1,2})?|-?\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|AUD|CAD)\b)/
const MONEY_ALL = new RegExp(MONEY.source, 'g')
/** A total label. "Total savings", "Total items" are not totals of the items. */
const TOTAL_LABEL = /^\s*(?:(?:grand|order|cart|basket|invoice)\s+)?total\b(?!\s+(?:savings?|saved|items?|qty|quantity|count|discount))|\b(?:amount|balance)\s+due\b|\btotal\s+(?:due|price|amount|cost)\b/i
const SUBTOTAL_LABEL = /\bsub-?\s?total\b/i
const ADJUSTMENT_LABEL = /\b(?:tax(?:es)?|vat|gst|hst|shipping|delivery|postage|handling|discount|coupon|promo(?:tion)?|voucher|fees?|service\s+charge|tip|gratuity|surcharge|savings?)\b/i
const NEGATIVE_ADJUSTMENT = /\b(?:discount|coupon|promo(?:tion)?|voucher|savings?)\b/i
const QUANTITY = /(?:\b(?:qty|quantity)\s*:?\s*|(?:^|\s)[x×]\s*)(\d{1,3})\b|\b(\d{1,3})\s*[x×](?=\s|$)/i

const MAX_LINE = 120
const MAX_ITEMS = 25
const TOLERANCE = 0.011

export interface TotalsBlock {
  /** The total's own text, e.g. "Total: $2000.00". */
  totalText: string
  /** Visible lines of the closest container that also holds items or an empty-state message. */
  lines: string[]
}

export interface TotalsMismatch {
  totalLine: string
  shown: number
  expected: number
  /** How the expected value was derived, e.g. "items sum to $1000.00". */
  basis: string
}

// ── Parsing (pure, unit-tested) ────────────────────────────────────────────

/** Numbers of the money amounts in a line ("$1,000.00" → 1000; "($5.00)" / "-$5" → -5). */
export function moneyAmounts(line: string): number[] {
  return [...line.matchAll(MONEY_ALL)].map(match => {
    const raw = match[0]
    // A minus attached to the amount ("-$5.00"), not a separator ("Laptop - $5.00").
    const before = line.slice(0, match.index)
    const negative = /-/.test(raw) || /[-−]$/.test(before) ||
      new RegExp(`\\(\\s*${escapeRegExp(raw)}\\s*\\)`).test(line)
    const value = Number(raw.replace(/[^\d.]/g, ''))
    return negative ? -Math.abs(value) : value
  }).filter(value => Number.isFinite(value))
}

/** "Label: $5.00" / "Label $5.00" — a short line that ends in its amount. */
function isLabelValue(line: string): boolean {
  return line.length <= 60 && new RegExp(`${MONEY.source}\\s*\\)?\\s*$`).test(line)
}

/**
 * Judge one total against the lines around it. Returns a mismatch, or
 * undefined when the arithmetic adds up or can't be judged unambiguously.
 */
export function judgeTotals(block: TotalsBlock): TotalsMismatch | undefined {
  const totalShown = moneyAmounts(block.totalText).at(-1)
  if (totalShown === undefined || !TOTAL_LABEL.test(block.totalText) || SUBTOTAL_LABEL.test(block.totalText)) return undefined

  let subtotal: number | undefined
  const adjustments: number[] = []
  const items: number[][] = []   // candidate values per line item
  let ambiguous = false

  for (const raw of block.lines) {
    const line = raw.trim()
    if (!line || line.length > MAX_LINE) continue
    const amounts = moneyAmounts(line)
    if (amounts.length === 0) continue
    if (line === block.totalText.trim() || TOTAL_LABEL.test(line)) continue
    if (SUBTOTAL_LABEL.test(line)) {
      if (isLabelValue(line)) subtotal = amounts.at(-1)
      else ambiguous = true
      continue
    }
    if (ADJUSTMENT_LABEL.test(line)) {
      // "Free shipping on orders over $50" is a banner, not a charge.
      if (!isLabelValue(line)) continue
      const value = Math.abs(amounts.at(-1)!)
      adjustments.push(NEGATIVE_ADJUSTMENT.test(line) || amounts.at(-1)! < 0 ? -value : value)
      continue
    }
    items.push(itemCandidates(line, amounts))
  }
  if (ambiguous || items.length > MAX_ITEMS) return undefined

  const adjustment = adjustments.reduce((sum, value) => sum + value, 0)
  const money = (value: number) => formatMoney(value, block.totalText)

  if (items.length === 0) {
    // No items: only judge when the page says the list is empty.
    const empty = findEmptyState(block.lines.join('\n'))
    if (!empty || subtotal !== undefined) return undefined
    if (Math.abs(totalShown - adjustment) <= TOLERANCE) return undefined
    if (Math.abs(totalShown) <= TOLERANCE) return undefined
    return {
      totalLine: block.totalText.trim(), shown: totalShown, expected: adjustment,
      basis: `the list is empty (page shows "${empty.slice(0, 60)}")`,
    }
  }

  const sums = possibleSums(items)
  if (subtotal !== undefined) {
    // Items → subtotal is unambiguous; subtotal → total may include unlisted fees.
    if (sums.some(sum => Math.abs(sum - subtotal!) <= TOLERANCE)) return undefined
    return {
      totalLine: block.lines.find(line => SUBTOTAL_LABEL.test(line))?.trim() ?? `Subtotal ${money(subtotal)}`,
      shown: subtotal, expected: sums[0],
      basis: `${items.length} item${items.length > 1 ? 's' : ''} sum to ${money(sums[0])}`,
    }
  }
  if (sums.some(sum => Math.abs(sum + adjustment - totalShown) <= TOLERANCE)) return undefined
  return {
    totalLine: block.totalText.trim(), shown: totalShown, expected: sums[0] + adjustment,
    basis: `${items.length} item${items.length > 1 ? 's' : ''} sum to ${money(sums[0])}` +
      (adjustments.length ? ` plus ${money(adjustment)} in listed charges/discounts` : ''),
  }
}

/** A line item's possible contribution: the line total, or unit price × quantity. */
function itemCandidates(line: string, amounts: number[]): number[] {
  const values = new Set<number>([amounts.at(-1)!])
  const qtyMatch = line.match(QUANTITY)
  const qty = qtyMatch ? Number(qtyMatch[1] ?? qtyMatch[2]) : undefined
  if (qty && qty > 1) values.add(round(amounts[0] * qty))
  return [...values]
}

/** Sums under each reading: every line as shown, every line as unit × qty, and mixes for small lists. */
function possibleSums(items: number[][]): number[] {
  if (items.length <= 8) {
    let sums = [0]
    for (const candidates of items) {
      sums = [...new Set(sums.flatMap(sum => candidates.map(value => round(sum + value))))]
      if (sums.length > 256) break
    }
    return sums
  }
  return [round(items.reduce((sum, c) => sum + c[0], 0)), round(items.reduce((sum, c) => sum + c.at(-1)!, 0))]
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function formatMoney(value: number, like: string): string {
  const symbol = like.match(/[$€£¥₹]/)?.[0]
  const code = like.match(/\b(USD|EUR|GBP|INR|AUD|CAD)\b/)?.[0]
  const fixed = Math.abs(value).toFixed(2)
  const sign = value < 0 ? '-' : ''
  return symbol ? `${sign}${symbol}${fixed}` : code ? `${sign}${fixed} ${code}` : `${sign}${fixed}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Reading the page ───────────────────────────────────────────────────────

/**
 * Every visible labelled total with the lines of its closest container that
 * also holds money lines or an empty-state message (climbing at most 6 levels).
 */
export async function readTotalsBlocks(page: Page): Promise<TotalsBlock[]> {
  return await page.evaluate(({ total, money, subtotal }) => {
    const TOTAL = new RegExp(total, 'i')
    const MONEY_RE = new RegExp(money)
    const SUB = new RegExp(subtotal, 'i')
    const EMPTY = /\b(?:no|0)\s+(?:\w+\s+)?(?:items?|results?|products?|records?|entries|orders?|rows?)\b|\b(?:is|are)\s+empty\b|\bempty\s+(?:cart|list|basket|bag)\b/i
    const visible = (el: Element) => {
      const rects = (el as HTMLElement).getClientRects()
      return rects.length > 0 && getComputedStyle(el as HTMLElement).visibility !== 'hidden'
    }
    const textOf = (el: Element) => ((el as HTMLElement).innerText ?? '').trim()
    const isTotal = (text: string) => text.length > 0 && text.length <= 60 && TOTAL.test(text) && MONEY_RE.test(text) && !SUB.test(text)

    const totals = Array.from(document.body.querySelectorAll('*')).filter(el => {
      if (!visible(el)) return false
      const text = textOf(el)
      if (!isTotal(text)) return false
      // The deepest element holding both label and amount.
      return !Array.from(el.children).some(child => isTotal(textOf(child)))
    }).slice(0, 5)

    const blocks: Array<{ totalText: string; lines: string[] }> = []
    for (const el of totals) {
      const totalText = textOf(el).replace(/\s+/g, ' ')
      let container = el.parentElement
      for (let level = 0; container && container !== document.documentElement && level < 6; level++) {
        const lines = textOf(container).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
        const others = lines.filter(line => line !== totalText && MONEY_RE.test(line) && !TOTAL.test(line))
        if (others.length > 0 || lines.some(line => line.length <= 100 && EMPTY.test(line))) {
          blocks.push({ totalText, lines })
          break
        }
        container = container.parentElement
      }
    }
    return blocks
  }, { total: TOTAL_LABEL.source, money: MONEY.source, subtotal: SUBTOTAL_LABEL.source }).catch(() => [])
}

/**
 * On a page that shows a total, click its actions (up to `maxClicks`, skipping
 * ones `canClick` rejects) and re-check the total after each: a total computed
 * once goes stale when the list changes (checkout, quantity +/-).
 */
export async function exerciseTotalActions(
  page: Page,
  tracker: TotalsTracker,
  where: string,
  canClick: (label: string) => boolean,
  maxClicks = 3,
): Promise<InteractionOutcome[]> {
  if (!await tracker.hasTotal(page)) return []
  const outcomes: InteractionOutcome[] = []
  const startUrl = page.url()
  const labels = [...new Set((await page.getByRole('button').evaluateAll(buttons => buttons
    .filter(button => (button as HTMLElement).getClientRects().length > 0 && !(button as HTMLButtonElement).disabled)
    .map(button => ((button as HTMLElement).innerText || button.getAttribute('aria-label') || '').trim())
  ).catch(() => [] as string[])).filter(label => label && label.length <= 40 && canClick(label)))].slice(0, maxClicks)

  for (const label of labels) {
    const start = Date.now()
    const button = page.getByRole('button', { name: label, exact: true }).first()
    if (!await button.isVisible().catch(() => false)) continue
    try {
      await button.click({ timeout: 3000 })
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(300)
      const mismatch = await tracker.check(page, `${where} after clicking "${label}"`)
      outcomes.push({
        element: label, elementType: 'button', action: 'journey: totals after action',
        result: mismatch ? 'error' : 'success',
        details: mismatch ? tracker.findings.at(-1)! : 'Total still matches its items',
        duration_ms: Date.now() - start,
      })
    } catch (err) {
      outcomes.push({ element: label, elementType: 'button', action: 'journey: totals after action', result: 'skipped', details: `Could not click: ${(err as Error).message.slice(0, 80)}`, duration_ms: Date.now() - start })
    }
    if (page.url() !== startUrl) break
  }
  return outcomes
}

/** Collects total mismatches across an exploration, one finding per total line and state. */
export class TotalsTracker {
  readonly findings: string[] = []
  private readonly seen = new Set<string>()

  /** Check every total on the page; `where` names the page and the state ("after clicking …"). */
  async check(page: Page, where: string): Promise<boolean> {
    let found = false
    for (const block of await readTotalsBlocks(page)) {
      const mismatch = judgeTotals(block)
      if (!mismatch) continue
      const key = `${mismatch.totalLine}|${mismatch.basis}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      found = true
      this.findings.push(`Total mismatch on ${where}: ${mismatch.basis} but "${mismatch.totalLine}" is shown`)
    }
    return found
  }

  /** True when the page shows at least one labelled total. */
  async hasTotal(page: Page): Promise<boolean> {
    return (await readTotalsBlocks(page)).length > 0
  }
}
