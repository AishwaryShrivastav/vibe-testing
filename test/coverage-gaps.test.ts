import { describe, expect, it } from 'vitest'
import { generateCoverageGaps } from '../src/engine/coverage-gaps.js'
import type { PageExploration } from '../src/engine/browser/index.js'
import type { PageFeature, PageFunctionality, RouteBehaviour } from '../src/types/index.js'

function behaviour(route: string, features: PageFeature['type'][], dialogs: PageFunctionality['dialogs'] = []): RouteBehaviour {
  return {
    route: { path: route, type: 'page', requires_auth: true, dynamic_segments: [] },
    forms: [],
    api_calls: [],
    functionality: {
      features: features.map(type => ({ name: `${type === 'crud_create' ? 'Create' : type === 'crud_update' ? 'Update' : type === 'crud_delete' ? 'Delete' : ''} Item`.trim(), type, description: '' })),
      buttons: [], dialogs, navigation_flows: [], data_display: [], state_vars: [],
    },
  }
}

function exploration(route: string, extra: Partial<PageExploration>): PageExploration {
  return {
    route, url: route, elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: [], errors: [], duration_ms: 1, ...extra,
  }
}

describe('generateCoverageGaps', () => {
  it('suggests a critical create test using the real dialog trigger and fields', () => {
    const gaps = generateCoverageGaps([behaviour('/items', ['crud_create'], [{
      trigger: 'New item', title: 'Create item', submit_text: 'Save',
      fields: [{ name: 'title', type: 'text', required: true, validations: [], placeholder: 'Title' }],
    }])], [])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ route: '/items', severity: 'critical' })
    expect(gaps[0].suggested_test.steps).toEqual([
      'Navigate to /items', 'Click "New item" to open dialog', 'Fill "Title" with test data',
      'Click "Save"', 'Verify new item appears in list or success toast shown',
    ])
  })

  it('skips create when there is no dialog with fields to drive it', () => {
    expect(generateCoverageGaps([behaviour('/items', ['crud_create'])], [])).toEqual([])
  })

  it('assigns severities per feature type', () => {
    const gaps = generateCoverageGaps([behaviour('/items', ['crud_update', 'crud_delete', 'pagination', 'upload'])], [])
    expect(gaps.map(g => g.severity)).toEqual(['important', 'important', 'nice_to_have', 'important'])
  })

  it('turns broken explored elements into important gaps', () => {
    const gaps = generateCoverageGaps([behaviour('/items', [])], [exploration('/items', {
      interactions: [
        { element: 'Export CSV', elementType: 'button', action: 'click', result: 'error', details: 'Timeout', duration_ms: 1 },
        { element: 'Refresh', elementType: 'button', action: 'click', result: 'success', details: '', duration_ms: 1 },
      ],
    })])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ severity: 'important', missing: 'Element "Export CSV" failed during testing: Timeout' })
  })

  it('rates API 5xx errors critical and 4xx important', () => {
    const api = (status: number, p: string) => ({ url: p, method: 'GET', status, path: p, responseTime_ms: 1, isError: true })
    const gaps = generateCoverageGaps([behaviour('/items', [])], [exploration('/items', {
      api_calls: [api(500, '/api/items'), api(404, '/api/missing'), { ...api(200, '/api/ok'), isError: false }],
    })])
    expect(gaps.map(g => [g.missing, g.severity])).toEqual([
      ['API error: GET /api/items returned 500', 'critical'],
      ['API error: GET /api/missing returned 404', 'important'],
    ])
  })

  it('ignores routes without analysed functionality and de-duplicates repeated gaps', () => {
    const noFunc: RouteBehaviour = { route: { path: '/raw', type: 'page', requires_auth: false, dynamic_segments: [] }, forms: [], api_calls: [] }
    const dup = behaviour('/items', ['crud_update', 'crud_update'])
    expect(generateCoverageGaps([noFunc, dup], [])).toHaveLength(1)
  })
})
