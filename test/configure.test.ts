import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

function runInit(cwd: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      path.resolve('src/cli.ts'),
      'init',
      '--no-global',
      '--skip-browser-install',
      '--editor',
      'roo',
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: cwd, NO_COLOR: '1' },
    },
  )
}

describe('CLI project configuration', () => {
  it('creates neutral VIBE.md guidance without invented authentication details', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-configure-'))
    temporaryDirectories.push(dir)

    const result = runInit(dir)
    const guidance = await fs.readFile(path.join(dir, 'VIBE.md'), 'utf8')

    expect(result.status).toBe(0)
    expect(guidance).toContain('Authentication')
    expect(guidance).toContain('Unknown until detected')
    expect(guidance).not.toContain('/login')
    expect(guidance).not.toContain('your-test-user@example.com')
    expect(guidance).not.toContain('your-test-password')
  })

  it('preserves a user-authored VIBE.md byte-for-byte', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-configure-'))
    temporaryDirectories.push(dir)
    const vibeMdPath = path.join(dir, 'VIBE.md')
    const authoredGuidance = Buffer.from('# My testing notes\r\n\r\nUse passphrase: caf\u00e9\r\n', 'utf8')
    await fs.writeFile(vibeMdPath, authoredGuidance)

    const result = runInit(dir)
    const preservedGuidance = await fs.readFile(vibeMdPath)

    expect(result.status, result.stderr).toBe(0)
    expect(preservedGuidance.equals(authoredGuidance)).toBe(true)
  })

  it('adds .vibe/ to .gitignore once while preserving existing entries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-configure-'))
    temporaryDirectories.push(dir)
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n')

    expect(runInit(dir).status).toBe(0)
    expect(runInit(dir).status).toBe(0)

    const gitignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('node_modules/\n')
    expect(gitignore.match(/^\.vibe\/$/gm)).toHaveLength(1)
  })
})
