import { spawn } from 'child_process'
import fs from 'fs/promises'
import { createRequire } from 'module'
import path from 'path'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const playwrightRoot = path.dirname(require.resolve('playwright/package.json'))

export const chromiumInstallCommand = 'npx -y vibe-testing@latest install-browser'

export type PlaywrightInstaller = (cliPath: string, args: string[]) => Promise<number>

export async function isChromiumInstalled(
  executablePath = chromium.executablePath()
): Promise<boolean> {
  try {
    await fs.access(executablePath)
    return true
  } catch {
    return false
  }
}

async function runInstaller(cliPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

export async function installChromium(
  installer: PlaywrightInstaller = runInstaller
): Promise<boolean> {
  const cliPath = path.join(playwrightRoot, 'cli.js')
  return (await installer(cliPath, ['install', 'chromium'])) === 0
}
