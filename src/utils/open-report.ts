import { exec } from 'child_process'

/** False in CI or when VIBE_NO_OPEN is set (the CLI's --no-open sets it). */
export function shouldOpenReport(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = (value: string | undefined) => !!value && value !== '0' && value.toLowerCase() !== 'false'
  return !off(env.VIBE_NO_OPEN) && !off(env.CI)
}

/** Opens a report in the default browser unless shouldOpenReport() says not to. */
export function openReport(reportPath: string): void {
  if (!shouldOpenReport()) return
  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${openCmd} "${reportPath}"`, () => {})
}
