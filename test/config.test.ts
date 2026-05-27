import { describe, it, expect } from 'vitest'
import { AuthConfigSchema, VibeConfigSchema } from '../src/types/config.js'

describe('AuthConfigSchema', () => {
  it('accepts credentials strategy', () => {
    const result = AuthConfigSchema.safeParse({
      strategy: 'credentials',
      credentials: { email: 'test@test.com', password: 'pass123' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts basic strategy', () => {
    const result = AuthConfigSchema.safeParse({
      strategy: 'basic',
      credentials: { email: 'user', password: 'pass' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts skip strategy', () => {
    const result = AuthConfigSchema.safeParse({ strategy: 'skip' })
    expect(result.success).toBe(true)
  })

  it('defaults to skip when no strategy given', () => {
    const result = AuthConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.strategy).toBe('skip')
    }
  })

  it('rejects invalid strategy with clear message', () => {
    const result = AuthConfigSchema.safeParse({ strategy: 'bearer' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Invalid enum value')
    }
  })

  it('accepts custom field names', () => {
    const result = AuthConfigSchema.safeParse({
      strategy: 'credentials',
      fields: { email: 'username', password: 'passwd' },
      credentials: { email: 'admin', password: 'secret' },
    })
    expect(result.success).toBe(true)
  })
})

describe('VibeConfigSchema', () => {
  it('accepts minimal valid config', () => {
    const result = VibeConfigSchema.safeParse({ url: 'http://localhost:3000' })
    expect(result.success).toBe(true)
  })

  it('accepts full config', () => {
    const result = VibeConfigSchema.safeParse({
      url: 'http://localhost:3000',
      mode: 'deep',
      auth: {
        strategy: 'credentials',
        login_url: '/login',
        credentials: { email: 'test@test.com', password: 'pass' },
      },
      never_interact: ['delete account'],
      scope: { include: ['/**'], exclude: ['/admin'], max_routes: 20 },
      browser: { headed: true, slowMo: 50, timeout: 30000 },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid URL', () => {
    const result = VibeConfigSchema.safeParse({ url: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid mode', () => {
    const result = VibeConfigSchema.safeParse({ url: 'http://localhost:3000', mode: 'turbo' })
    expect(result.success).toBe(false)
  })

  it('accepts routes: auto', () => {
    const result = VibeConfigSchema.safeParse({ url: 'http://localhost:3000', routes: 'auto' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.routes).toBe('auto')
  })

  it('defaults routes to auto', () => {
    const result = VibeConfigSchema.safeParse({ url: 'http://localhost:3000' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.routes).toBe('auto')
  })
})
