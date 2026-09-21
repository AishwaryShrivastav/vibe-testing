import { describe, expect, it } from 'vitest'
import { readExistingTests } from '../src/engine/context/test-reader.js'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

async function withTestFiles(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-test-reader-'))
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  return dir
}

describe('readExistingTests', () => {
  it('excludes dependency, metadata, and build output tests from coverage', async () => {
    const sourceTest = "test('source scenario', async () => { await page.goto('/source') })"
    const noiseTest = (route: string) => `test('noise scenario', async () => { await page.goto('${route}') })`
    const ignoredDirectories = [
      'node_modules', '.git', '.vibe', '.next', '.output', 'dist', 'build', 'coverage',
    ]
    const files: Record<string, string> = {
      'src/source.test.ts': sourceTest,
      'src/build/source.test.ts': "test('nested build source', async () => { await page.goto('/source-build') })",
      'src/dist/source.test.ts': "test('nested dist source', async () => { await page.goto('/source-dist') })",
      'src/coverage/source.test.ts': "test('nested coverage source', async () => { await page.goto('/source-coverage') })",
    }
    for (const directory of ignoredDirectories) {
      files[`${directory}/noise.test.ts`] = noiseTest(`/${directory}/noise`)
    }
    for (const packageRoot of ['apps/web', 'packages/ui']) {
      files[`${packageRoot}/package.json`] = '{}'
      for (const directory of ['.next', '.output', 'dist', 'build', 'coverage']) {
        files[`${packageRoot}/${directory}/noise.test.ts`] = noiseTest(`/${packageRoot}/${directory}/noise`)
      }
    }
    files['services/web/package.json'] = '{}'
    files['services/web/dist/noise.test.ts'] = noiseTest('/services/web/dist/noise')
    files['services/web/src/dist/source.test.ts'] = "test('service dist source', async () => { await page.goto('/service-source-dist') })"
    files['apps/team/web/package.json'] = '{}'
    files['apps/team/web/build/noise.test.ts'] = noiseTest('/apps/team/web/build/noise')
    files['apps/team/web/coverage/noise.test.ts'] = noiseTest('/apps/team/web/coverage/noise')
    files['apps/team/web/src/coverage/source.test.ts'] = "test('nested workspace coverage source', async () => { await page.goto('/workspace-source-coverage') })"

    const dir = await withTestFiles(files)
    try {
      const coverage = await readExistingTests(dir)

      expect(Object.keys(coverage).sort()).toEqual([
        '/service-source-dist',
        '/source',
        '/source-build',
        '/source-coverage',
        '/source-dist',
        '/workspace-source-coverage',
      ])
      expect(coverage['/source']?.scenarios).toEqual(['source scenario'])
      expect(coverage['/source-build']?.scenarios).toEqual(['nested build source'])
      expect(coverage['/source-dist']?.scenarios).toEqual(['nested dist source'])
      expect(coverage['/source-coverage']?.scenarios).toEqual(['nested coverage source'])
      expect(coverage['/service-source-dist']?.scenarios).toEqual(['service dist source'])
      expect(coverage['/workspace-source-coverage']?.scenarios).toEqual(['nested workspace coverage source'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
