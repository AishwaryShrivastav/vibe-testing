import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { fillLoginForm, locateLoginFields } from '../src/engine/browser/login-form.js'
import { performLogin } from '../src/engine/browser/auth.js'
import { identityKind } from '../src/utils/login-fields.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/** A login form that navigates to /dashboard when the identity and password match. */
function loginPage(identityInput: string, expected: string, extra = ''): string {
  return page(`
    ${extra}
    <form id="f">
      ${identityInput}
      <input type="password" name="pw" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', e => {
        e.preventDefault()
        const id = document.querySelector('[data-id]').value
        const pw = document.querySelector('[name=pw]').value
        location.href = id === ${JSON.stringify(expected)} && pw === 'secret' ? '/dashboard' : '/login?error=1'
      })
    </script>`)
}

describe('identityKind (login field text)', () => {
  it.each([
    ['email', 'email'], ['E-mail address', 'email'],
    ['phoneNumber', 'phone'], ['Mobile number', 'phone'], ['tel', 'phone'], ['msisdn', 'phone'],
    ['employeeId', 'id-number'], ['Customer number', 'id-number'], ['member_no', 'id-number'],
    ['userId', 'id-number'], ['loginId', 'id-number'], ['Account number', 'id-number'],
    ['userName', 'username'], ['login', 'username'], ['identifier', 'username'],
  ])('"%s" → %s', (text, kind) => {
    expect(identityKind(text)).toBe(kind)
  })

  it.each(['password', 'Account password', 'firstName', 'search', 'otp', 'Verification code'])(
    '"%s" is not an identity field', text => {
      expect(identityKind(text)).toBeUndefined()
    })
})

describe('locateLoginFields / fillLoginForm on real login pages', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      // NodeGoat-style username field (regression: login tool only knew email selectors)
      '/username': loginPage('<input type="text" id="userName" name="userName" placeholder="Enter User Name" data-id>', 'user1'),
      '/phone': loginPage('<input type="tel" name="phoneNumber" placeholder="Phone" data-id>', '+15551234567'),
      '/mobile-label': loginPage('<label for="m">Mobile number</label><input id="m" data-id>', '9876543210'),
      '/employee': loginPage('<input name="employeeId" placeholder="Employee ID" data-id>', 'E-1042'),
      '/autocomplete': loginPage('<input name="f1" autocomplete="username" data-id>', 'alice'),
      // Unrecognisable label: falls back to the input right before the password in the same form.
      '/positional': loginPage(
        '<label for="k">Mitarbeiterkennung</label><input id="k" data-id>', 'mk-7',
        '<input type="search" placeholder="Search the site">',
      ),
      // Hidden honeypot email must be ignored.
      '/honeypot': loginPage(
        '<input type="email" name="email" style="display:none"><input name="username" data-id>', 'bob',
      ),
      // Configured hint picks the phone field even though an email field is present.
      '/both': page(`
        <form>
          <input type="email" name="email">
          <input type="tel" name="mobile" id="mobile">
          <input type="password" name="pw">
          <button type="submit">Log in</button>
        </form>`),
      // Identifier-first, two-step flow.
      '/two-step': page(`
        <form id="f">
          <input name="identifier" placeholder="Email or phone">
          <div id="step2" style="display:none"><input type="password" name="pw"></div>
          <button type="submit" id="go">Next</button>
        </form>
        <script>
          document.getElementById('f').addEventListener('submit', e => {
            e.preventDefault()
            const step2 = document.getElementById('step2')
            if (step2.style.display === 'none') { step2.style.display = 'block'; return }
            const ok = document.querySelector('[name=identifier]').value === '+447700900123' &&
              document.querySelector('[name=pw]').value === 'secret'
            location.href = ok ? '/dashboard' : '/login?error=1'
          })
        </script>`),
      '/no-identity': page('<form><input type="checkbox" name="remember"><button>Go</button></form>'),
      '/dashboard': page('<h1>Dashboard</h1>'),
      '/login': page('<h1>Login failed</h1>'),
    })
  })

  afterAll(async () => { await fx?.close() })

  async function withPage<T>(path: string, run: (p: Page) => Promise<T>): Promise<T> {
    const ctx = await fx.browser.newContext()
    const p = await ctx.newPage()
    try {
      await p.goto(fx.baseUrl + path)
      return await run(p)
    } finally {
      await ctx.close()
    }
  }

  it.each([
    ['/username', 'user1', 'username'],
    ['/phone', '+15551234567', 'phone'],
    ['/mobile-label', '9876543210', 'phone'],
    ['/employee', 'E-1042', 'id-number'],
    ['/autocomplete', 'alice', 'username'],
    ['/positional', 'mk-7', 'positional'],
    ['/honeypot', 'bob', 'username'],
  ])('%s: fills the identifier and signs in', async (path, identity, kind) => {
    await withPage(path, async p => {
      const result = await fillLoginForm(p, { identity, password: 'secret' })
      expect(result.identityKind).toBe(kind)
      await p.waitForURL(/\/dashboard$/, { timeout: 5000 })
    })
  }, 30_000)

  it('lets a configured field name win over other identity fields', async () => {
    await withPage('/both', async p => {
      const fields = await locateLoginFields(p, { identityField: 'mobile' })
      expect(await fields.identity!.getAttribute('name')).toBe('mobile')
      const auto = await locateLoginFields(p)
      expect(await auto.identity!.getAttribute('name')).toBe('email')
    })
  }, 30_000)

  it('handles identifier-first forms that reveal the password after Next', async () => {
    await withPage('/two-step', async p => {
      const result = await fillLoginForm(p, { identity: '+447700900123', password: 'secret' })
      expect(result.multiStep).toBe(true)
      await p.waitForURL(/\/dashboard$/, { timeout: 5000 })
    })
  }, 30_000)

  it('explains which inputs were visible when no identifier field exists', async () => {
    await withPage('/no-identity', async p => {
      await expect(fillLoginForm(p, { identity: 'x', password: 'y' }))
        .rejects.toThrow(/No login identifier field.*checkbox "remember"/)
    })
  }, 30_000)

  it('performLogin signs in with a phone number and no field configuration', async () => {
    const ctx = await fx.browser.newContext()
    try {
      const ok = await performLogin(ctx, fx.baseUrl, {
        strategy: 'credentials',
        login_url: '/phone',
        credentials: { email: '+15551234567', password: 'secret' },
      })
      expect(ok).toBe(true)
    } finally {
      await ctx.close()
    }
  }, 30_000)
})
