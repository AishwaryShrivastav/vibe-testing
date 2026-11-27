import { describe, expect, it } from 'vitest'
import { checkValue, parseBody, resolvePath, statusMatches } from '../src/engine/browser/extra-steps.js'
import { hasExplicitAssertion, hasStrongExplicitAssertion } from '../src/engine/browser/assertions.js'
import { isoWithOffset, toJUnit, toLedger } from '../src/engine/cases/reports.js'
import type { CaseRunResult } from '../src/engine/cases/run.js'
import { shouldOpenReport } from '../src/utils/open-report.js'

describe('JSON and status checks', () => {
  it('matches status specs', () => {
    expect(statusMatches(200, '200')).toBe(true)
    expect(statusMatches(201, '2xx')).toBe(true)
    expect(statusMatches(403, '400|403')).toBe(true)
    expect(statusMatches(500, '!5xx')).toBe(false)
    expect(statusMatches(303, '4xx')).toBe(false)
  })

  it('resolves paths with indexes and wildcards', () => {
    const body = { a: { items: [{ id: 1 }, { id: 2 }, {}] }, 'x y': true }
    expect(resolvePath(body, 'a.items[1].id')).toEqual([2])
    expect(resolvePath(body, 'a.items[*].id').slice(0, 2)).toEqual([1, 2])
    expect(typeof resolvePath(body, 'a.items[*].id')[2]).toBe('symbol')
    expect(resolvePath(body, '$')).toEqual([body])
    expect(resolvePath(body, '["x y"]')).toEqual([true])
  })

  it('compares values', () => {
    expect(checkValue('channel', 'equals', 'channel')).toBeUndefined()
    expect(checkValue(200, 'equals', '200')).toBeUndefined()
    expect(checkValue(false, 'equals', 'false')).toBeUndefined()
    expect(checkValue('peer', 'equals', 'channel')).toMatch(/expected "channel"/)
    expect(checkValue(null, 'exists', undefined)).toBeUndefined()
    expect(checkValue(resolvePath({}, 'x')[0], 'exists', undefined)).toBe('is missing')
    expect(checkValue(resolvePath({}, 'x')[0], 'absent', undefined)).toBeUndefined()
    expect(checkValue(['exa is not configured'], 'contains', 'exa is not configured')).toBeUndefined()
    expect(checkValue([{ name: 'brain_read' }, { name: 'lead_save' }], 'contains', 'brain_read')).toBeUndefined()
    expect(checkValue([{ name: 'brain_read', description: 'about lead_x' }], 'contains', 'lead_x')).toMatch(/has no/)
    expect(checkValue('not a website: x', 'contains', 'not a website')).toBeUndefined()
    expect(checkValue([1, 2, 3], 'length', '>=2')).toBeUndefined()
    expect(checkValue([1], 'length', '3')).toMatch(/has length 1, expected 3/)
    expect(checkValue('2026-11-27', 'matches', '^\\d{4}-')).toBeUndefined()
    expect(checkValue(5, 'gt', '3')).toBeUndefined()
    expect(checkValue(5, 'lte', '3')).toMatch(/expected lte 3/)
  })

  it('reads JSON from an event stream (MCP over streamable HTTP)', () => {
    expect(parseBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', 'text/event-stream')).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(parseBody('{"a":1}', 'application/json')).toEqual({ a: 1 })
    expect(parseBody('<html>', 'text/html')).toBeUndefined()
  })

  it('counts the new check steps as explicit proof', () => {
    for (const action of ['expect_status', 'expect_json', 'eval', 'in_viewport', 'no_horizontal_scroll', 'still', 'a11y'] as const) {
      expect(hasExplicitAssertion({ action, description: '' })).toBe(true)
      expect(hasStrongExplicitAssertion({ action, description: '' })).toBe(true)
    }
    expect(hasExplicitAssertion({ action: 'request', description: '' })).toBe(false)
    expect(hasExplicitAssertion({ action: 'press', description: '' })).toBe(false)
  })
})

const RUN: CaseRunResult = {
  started_at: '2026-11-27T12:00:00.000Z', duration_ms: 1500,
  summary: { total: 4, pass: 1, fail: 1, error: 0, skip: 1, needs_steps: 1 },
  cases: [
    { id: 'TC-1', title: 'Sign in', priority: 'P0', file: '/x/cases.md', line: 3, status: 'pass', duration_ms: 900, variants: [
      { name: '1440x900 full', viewport: [1440, 900], motion: 'full', status: 'pass', result: { duration_ms: 400 } as never },
      { name: '390x844 reduce', viewport: [390, 844], motion: 'reduce', status: 'pass', result: { duration_ms: 500 } as never },
    ] },
    { id: 'TC-2', title: 'Wrong <password>', file: '/x/cases.md', line: 9, status: 'fail', reason: '1440x900 full: Expected #alert to contain "x"', duration_ms: 300, variants: [
      { name: '1440x900 full', viewport: [1440, 900], motion: 'full', status: 'fail', reason: 'Expected #alert to contain "x"\u001b[2m', result: { duration_ms: 300 } as never },
    ] },
    { id: 'TC-3', title: 'Paste', file: '/x/cases.md', line: 20, status: 'needs_steps', reason: 'no steps', duration_ms: 0, variants: [] },
    { id: 'TC-4', title: 'Live seed', file: '/x/cases.md', line: 30, status: 'skip', reason: 'tagged live', duration_ms: 0, variants: [] },
  ],
}

describe('case reports', () => {
  it('writes JUnit with one testcase per variant', () => {
    const xml = toJUnit(RUN)
    expect(xml).toContain('<testsuite name="cases.md" tests="5" failures="1" errors="0" skipped="2"')
    expect(xml).toContain('name="TC-1 Sign in [390x844 reduce]"')
    expect(xml).toContain('name="TC-2 Wrong &lt;password&gt;"')
    expect(xml).toContain('<failure message="Expected #alert to contain &quot;x&quot;[2m"/>')
    expect(xml).not.toContain('\u001b')
  })

  it('writes one evidence-ledger line per case', () => {
    const lines = toLedger(RUN, { task: 'E-20261127-x', stage: 'E4_vibe_test', by: 'agent:eng-vibe-test', sha: 'abc1234', path: '.vibe/cases/report.html', now: new Date('2026-11-27T13:00:00Z') })
      .trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(l => [l.ref, l.result])).toEqual([['TC-1', 'pass'], ['TC-2', 'fail'], ['TC-3', 'warn'], ['TC-4', 'warn']])
    expect(lines[0]).toMatchObject({ task: 'E-20261127-x', stage: 'E4_vibe_test', kind: 'vibe-run', sha: 'abc1234', by: 'agent:eng-vibe-test', path: '.vibe/cases/report.html' })
    expect(lines[0].summary).toBe('Sign in: passed on 2 variants (1440x900 full, 390x844 reduce)')
    expect(lines[2].summary).toBe('Paste: not run, no vibe steps yet')
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it('formats a local time with its UTC offset', () => {
    const date = new Date('2026-11-27T13:00:00Z')
    const iso = isoWithOffset(date)
    expect(new Date(iso).getTime()).toBe(date.getTime())
  })
})

describe('opening reports', () => {
  it('stays closed in CI or when asked', () => {
    expect(shouldOpenReport({})).toBe(true)
    expect(shouldOpenReport({ CI: 'true' })).toBe(false)
    expect(shouldOpenReport({ VIBE_NO_OPEN: '1' })).toBe(false)
    expect(shouldOpenReport({ CI: 'false' })).toBe(true)
  })
})
