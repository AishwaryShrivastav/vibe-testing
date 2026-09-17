import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf8'))

const expectedTools = [
  'scan_codebase',
  'login',
  'scan_page_elements',
  'explore_page',
  'execute_scenario',
  'get_coverage',
  'generate_report',
  'take_screenshot',
  'suggest_tests',
  'run_full_test',
  'run_converge',
  'get_context',
  'cleanup',
]

describe('MCPB package', () => {
  it('uses the current package identity and MCPB schema', () => {
    expect(manifest.$schema).toBe(
      'https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json'
    )
    expect(manifest.manifest_version).toBe('0.4')
    expect(manifest.name).toBe('vibe-testing')
    expect(manifest.version).toBe(packageJson.version)
  })

  it('launches the compiled stdio server with Node', () => {
    expect(manifest.server).toEqual({
      type: 'node',
      entry_point: 'dist/mcp-server.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/mcp-server.js'],
        env: {},
      },
    })
    expect(manifest.compatibility).toEqual({
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=20' },
    })
  })

  it('declares every MCP tool once', () => {
    const names = manifest.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expectedTools)
    expect(new Set(names).size).toBe(names.length)
  })

  it('ships the recommended 512 pixel square icon', () => {
    const icon = fs.readFileSync(path.join(root, 'assets', 'vibe-testing-icon-512.png'))
    expect(icon.readUInt32BE(16)).toBe(512)
    expect(icon.readUInt32BE(20)).toBe(512)
  })
})
