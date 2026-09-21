import { beforeEach, describe, expect, it, vi } from 'vitest'

const globFn = vi.hoisted(() => vi.fn(async (pattern: string) =>
  pattern === '**/package.json' ? [] : ['src\\routes\\users\\$userId.tsx']
))

vi.mock('glob', () => ({ glob: globFn }))

import { glob } from '../src/utils/file.js'

describe('glob', () => {
  beforeEach(() => globFn.mockClear())

  it('requests POSIX output and normalizes Windows separators defensively', async () => {
    const files = await glob('src/routes/**/*.tsx', 'C:\\workspace\\app')

    expect(files).toEqual(['src/routes/users/$userId.tsx'])
    expect(globFn).toHaveBeenCalled()
    for (const [, options] of globFn.mock.calls) {
      expect(options).toMatchObject({ posix: true })
    }
  })
})
