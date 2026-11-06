import { afterAll, beforeAll, describe, expect, it, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { interpolateConfig, interpolateEnv } from '../src/utils/env.js'
import { isIdentityField, isPasswordField } from '../src/utils/login-fields.js'
import { isStillOnLoginPage, performLogin } from '../src/engine/browser/auth.js'
import { MemoryManager } from '../src/engine/memory/index.js'
import type { TestResult, TestStep } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

describe('interpolateEnv (secrets in vibe.config.json)', () => {
  afterEach(() => {
    delete process.env.VT_USER
    delete process.env.VT_PASS
  })

  it('replaces ${VAR} placeholders with environment values', () => {
    process.env.VT_USER = 'qa@example.com'
    process.env.VT_PASS = 's3cret'
    expect(interpolateEnv('${VT_USER}')).toBe('qa@example.com')
    expect(interpolateEnv('user=${VT_USER};pass=${VT_PASS}')).toBe('user=qa@example.com;pass=s3cret')
  })

  it('leaves strings without placeholders untouched', () => {
    expect(interpolateEnv('plain-password')).toBe('plain-password')
  })

  it('throws a clear error naming the missing variable instead of using an empty password', () => {
    expect(() => interpolateEnv('${VT_MISSING_SECRET}')).toThrow('Missing env var: VT_MISSING_SECRET')
  })

  it('interpolates nested config objects and leaves non-strings alone', () => {
    process.env.VT_PASS = 's3cret'
    const out = interpolateConfig({ auth: { credentials: { email: 'a@b.c', password: '${VT_PASS}' } }, retries: 2 })
    expect(out).toEqual({ auth: { credentials: { email: 'a@b.c', password: 's3cret' } }, retries: 2 })
  })
})

describe('login field recognition', () => {
  it.each(['password', 'Password', 'confirmPassword', 'new_password', 'passwd', 'passcode', 'Pass'])(
    '"%s" is a password field', t => {
      expect(isPasswordField(t)).toBe(true)
      expect(isIdentityField(t)).toBe(false)
    })

  it.each(['email', 'E-mail', 'username', 'userName', 'login', 'Account', 'identifier'])(
    '"%s" is an identity field', t => {
      expect(isIdentityField(t)).toBe(true)
    })

  it.each(['bypass', 'passport', 'firstName', 'search', 'Account password'])(
    '"%s" is not an identity field', t => {
      expect(isIdentityField(t)).toBe(false)
    })
})

describe('isStillOnLoginPage', () => {
  it.each([
    'http://localhost:3000/login', 'http://localhost:3000/auth/login?next=/x',
    'http://localhost:3000/sign-in', 'http://localhost:3000/signin', 'http://localhost:3000/auth',
  ])('%s → still on login', url => {
    expect(isStillOnLoginPage(url)).toBe(true)
  })

  it.each([
    'http://localhost:3000/dashboard',
    'https://auth.example.com/dashboard',       // host contains "auth" (regression)
    'https://login.example.com/home',           // host contains "login" (regression)
    'http://localhost:3000/authors/42',
    'http://localhost:3000/oauth/callback-done',
  ])('%s → logged in', url => {
    expect(isStillOnLoginPage(url)).toBe(false)
  })
})

describe('performLogin on a real login page', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/login': page(`
        <form id="f">
          <input id="username" placeholder="Username">
          <input id="password" type="password" placeholder="Password">
          <button type="submit">Log In</button>
        </form>
        <p id="err"></p>
        <script>
          document.getElementById('f').addEventListener('submit', e => {
            e.preventDefault()
            const ok = document.getElementById('username').value === 'admin' &&
                       document.getElementById('password').value === '1234'
            if (ok) location.href = '/dashboard'
            else document.getElementById('err').textContent = 'Invalid credentials'
          })
        </script>`),
      '/dashboard': page('<h1>Dashboard</h1>'),
    })
  })

  afterAll(async () => { await fx?.close() })

  const auth = (password: string) => ({
    strategy: 'credentials' as const,
    login_url: '/login',
    fields: { email: 'username', password: 'password' },
    credentials: { email: 'admin', password },
  })

  it('logs in using the configured field names and reports success', async () => {
    const ctx = await fx.browser.newContext()
    try {
      expect(await performLogin(ctx, fx.baseUrl, auth('1234'))).toBe(true)
    } finally {
      await ctx.close()
    }
  }, 30_000)

  it('reports failure when the app rejects the credentials', async () => {
    const ctx = await fx.browser.newContext()
    try {
      expect(await performLogin(ctx, fx.baseUrl, auth('wrong'))).toBe(false)
    } finally {
      await ctx.close()
    }
  }, 30_000)

  it('skips the form entirely for strategy "skip" and missing credentials', async () => {
    const ctx = await fx.browser.newContext()
    try {
      expect(await performLogin(ctx, fx.baseUrl, { strategy: 'skip' })).toBe(true)
      expect(await performLogin(ctx, fx.baseUrl, { strategy: 'credentials' })).toBe(true)
      expect(ctx.pages()).toHaveLength(0)
    } finally {
      await ctx.close()
    }
  })
})

describe('MemoryManager remembers working credentials', () => {
  async function remembered(steps: TestStep[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-memory-'))
    try {
      const memory = new MemoryManager(dir)
      await memory.load()
      const result: TestResult = {
        scenario: {
          id: 'login', name: 'Login with saved credentials', route: '/login', priority: 'high',
          steps, expected_outcome: 'Logged in', is_gap: false, generated_by: 'heuristic',
        },
        status: 'pass', duration_ms: 10, current_url: 'http://localhost:5173/products', step_logs: [],
      }
      await memory.updateFromResults([result])
      return memory.getRecommendations().saved_credentials
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  const submit: TestStep = { action: 'click', selector: 'button[type="submit"]', description: 'Submit login form' }

  it('saves credentials from an email login', async () => {
    const creds = await remembered([
      { action: 'fill', selector: '[name="email"]', value: 'qa@example.com', description: 'Fill email with "qa@example.com"' },
      { action: 'fill', selector: '[name="password"]', value: 'pw', description: 'Fill password with "pw"' },
      submit,
    ])
    expect(creds).toMatchObject({ email: 'qa@example.com', password: 'pw' })
  })

  it('saves credentials from a USERNAME login (regression: only "email" steps were recognised)', async () => {
    const creds = await remembered([
      { action: 'fill', selector: 'placeholder=admin', value: 'admin', description: 'Fill username with "admin"' },
      { action: 'fill', selector: 'placeholder=1234', value: '1234', description: 'Fill password with "1234"' },
      submit,
    ])
    expect(creds).toMatchObject({ email: 'admin', password: '1234' })
  })

  it('is not fooled by a typed value that contains "pass"', async () => {
    const creds = await remembered([
      { action: 'fill', selector: '#email', value: 'pass@example.com', description: 'Fill email with "pass@example.com"' },
      { action: 'fill', selector: '#password', value: 'pw', description: 'Fill password with "pw"' },
      submit,
    ])
    expect(creds).toMatchObject({ email: 'pass@example.com', password: 'pw' })
  })
})
