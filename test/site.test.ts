import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const html = readFileSync(resolve(root, 'site/index.html'), 'utf8')
const css = readFileSync(resolve(root, 'site/styles.css'), 'utf8')
const script = readFileSync(resolve(root, 'site/app.js'), 'utf8')

const tools = [
  'scan_codebase',
  'get_context',
  'login',
  'scan_page_elements',
  'explore_page',
  'execute_scenario',
  'get_coverage',
  'suggest_tests',
  'take_screenshot',
  'generate_report',
  'run_full_test',
  'run_converge',
  'cleanup',
]

describe('launch site', () => {
  it('offers verified install and source paths', () => {
    expect(html).toContain('npx vibe-testing@latest init')
    expect(html).toContain('https://www.npmjs.com/package/vibe-testing')
    expect(html).toContain('https://github.com/AishwaryShrivastav/vibe-testing')
    expect(html).toContain('https://registry.modelcontextprotocol.io/')
  })

  it('shows actual report and regression vocabulary', () => {
    expect(html).toContain('snapshot_diff')
    expect(html).toContain('Outcome verified')
    expect(html).toContain('Coverage gap')
    expect(html).toContain('EXAMPLE REPORT')
    expect(html).toContain('zero internal LLM calls')
  })

  it('lists every public MCP tool exactly once in the tool ledger', () => {
    for (const tool of tools) {
      const matches = html.match(new RegExp(`<code>${tool}</code>`, 'g')) ?? []
      expect(matches, tool).toHaveLength(1)
    }
  })

  it('provides accessible interaction and analytics hooks', () => {
    expect(html).toContain('class="skip-link"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-event="founding_qa_request"')
    expect(script).toContain("new CustomEvent('vibe:analytics'")
    expect(script).toContain('navigator.sendBeacon')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
