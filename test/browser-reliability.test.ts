import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { executeScenarios } from '../src/engine/browser/runner.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario, TestStep } from '../src/types/index.js'

vi.mock('../src/engine/browser/explorer.js', () => ({ exploreAllPages: async () => [] }))
// Opt in on a machine that allows Chromium. Never silently skip a launch failure.
describe.runIf(process.env.VIBE_REAL_BROWSER === '1')('real Chromium CLI/MCP regressions', () => {
  let dir: string
  let client: Client
  let fixtureUrl: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-browser-reliability-'))
    const htmlPath = path.join(dir, 'fixture.html')
    await fs.writeFile(htmlPath, `<body>
      <p>Welcome to this application. This is a real browser fixture with a file input and page assertions.</p>
      <div id="hidden" hidden>Saved</div><div id="result">Pending</div>
      <input id="file" type="file" hidden><output id="uploaded"></output>
      <script>document.querySelector('#file').onchange = async e => {
        document.querySelector('#uploaded').textContent = await e.target.files[0].text();
      };</script>
    </body>`)
    await fs.writeFile(path.join(dir, 'upload.txt'), 'Uploaded file contents')
    fixtureUrl = pathToFileURL(htmlPath).href
    client = new Client({ name: 'browser-regression', version: '1' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/mcp-server.ts', import.meta.url))], cwd: dir }))
    await client.callTool({ name: 'scan_codebase', arguments: { url: 'http://example.test', codebase_path: dir } })
  })
  afterAll(async () => {
    await client?.callTool({ name: 'cleanup', arguments: {} })
    await client?.close()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })
  async function run(via: string, steps: TestStep[]) {
    const scenario: TestScenario = { id: 'real', name: 'Real browser regression', route: new URL(fixtureUrl).pathname, priority: 'high', steps: [{ action: 'navigate', url: fixtureUrl, description: 'Open fixture' }, ...steps], expected_outcome: 'Checks succeed', is_gap: false, generated_by: 'heuristic' }
    if (via === 'CLI') return (await executeScenarios([scenario], VibeConfigSchema.parse({ url: 'http://example.test', browser: { headed: false, slowMo: 0 } }), dir)).results[0]
    const response = await client.callTool({ name: 'execute_scenario', arguments: { scenario } })
    const text = (response.content as any[])[0].text
    if (text.startsWith('Error in ')) throw new Error(text)
    return JSON.parse(text)
  }
  describe.each(['CLI', 'MCP'])('%s', via => {
    it.each([
      { selector: '#missing' },
      { selector: '#hidden' },
      { selector: '#result', value: 'Saved' },
      { url: '/dashboard' },
    ])('fails unmet page assertion %j', async extra => {
      const result = await run(via, [{ action: 'assert', description: 'Assert fixture state', timeout: 100, ...extra }])
      expect(result.status).toBe('fail')
      expect(result.step_logs[1].status).toBe('failed')
    })
    it('uploads bytes through a hidden file input and observes page confirmation', async () => {
      const result = await run(via, [
        { action: 'upload', selector: '#file', value: path.join(dir, 'upload.txt'), description: 'Upload fixture', timeout: 1000 },
        { action: 'assert', selector: '#uploaded', value: 'Uploaded file contents', description: 'Verify file bytes reached page', timeout: 1000 },
      ])
      expect(result.status).toBe('pass')
    })
    it('fails a missing upload file', async () => {
      expect((await run(via, [{ action: 'upload', selector: '#file', value: path.join(dir, 'missing.txt'), description: 'Missing upload', timeout: 100 }])).status).toBe('error')
    })
  })
})
