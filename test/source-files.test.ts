import { describe, it, expect } from 'vitest'
import { isSourceFile } from '../src/utils/source-files.js'

describe('isSourceFile (get_context source walker)', () => {
  it.each([
    'App.tsx', 'api.ts', 'LoginPage.jsx', 'main.js',
    'server.mjs', 'config.cjs', 'util.mts', 'legacy.cts',
    'Login.vue', '+page.svelte',
  ])('includes %s', file => {
    expect(isSourceFile(file)).toBe(true)
  })

  it.each(['styles.css', 'logo.svg', 'data.json', 'README.md', 'index.html', 'App.jsx.map'])(
    'excludes %s',
    file => {
      expect(isSourceFile(file)).toBe(false)
    }
  )

  it.each(['vite-env.d.ts', 'global.d.ts', 'types.d.mts', 'legacy.d.cts'])(
    'excludes TypeScript declaration file %s',
    file => {
      expect(isSourceFile(file)).toBe(false)
    }
  )

  it.each(['card.ts', 'id.ts', 'add.ts', 'bad.mts'])(
    'still includes regular file %s whose name ends in "d" before the extension',
    file => {
      expect(isSourceFile(file)).toBe(true)
    }
  )
})
