import { describe, expect, it } from 'vitest'
import { collectExplorerFailures, findingKey } from '../src/engine/findings.js'
import { describeSignalGroups } from '../src/engine/browser/error-signals.js'
import type { PageExploration } from '../src/engine/browser/explorer.js'

const exploration = (route: string, errors: string[]) => ({ route, errors, warnings: [], interactions: [] }) as unknown as PageExploration

describe('duplicate findings', () => {
  const viaNav = 'Total mismatch on /pos (via in-app navigation) after clicking "Checkout": the list is empty (page shows "No items") but "Total: $2000.00" is shown'
  const direct = 'Total mismatch on /pos after adding an item on /products after clicking "Checkout": the list is empty (page shows "No items") but "Total: $1000.00" is shown'

  it('collapses the same total defect seen from two routes', () => {
    const out = collectExplorerFailures([exploration('/products', [viaNav]), exploration('/pos', [direct])])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('(+1 more page)')
    expect(out[0]).toContain('after adding an item on /products')
    expect(out[0]).not.toContain('via in-app navigation')
  })

  it('keeps different discrepancies and different pages apart', () => {
    const items = 'Total mismatch on /pos after clicking "Checkout": 2 items sum to $20.00 but "Total: $30.00" is shown'
    const other = 'Total mismatch on /cart after clicking "Checkout": the list is empty (page shows "No items") but "Total: $1000.00" is shown'
    expect(collectExplorerFailures([exploration('/pos', [direct, items, other])])).toHaveLength(3)
    expect(findingKey(items)).not.toBe(findingKey(items.replace('2 items', '3 items')))
  })
})

describe('server error signals', () => {
  const sig = (url: string, evidence = 'boom') => ({ url, method: 'GET', status: 500, evidence })

  it('groups the same path with different query strings into one counted line', () => {
    const lines = describeSignalGroups([
      sig('http://x/allocations/2?threshold=1'), sig('http://x/allocations/2?threshold=2'), sig('http://x/allocations/2?threshold=3'),
    ])
    expect(lines).toEqual(['Server error 500 on GET /allocations/2 (×3, different query strings, e.g. ?threshold=…): boom'])
  })

  it('keeps signals that differ in path or evidence separate', () => {
    const lines = describeSignalGroups([sig('http://x/a?q=1'), sig('http://x/b?q=1'), sig('http://x/a?q=2', 'other')])
    expect(lines).toHaveLength(3)
    expect(lines.every(line => !line.includes('×'))).toBe(true)
  })
})
