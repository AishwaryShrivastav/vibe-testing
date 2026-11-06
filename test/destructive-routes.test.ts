import { describe, expect, it } from 'vitest'
import { analyzeGaps } from '../src/engine/context/gap-analyzer.js'
import type { Memory, Route } from '../src/types/index.js'

const memory: Memory = { project: 'x', last_run: '', run_count: 0, known_bugs: [], flaky_flows: [], verified_flows: [] }
const route = (path: string, requires_auth = true): Route => ({ path, type: 'page', requires_auth, dynamic_segments: [] })

describe('static routes that act when opened are never test pages', () => {
  it('drops logout and delete-style routes from gaps (and so from scenarios)', () => {
    const gaps = analyzeGaps(
      [route('/dashboard'), route('/logout'), route('/sign-out', false), route('/items/:id/delete'), route('/memos')],
      {},
      memory,
    )
    expect(gaps.map(g => g.route).sort()).toEqual(['/dashboard', '/memos'])
  })
})
