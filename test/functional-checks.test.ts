import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorePage } from '../src/engine/browser/explorer.js'
import { findBrokenValues, findEmptyState, newSuccessLines } from '../src/engine/browser/page-checks.js'
import { checkLogoutRoundTrip } from '../src/engine/browser/session-checks.js'
import { runOneScenario } from '../src/engine/browser/runner.js'
import { collectExplorerFailures, collectExplorerWarnings } from '../src/engine/index.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

describe('page-check rules', () => {
  it('finds values that only appear when rendering broke, not prose', () => {
    const { broken } = findBrokenValues([
      'Total: $NaN', 'Owner: [object Object]', 'Due Invalid Date', 'Name: undefined', 'Hello {{user.name}}',
      'In JavaScript, NaN is a special value that represents something that is not a number at all.',
      'The behaviour of this function is undefined when the input array is empty, so check first.',
      'Try the template {{7*7}} in the playground',
    ].join('\n'))
    expect(broken).toEqual(['Total: $NaN', 'Owner: [object Object]', 'Due Invalid Date', 'Name: undefined', 'Hello {{user.name}}'])
  })

  it('reports label placeholders separately, without matching sentences', () => {
    const { placeholders, broken } = findBrokenValues('Category: Unknown\nStatus: N/A\nAn unknown error occurred\nUnknown')
    expect(placeholders).toEqual(['Category: Unknown', 'Status: N/A'])
    expect(broken).toEqual([])
  })

  it('recognises empty states and new success messages', () => {
    expect(findEmptyState('Point of Sale\nNo items in the POS list.\nTotal: $0')).toBe('No items in the POS list.')
    expect(findEmptyState('Your cart is empty')).toBe('Your cart is empty')
    expect(findEmptyState('3 items in your cart')).toBeUndefined()
    expect(newSuccessLines('Cart\nNo items', 'Cart\nNo items\nCheckout successful!')).toEqual(['Checkout successful!'])
    expect(newSuccessLines('Cart', 'Cart\nCheckout failed: cart is empty')).toEqual([])
  })

  it('groups the same failure seen on several pages into one line', () => {
    const base = { url: '', elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: [], duration_ms: 0 }
    const broken = 'Broken resource: 404 script /app.js'
    expect(collectExplorerFailures([
      { ...base, route: '/a', errors: [broken, 'Navigation failed: timeout'] },
      { ...base, route: '/b', errors: [broken] },
      { ...base, route: '/c', errors: [broken, 'Console error: boom'] },
    ])).toEqual([
      '/a (+2 more pages): Broken resource: 404 script /app.js',
      '/c: Console error: boom',
    ])
  })

  it('merges the same placeholder seen from several explored pages', () => {
    const base = { url: '', elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: [], errors: [], duration_ms: 0 }
    expect(collectExplorerWarnings([
      { ...base, route: '/products', warnings: ['Placeholder value on /products: "Category: Unknown"'] },
      { ...base, route: '/pos', warnings: ['Placeholder value on /products (via in-app navigation): "Category: Unknown"'] },
    ])).toEqual(['Placeholder value on /products: "Category: Unknown"'])
  })
})

/**
 * A tiny single-page shop. `variant` "bad" carries the bug patterns
 * (duplicate keys on repeated add, a stale category list, checkout that
 * succeeds on an empty cart, a missing category); "good" behaves correctly.
 */
function shop(variant: 'bad' | 'good'): string {
  return page(`
    <nav>
      <a href="/${variant}/shop" data-nav>Shop</a>
      <a href="/${variant}/cart" data-nav>Cart</a>
      <a href="/${variant}/categories" data-nav>Categories</a>
    </nav>
    <main id="app"></main>
    <script>
      const variant = ${JSON.stringify(variant)}
      const state = { cart: [], categories: ['Tools'], shownCategories: ['Tools'], message: '' }
      const products = [{ id: 'p1', name: 'Hammer', category: variant === 'bad' ? null : 'Tools' }, { id: 'p2', name: 'Saw', category: 'Tools' }]
      function render() {
        const app = document.getElementById('app')
        const route = location.pathname.split('/')[2]
        if (route === 'shop') {
          app.innerHTML = '<h1>Shop</h1>' + products.map(p =>
            '<div><span>' + p.name + '</span><p>Category: ' + (p.category || 'Unknown') + '</p>' +
            '<button type="button" data-add="' + p.id + '">Add to cart</button></div>').join('')
          app.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
            const product = products.find(p => p.id === b.dataset.add)
            if (variant === 'bad' || !state.cart.some(item => item.id === product.id)) state.cart.push(product)
          })
        } else if (route === 'cart') {
          const ids = state.cart.map(item => item.id)
          const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
          if (duplicate) console.error('Warning: Encountered two children with the same key, \`%s\`.', duplicate)
          app.innerHTML = '<h1>Cart</h1>' + (state.cart.length ? state.cart.map(i => '<p>' + i.name + '</p>').join('') : '<p>No items in your cart.</p>') +
            '<button type="button" id="checkout">Checkout</button><p id="msg">' + state.message + '</p>'
          document.getElementById('checkout').onclick = () => {
            state.message = variant === 'bad' || state.cart.length ? 'Checkout successful!' : 'Checkout failed: your cart is empty.'
            render()
          }
        } else if (route === 'categories') {
          const list = variant === 'bad' ? state.shownCategories : state.categories
          app.innerHTML = '<h1>Categories</h1><ul>' + list.map(c => '<li>' + c + '</li>').join('') + '</ul>' +
            '<form id="f"><label for="cat">Add Category</label><input id="cat"><button type="submit">Save Category</button></form>'
          document.getElementById('f').onsubmit = e => {
            e.preventDefault()
            const input = document.getElementById('cat')
            if (!input.value.trim()) return
            state.categories.push(input.value.trim())
            input.value = ''
            if (variant === 'good') render()
          }
        }
        document.querySelectorAll('[data-nav]').forEach(a => a.onclick = e => {
          e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render()
        })
      }
      render()
    </script>`)
}

/**
 * Login + protected home page with a logout control; "bad" logout keeps the
 * session. "icon" logs out correctly but its visible control is an icon-font
 * link (a CSS glyph joins its accessible name) after a hidden duplicate in a
 * closed menu — both made the control impossible to find before.
 */
function session(variant: 'bad' | 'good' | 'icon', route: 'login' | 'home'): string {
  if (variant === 'icon' && route === 'home') {
    return page(`<style>.ic::before { content: "\\2716  "; } .menu { display: none; }</style>
      <div class="menu"><a href="#" id="hidden-out">Log Out</a></div>
      <h1>Home</h1><p>Welcome back, this is the signed-in area.</p><a href="#" class="ic" id="out">Logout</a>
      <script>
        if (!localStorage.getItem('auth-icon')) location.href = '/icon/login'
        document.getElementById('out').onclick = e => { e.preventDefault(); localStorage.removeItem('auth-icon'); location.href = '/icon/login' }
      </script>`)
  }
  if (route === 'login') {
    return page(`<form id="f"><input name="username"><input type="password" name="password"><button type="submit">Log in</button></form>
      <script>document.getElementById('f').onsubmit = e => { e.preventDefault(); localStorage.setItem('auth-${variant}', '1'); location.href = '/${variant}/home' }</script>`)
  }
  return page(`<h1>Home</h1><p>Welcome back, this is the signed-in area.</p><button type="button" id="out">Log out</button>
    <script>
      if (!localStorage.getItem('auth-${variant}')) location.href = '/${variant}/login'
      document.getElementById('out').onclick = () => {
        ${variant === 'good' ? `localStorage.removeItem('auth-${variant}')` : ''}
        location.href = '/${variant}/login'
      }
    </script>`)
}

describe('functional checks against real pages', () => {
  let fx: BrowserFixture
  let shots: string

  beforeAll(async () => {
    const pages: Record<string, string> = {}
    for (const variant of ['bad', 'good'] as const) {
      for (const route of ['shop', 'cart', 'categories']) pages[`/${variant}/${route}`] = shop(variant)
      pages[`/${variant}/login`] = session(variant, 'login')
      pages[`/${variant}/home`] = session(variant, 'home')
    }
    pages['/icon/login'] = session('icon', 'login')
    pages['/icon/home'] = session('icon', 'home')
    pages['/signin-only'] = page('<form><label>Email<input type="email"></label><button>Sign in</button></form>')
    pages['/resources'] = page('<h1>Gallery</h1><img src="/missing.png" alt="x"><script src="http://127.0.0.1:59999/dev-tool.js"></script>')
    fx = await startBrowserFixture(pages)
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-functional-'))
  })

  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  async function explore(route: string) {
    const ctx = await fx.browser.newContext()
    try {
      return await explorePage(ctx, route, fx.baseUrl, shots, undefined, { boundaryProbes: false })
    } finally {
      await ctx.close()
    }
  }

  it('B5-style: repeated add + in-app navigation surfaces a console error with its real value', async () => {
    const exploration = await explore('/bad/shop')
    expect(exploration.errors).toContain('Console error: Warning: Encountered two children with the same key, `p1`.')
  }, 90_000)

  it('B6-style: a "Category: Unknown" placeholder is a warning', async () => {
    const exploration = await explore('/bad/shop')
    expect(exploration.warnings).toContain('Placeholder value on /bad/shop: "Category: Unknown"')
  }, 90_000)

  it('B7-style: checkout that succeeds on an empty cart is flagged', async () => {
    const exploration = await explore('/bad/cart')
    expect(exploration.errors.some(e => /Empty-state action: clicking "Checkout" while the page showed "No items in your cart\." reported "Checkout successful!"/.test(e))).toBe(true)
  }, 90_000)

  it('B3-style: a created value that never appears is flagged', async () => {
    const exploration = await explore('/bad/categories')
    expect(exploration.errors.some(e => /Submitted value not shown: the form accepted "vibe-\w+" in Add Category/.test(e))).toBe(true)
  }, 90_000)

  it('raises none of these on the healthy variant', async () => {
    for (const route of ['/good/shop', '/good/cart', '/good/categories']) {
      const exploration = await explore(route)
      expect(exploration.errors, route).toEqual([])
      expect(exploration.warnings, route).toEqual([])
    }
  }, 180_000)

  it('reports a same-origin 404 image as broken and an unreachable cross-origin script as a warning', async () => {
    const exploration = await explore('/resources')
    expect(exploration.errors).toContain('Broken resource: 404 image /missing.png')
    expect(exploration.warnings?.some(w => /^Resource unavailable: script http:\/\/127\.0\.0\.1:59999\/dev-tool\.js \(net::ERR_[A-Z_]+\)$/.test(w))).toBe(true)
    expect(exploration.errors.some(e => /Failed to load resource/.test(e))).toBe(false)
  }, 60_000)

  async function logout(variant: 'bad' | 'good' | 'icon') {
    const config = VibeConfigSchema.parse({
      url: fx.baseUrl,
      auth: { strategy: 'credentials', login_url: `/${variant}/login`, credentials: { email: 'u', password: 'p' } },
      browser: { headed: false, slowMo: 0 },
    })
    return checkLogoutRoundTrip(fx.browser, config, `/${variant}/home`, shots)
  }

  it('B2-style: a logout that keeps the session fails the round-trip', async () => {
    const result = await logout('bad')
    expect(result).toMatchObject({ status: 'fail', scenario: { name: 'Logout ends the session' } })
    expect(result?.ai_verdict).toMatch(/Logout does not end the session: after "Log out".*\/bad\/home still opened without signing in/)
  }, 90_000)

  it('passes the round-trip when logout really ends the session', async () => {
    expect(await logout('good')).toMatchObject({ status: 'pass' })
  }, 90_000)

  it('finds an icon-font logout link even when a hidden duplicate comes first', async () => {
    expect(await logout('icon')).toMatchObject({ status: 'pass' })
  }, 90_000)

  it('treats a short page that rendered a form as loaded, not inconclusive', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const scenario: TestScenario = {
        id: 'short', name: '/signin-only page loads successfully', route: '/signin-only', priority: 'high',
        steps: [{ action: 'navigate', url: '/signin-only', description: 'Open' }, { action: 'wait', value: '50', description: 'Settle' }],
        expected_outcome: 'Page loads', is_gap: true, generated_by: 'heuristic',
      }
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, browser: { headed: false, slowMo: 0 } })
      const result = await runOneScenario(scenario, ctx, config, shots, shots)
      expect(result.status).toBe('pass')
      expect(result.ai_verdict).not.toMatch(/Could not determine/)
    } finally {
      await ctx.close()
    }
  }, 60_000)
})
