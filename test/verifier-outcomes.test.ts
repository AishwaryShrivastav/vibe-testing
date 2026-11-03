import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestScenario, TestStep } from '../src/types/index.js'
import { expectsErrorOutcome, verifyResult } from '../src/engine/browser/verifier.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

const loginSteps: TestStep[] = [
  { action: 'navigate', url: '/login', description: 'Navigate to /login' },
  { action: 'fill', selector: '#username', value: 'admin', description: 'Fill username with "admin"' },
  { action: 'fill', selector: '#password', value: '1234', description: 'Fill password with "1234"' },
  { action: 'click', selector: 'button[type="submit"]', description: 'Submit login form' },
  // Exactly what the scenario generator emits as the final step:
  { action: 'assert', description: 'Login succeeded — no errors, page indicates success' },
]

function scenario(overrides: Partial<TestScenario>): TestScenario {
  return {
    id: 't', name: 'Login with saved credentials', route: '/login', priority: 'high',
    steps: loginSteps, expected_outcome: 'Login succeeded — no errors, page indicates success',
    is_gap: false, generated_by: 'heuristic', ...overrides,
  }
}

describe('expectsErrorOutcome', () => {
  it.each([
    'Login succeeded — no errors, page indicates success',
    'Saved without errors',
    'Form submits with zero validation errors',
    'Checkout is error-free',
    'Page loads',
  ])('does NOT expect an error for "%s"', outcome => {
    expect(expectsErrorOutcome({ name: 'Submit form', expected_outcome: outcome })).toBe(false)
  })

  it.each([
    'Shows error toast',
    'Shows form validation error',
    'Displays validation messages',
    'Errors are listed under each field',
  ])('expects an error for "%s"', outcome => {
    expect(expectsErrorOutcome({ name: 'Submit form', expected_outcome: outcome })).toBe(true)
  })

  it('expects an error when the scenario name says invalid or empty input', () => {
    expect(expectsErrorOutcome({ name: 'Login with invalid password', expected_outcome: 'x' })).toBe(true)
    expect(expectsErrorOutcome({ name: 'Submit empty form', expected_outcome: 'x' })).toBe(true)
  })
})

describe('verifyResult on real pages', () => {
  let fx: BrowserFixture
  const content = '<p>Some descriptive text so the page clearly has rendered content for the verifier.</p>'

  beforeAll(async () => {
    fx = await startBrowserFixture({
      // Failed login: stays on /login with a plain inline error (no role="alert")
      '/login': page(`<h2>Login</h2>${content}<form><input id="username"><input id="password" type="password">
        <p style="color:red">Invalid credentials</p><button type="submit">Log In</button></form>`),
      '/login-alert': page(`<h2>Login</h2>${content}<div role="alert">Invalid password</div>`),
      '/products': page(`<h1>Products</h1>${content}`),
      '/blank': page(''),
      '/broken': page('<h1>404 Not Found</h1><p>The page you requested does not exist on this server.</p>'),
      '/dashboard': page(`<h1>Dashboard</h1>${content}`),
    })
  })

  afterAll(async () => { await fx?.close() })

  async function verifyAt(path: string, sc: TestScenario) {
    const p = await fx.browser.newPage()
    try {
      await p.goto(fx.baseUrl + path)
      return await verifyResult(p, sc, '', fx.baseUrl + sc.route)
    } finally {
      await p.close()
    }
  }

  it('FAILS a login that stays on /login with an inline error (regression: was reported as passed)', async () => {
    const r = await verifyAt('/login', scenario({}))
    expect(r.passed).toBe(false)
    expect(r.explanation).toMatch(/stayed on \/login/)
  })

  it('passes a login that navigates away to the app', async () => {
    const r = await verifyAt('/products', scenario({}))
    expect(r.passed).toBe(true)
  })

  it('passes a negative login test when the expected error alert is shown', async () => {
    const r = await verifyAt('/login-alert', scenario({
      name: 'Login with invalid password', route: '/login-alert', expected_outcome: 'Shows error message',
    }))
    expect(r.passed).toBe(true)
  })

  it('fails an authenticated scenario that ended up on the login page', async () => {
    const r = await verifyAt('/login', scenario({
      name: '/dashboard accessible when authenticated', route: '/dashboard', requires_auth: true,
      steps: [{ action: 'navigate', url: '/dashboard', description: 'Open dashboard' }],
      expected_outcome: 'Dashboard renders',
    }))
    expect(r.passed).toBe(false)
    expect(r.explanation).toMatch(/Authentication failed/)
  })

  it('fails a "page loads" smoke test on a blank page or a 404 page', async () => {
    const smoke = (route: string) => scenario({
      name: `${route} page loads successfully`, route,
      steps: [{ action: 'navigate', url: route, description: `Open ${route}` }],
      expected_outcome: 'Page renders',
    })
    expect((await verifyAt('/blank', smoke('/blank'))).passed).toBe(false)
    expect((await verifyAt('/broken', smoke('/broken'))).passed).toBe(false)
    expect((await verifyAt('/dashboard', smoke('/dashboard'))).passed).toBe(true)
  })

  it('checks "redirects to login" scenarios', async () => {
    const redirect = scenario({
      name: '/dashboard redirects to login when unauthenticated', route: '/dashboard',
      steps: [{ action: 'navigate', url: '/dashboard', description: 'Open /dashboard' }],
      expected_outcome: 'Redirected to login page',
    })
    expect((await verifyAt('/login', redirect)).passed).toBe(true)
    // Protected page rendered without any auth gate → the redirect never happened
    expect((await verifyAt('/dashboard', redirect)).passed).toBe(false)
  })
})
