import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  installChromium,
  isChromiumInstalled,
  chromiumInstallCommand,
} from '../src/utils/playwright.js'

describe('Playwright browser setup', () => {
  it('detects whether the matching Chromium executable exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-browser-'))
    const executable = path.join(dir, 'chromium')

    expect(await isChromiumInstalled(executable)).toBe(false)
    await fs.writeFile(executable, '')
    expect(await isChromiumInstalled(executable)).toBe(true)

    await fs.rm(dir, { recursive: true, force: true })
  })

  it("runs Playwright's bundled installer for Chromium", async () => {
    const calls: Array<{ cliPath: string; args: string[] }> = []
    const installed = await installChromium(async (cliPath, args) => {
      calls.push({ cliPath, args })
      return 0
    })

    expect(installed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].cliPath).toMatch(/playwright[\\/]cli\.js$/)
    expect(calls[0].args).toEqual(['install', 'chromium'])
  })

  it('uses the package command in recovery instructions', () => {
    expect(chromiumInstallCommand).toBe('npx -y vibe-testing@latest install-browser')
  })
})
