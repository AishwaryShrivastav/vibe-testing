import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import serverJson from '../server.json'
import pluginJson from '../plugin.json'
import mcpbManifest from '../mcpb/manifest.json'
import fs from 'fs'
import path from 'path'

describe('package executables', () => {
  it('exposes the package name as the default npx command', () => {
    expect(packageJson.bin['vibe-testing']).toBe('dist/cli.js')
    expect(packageJson.bin['vibe-test']).toBe('dist/cli.js')
    expect(packageJson.bin['vibe-test-mcp']).toBe('dist/mcp-server.js')
  })

  it('makes every published JavaScript binary directly executable', () => {
    for (const target of new Set(Object.values(packageJson.bin))) {
      const source = target.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
      const firstLine = fs.readFileSync(path.resolve(source), 'utf8').split('\n')[0]
      expect(firstLine, `${source} needs a Node shebang`).toBe('#!/usr/bin/env node')
    }
  })
})

describe('MCP distribution metadata', () => {
  it('keeps the registry manifest aligned with the npm package', () => {
    expect(serverJson.version).toBe(packageJson.version)
    expect(serverJson.packages).toHaveLength(1)
    expect(serverJson.packages[0].identifier).toBe(packageJson.name)
    expect(serverJson.packages[0].version).toBe(packageJson.version)
    expect(serverJson.description).toContain('14 Playwright tools')
  })

  it('keeps release identity and canonical links aligned', () => {
    expect(packageJson.version).toBe('0.4.6')
    expect(packageJson.homepage).toBe('https://vibetesting.tfgstudio.com/')
    expect(pluginJson.version).toBe(packageJson.version)
    expect(pluginJson.homepage).toBe(packageJson.homepage)
    expect(mcpbManifest.version).toBe(packageJson.version)
    expect(mcpbManifest.homepage).toBe(packageJson.homepage)
  })
})
