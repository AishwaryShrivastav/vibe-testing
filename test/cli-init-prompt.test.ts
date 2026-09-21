import { describe, expect, it } from 'vitest'
import { buildInitCompletionPrompt } from '../src/cli.js'

describe('buildInitCompletionPrompt', () => {
  it('returns a URL-specific ready-to-paste scenario with explicit assertions', () => {
    const prompt = buildInitCompletionPrompt({ appUrl: 'http://localhost:3000/admin' })

    expect(prompt).toContain('scan_codebase')
    expect(prompt).toContain('execute_scenario')
    expect(prompt).toContain('http://localhost:3000/admin')
    expect(prompt).toContain('assert')
    expect(prompt).toContain('url\"')
    expect(prompt).toContain('explicit assertions')
  })

  it('uses route-scoped route path from the URL', () => {
    const prompt = buildInitCompletionPrompt({ appUrl: 'http://localhost:3000/admin/dashboard' })
    expect(prompt).toContain('/admin/dashboard')
  })

  it('renders the starter flow with actual line breaks', () => {
    const prompt = buildInitCompletionPrompt({ appUrl: 'http://localhost:3000' })

    expect(prompt).toContain('\n2) get_context')
    expect(prompt).not.toContain('\\n')
  })
})
