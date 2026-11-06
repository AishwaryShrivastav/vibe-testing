import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorePage } from '../src/engine/browser/explorer.js'
import { judgeTotals, moneyAmounts } from '../src/engine/browser/totals-check.js'
import { collectExplorerFailures } from '../src/engine/findings.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

const block = (totalText: string, lines: string[]) => ({ totalText, lines: [...lines, totalText] })

describe('totals arithmetic', () => {
  it('parses money with symbols, separators, codes and negatives', () => {
    expect(moneyAmounts('Laptop - $1,000.00')).toEqual([1000])
    expect(moneyAmounts('Discount: -$5.00')).toEqual([-5])
    expect(moneyAmounts('Coupon ($2.50)')).toEqual([-2.5])
    expect(moneyAmounts('Total 12.00 EUR')).toEqual([12])
    expect(moneyAmounts('Room 101, 2 guests')).toEqual([])
  })

  it('accepts a total that equals its items', () => {
    expect(judgeTotals(block('Total: $2000.00', ['Laptop - $1000.00', 'Remove', 'Laptop - $1000.00', 'Remove']))).toBeUndefined()
  })

  it('accepts unit price × quantity and listed tax/shipping/discount lines', () => {
    expect(judgeTotals(block('Total: $27.50', [
      'Widget x2 $10.00', 'Gadget $5.00', 'Tax: $2.00', 'Shipping: $3.00', 'Discount: -$2.50',
    ]))).toBeUndefined()
    // The line already shows its line total (unit and line amounts both shown).
    expect(judgeTotals(block('Total: $30.00', ['Widget  Qty: 3  $10.00  $30.00']))).toBeUndefined()
  })

  it('flags a total that differs from its items', () => {
    const mismatch = judgeTotals(block('Total: $2000.00', ['Laptop - $1000.00', 'Remove']))
    expect(mismatch).toMatchObject({ shown: 2000, expected: 1000, basis: '1 item sum to $1000.00' })
  })

  it('flags a non-zero total next to an empty list', () => {
    const mismatch = judgeTotals(block('Total: $1020.00', ['Point of Sale', 'No items in the POS list.', 'Checkout']))
    expect(mismatch?.basis).toBe('the list is empty (page shows "No items in the POS list.")')
  })

  it('does not judge when it cannot be sure', () => {
    // No items and no empty-state message.
    expect(judgeTotals(block('Total: $40.00', ['Your order', 'Checkout']))).toBeUndefined()
    // A banner that mentions shipping is not a charge, and is not summed as an item.
    expect(judgeTotals(block('Total: $20.00', ['Free shipping on all orders over $50 this week only!', 'Book $20.00']))).toBeUndefined()
    // Subtotal matches the items; the total may include fees that aren't listed.
    expect(judgeTotals({ totalText: 'Total: $26.00', lines: ['Book $20.00', 'Subtotal: $20.00', 'Total: $26.00'] })).toBeUndefined()
    // "Total savings" is not the order total.
    expect(judgeTotals(block('Total savings: $5.00', ['Book $20.00']))).toBeUndefined()
  })

  it('flags a subtotal that differs from its items', () => {
    const mismatch = judgeTotals({ totalText: 'Total: $26.00', lines: ['Book $20.00', 'Pen $3.00', 'Subtotal: $20.00', 'Total: $26.00'] })
    expect(mismatch).toMatchObject({ totalLine: 'Subtotal: $20.00', shown: 20, expected: 23 })
  })
})

/**
 * A single-page till. "bad" computes the total once, when the page is opened
 * (like a useEffect with no dependencies); "good" recomputes it on every render.
 */
function till(variant: 'bad' | 'good'): string {
  return page(`
    <nav><a href="/${variant}/products" data-nav>Products</a> <a href="/${variant}/till" data-nav>Till</a></nav>
    <main id="app"></main>
    <script>
      const variant = ${JSON.stringify(variant)}
      const products = [{ id: 1, name: 'Laptop', price: 1000 }, { id: 2, name: 'Mouse', price: 25 }]
      const state = { items: [], openedTotal: null }
      function render(opened) {
        const app = document.getElementById('app')
        const route = location.pathname.split('/')[2]
        if (route === 'products') {
          app.innerHTML = '<h1>Products</h1>' + products.map(p =>
            '<div class="card"><h3>' + p.name + '</h3><p>$' + p.price.toFixed(2) + '</p>' +
            '<button type="button" data-add="' + p.id + '">Add to till</button></div>').join('')
          app.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
            state.items.push(products.find(p => p.id === Number(b.dataset.add)))
          })
        } else if (route === 'till') {
          const sum = state.items.reduce((s, i) => s + i.price, 0)
          if (opened || variant === 'good') state.openedTotal = sum
          app.innerHTML = '<h1>Till</h1>' +
            (state.items.length ? '<ul>' + state.items.map(i => '<li><span>' + i.name + ' - $' + i.price.toFixed(2) + '</span></li>').join('') + '</ul>'
              : '<p>No items in the till.</p>') +
            '<div><strong>Total: $' + state.openedTotal.toFixed(2) + '</strong></div>' +
            '<button type="button" id="pay">Checkout</button>'
          document.getElementById('pay').onclick = () => { state.items = []; render(false) }
        }
        document.querySelectorAll('[data-nav]').forEach(a => a.onclick = e => {
          e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(true)
        })
      }
      render(true)
    </script>`)
}

describe('totals check in the explorer', () => {
  let fx: BrowserFixture
  let shots: string

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/bad/products': till('bad'), '/bad/till': till('bad'),
      '/good/products': till('good'), '/good/till': till('good'),
      '/listing': page(`<h1>Catalogue</h1>
        <div><h3>Laptop</h3><p>$1000.00</p></div><div><h3>Mouse</h3><p>$25.00</p></div>
        <p>Prices include VAT. Free delivery over $50.</p>`),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-totals-'))
  })

  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  async function explore(route: string) {
    const ctx = await fx.browser.newContext()
    try {
      return await explorePage(ctx, route, fx.baseUrl, shots, undefined, { boundaryProbes: false, createChecks: false })
    } finally {
      await ctx.close()
    }
  }

  it('flags a total that stays stale after the list changes (add, then checkout)', async () => {
    const exploration = await explore('/bad/products')
    const mismatches = exploration.errors.filter(e => e.startsWith('Total mismatch'))
    expect(mismatches).toContain(
      'Total mismatch on /bad/till (via in-app navigation) after clicking "Checkout": the list is empty (page shows "No items in the till.") but "Total: $2000.00" is shown')
    expect(collectExplorerFailures([exploration]).some(f => f.includes('Total mismatch'))).toBe(true)
  }, 90_000)

  it('does not flag a total that is recomputed', async () => {
    const exploration = await explore('/good/products')
    expect(exploration.errors.filter(e => e.startsWith('Total mismatch'))).toEqual([])
    expect(exploration.interactions.some(i => i.action === 'journey: totals after action' && i.result === 'success')).toBe(true)
  }, 90_000)

  it('does not judge a listing with prices and no total', async () => {
    const exploration = await explore('/listing')
    expect(exploration.errors.filter(e => e.startsWith('Total mismatch'))).toEqual([])
  }, 90_000)
})
