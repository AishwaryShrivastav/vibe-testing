#!/usr/bin/env node
// Smithery expects full MCP tool schemas in its server card. MCPB's manifest
// only permits names and descriptions, so derive the card from the live server.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const qualifiedName = process.argv[2] ?? 'aish/vibe-testing'
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const bundlePath = path.resolve(process.argv[3] ?? path.join(root, 'artifacts', `vibe-testing-${packageJson.version}.mcpb`))
const manifest = JSON.parse(spawnSync('unzip', ['-p', bundlePath, 'manifest.json'], { encoding: 'utf8' }).stdout)
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smithery-publish', version: '1.0.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
]
const server = spawnSync('node', [path.join(root, 'dist', 'mcp-server.js')], {
  cwd: root,
  input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
  encoding: 'utf8',
})
if (server.status !== 0) throw new Error(`MCP handshake failed: ${server.stderr}`)
const replies = server.stdout.trim().split('\n').map(line => JSON.parse(line))
const version = replies.find(reply => reply.id === 1)?.result?.serverInfo?.version
const tools = replies.find(reply => reply.id === 2)?.result?.tools
if (version !== manifest.version) throw new Error(`Server version ${version} differs from bundle ${manifest.version}`)
if (!Array.isArray(tools) || tools.length !== manifest.tools.length) throw new Error('Bundle tool count differs from live server')
if (tools.some(tool => !manifest.tools.some(entry => entry.name === tool.name))) throw new Error('Bundle tool names differ from live server')
if (!tools.every(tool => tool.inputSchema?.type === 'object')) throw new Error('A tool has no input schema')

const auth = spawnSync('npx', ['--yes', 'smithery', 'auth', 'whoami', '--full'], { encoding: 'utf8' })
const token = auth.stdout.match(/^SMITHERY_API_KEY=(\S+)/m)?.[1]
if (auth.status !== 0 || !token) throw new Error('Smithery CLI is not authenticated')

const payload = {
  type: 'stdio',
  runtime: 'node',
  serverCard: { serverInfo: { name: manifest.name, version: manifest.version }, tools },
}
const form = new FormData()
form.set('payload', JSON.stringify(payload))
form.set('bundle', new Blob([await fs.readFile(bundlePath)]), 'server.mcpb')
const baseUrl = `https://api.smithery.ai/servers/${encodeURIComponent(qualifiedName)}`
const created = await fetch(baseUrl, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: manifest.display_name, description: manifest.description }),
})
if (!created.ok) throw new Error(`Smithery server creation failed (${created.status}): ${await created.text()}`)
const url = `${baseUrl}/releases`
const response = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form })
const body = await response.text()
if (!response.ok) throw new Error(`Smithery publication failed (${response.status}): ${body}`)
console.log(body)
