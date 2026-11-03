import { describe, it, expect } from 'vitest'
import { mergeConfigCredentials } from '../src/engine/credentials.js'
import type { MemoryRecommendations } from '../src/engine/memory/index.js'
import type { VibeConfig } from '../src/types/config.js'

const baseRecs = {
  skip_routes: new Set<string>(),
  auth_routes: new Set<string>(),
  timeout_hints: {},
  selector_hints: {},
  first_run: true,
  auth_intel: null,
  saved_credentials: null,
} as unknown as MemoryRecommendations

describe('mergeConfigCredentials', () => {
  it('injects config credentials so converge/run use the real account', () => {
    const config = {
      url: 'http://localhost:5173',
      auth: { strategy: 'credentials', credentials: { email: 'admin', password: '1234' } },
    } as VibeConfig
    const merged = mergeConfigCredentials(baseRecs, config)
    expect(merged.saved_credentials?.email).toBe('admin')
    expect(merged.saved_credentials?.password).toBe('1234')
  })

  it('config wins over credentials remembered in memory', () => {
    const recs = { ...baseRecs, saved_credentials: { email: 'old@x.com', password: 'old', registered_at: '2020-01-01' } } as MemoryRecommendations
    const config = { url: 'http://x', auth: { strategy: 'credentials', credentials: { email: 'new', password: 'pw' } } } as VibeConfig
    const merged = mergeConfigCredentials(recs, config)
    expect(merged.saved_credentials?.email).toBe('new')
    expect(merged.saved_credentials?.registered_at).toBe('2020-01-01')
  })

  it('leaves recommendations untouched without config credentials', () => {
    expect(mergeConfigCredentials(baseRecs, { url: 'http://x' } as VibeConfig)).toBe(baseRecs)
  })
})
