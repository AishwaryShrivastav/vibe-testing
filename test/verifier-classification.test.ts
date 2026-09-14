import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { verifyResult } from '../src/engine/browser/verifier.js'
import type { TestScenario } from '../src/types/index.js'

function pageStub(input: { body?: string; toast?: string } = {}): Page {
  const body = input.body ?? 'A rendered application page with enough visible content for a smoke check.'

  return {
    url: () => 'http://localhost:3000/',
    locator: (selector: string) => {
      const isToast = selector === '[data-sonner-toast]' && Boolean(input.toast)
      const node = {
        count: async () => 0,
        first: () => node,
        isVisible: async () => isToast,
        innerText: async () => selector === 'body' ? body : isToast ? input.toast ?? '' : '',
      }
      return node
    },
  } as unknown as Page
}

function scenario(overrides: Partial<TestScenario> = {}): TestScenario {
  return {
    id: 'classification',
    name: 'Page loads',
    route: '/',
    priority: 'medium',
    steps: [{ action: 'navigate', url: '/', description: 'Open the page' }],
    expected_outcome: 'Page loads',
    is_gap: false,
    generated_by: 'heuristic',
    ...overrides,
  }
}

describe('verification evidence classification', () => {
  it('reserves outcome verified for a passed explicit outcome assertion', async () => {
    const result = await verifyResult(pageStub(), scenario({
      steps: [
        { action: 'navigate', url: '/', description: 'Open the page' },
        { action: 'assert', selector: 'h1', value: 'Dashboard', description: 'Check the heading' },
      ],
    }), '')

    expect(result.verification).toBe('outcome_verified')
  })

  it('labels an inferred expected-error toast as a smoke check', async () => {
    const result = await verifyResult(pageStub({ toast: 'Validation error' }), scenario({
      name: 'Empty form shows validation',
      expected_outcome: 'Validation error appears',
    }), '')

    expect(result.passed).toBe(true)
    expect(result.verification).toBe('smoke_check_passed')
  })

  it('labels generic rendered content as a smoke check', async () => {
    const result = await verifyResult(pageStub(), scenario(), '')

    expect(result.verification).toBe('smoke_check_passed')
  })
})
