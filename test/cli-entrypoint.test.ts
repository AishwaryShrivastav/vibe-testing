import { spawnSync } from 'child_process'
import fsSync from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isDirectExecution } from '../src/utils/direct-execution.js'

const temporaryDirectories: string[] = []
const hasMacOsTmpAlias = process.platform === 'darwin'
  && fsSync.existsSync('/tmp')
  && fsSync.existsSync('/private/tmp')
  && fsSync.realpathSync.native('/tmp') === fsSync.realpathSync.native('/private/tmp')

beforeAll(() => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npmCommand, ['run', 'build'], { encoding: 'utf8' })

  expect(result.status, result.stderr || result.stdout).toBe(0)
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('isDirectExecution', () => {
  it('recognizes the module file itself', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-direct-'))
    temporaryDirectories.push(dir)
    const modulePath = path.join(dir, 'cli.js')
    await fs.writeFile(modulePath, '')

    expect(isDirectExecution(pathToFileURL(modulePath).href, modulePath)).toBe(true)
  })

  it('recognizes a package-manager symlink to the module', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-direct-'))
    temporaryDirectories.push(dir)
    const modulePath = path.join(dir, 'cli.js')
    const symlinkPath = path.join(dir, 'vibe-testing')
    await fs.writeFile(modulePath, '')
    await fs.symlink(modulePath, symlinkPath)

    expect(isDirectExecution(pathToFileURL(modulePath).href, symlinkPath)).toBe(true)
  })

  it.skipIf(!hasMacOsTmpAlias)('recognizes the real macOS /tmp and /private/tmp aliases', async () => {
    const dir = await fs.mkdtemp('/tmp/vibe-direct-')
    temporaryDirectories.push(dir)
    const argvPath = path.join(dir, 'cli.js')
    await fs.writeFile(argvPath, '')
    const modulePath = argvPath.replace(/^\/tmp\//, '/private/tmp/')

    expect(isDirectExecution(pathToFileURL(modulePath).href, argvPath)).toBe(true)
  })

  it('runs the CLI directly from its TypeScript source', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), path.resolve('src/cli.ts'), '--help'],
      { encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: vibe-testing')
  })

  it.skipIf(process.platform === 'win32')('runs an executable npx-style node_modules bin symlink', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-bin-'))
    temporaryDirectories.push(dir)
    const binDir = path.join(dir, 'node_modules', '.bin')
    const binPath = path.join(binDir, 'vibe-testing')
    const cliPath = path.resolve('dist/cli.js')
    await fs.mkdir(binDir, { recursive: true })
    await fs.chmod(cliPath, 0o755)
    await fs.symlink(cliPath, binPath)

    const result = spawnSync(binPath, ['--help'], { cwd: dir, encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: vibe-testing')
  })
})
