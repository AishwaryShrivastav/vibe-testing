#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const stage = path.join(root, '.mcpb-build')
const artifacts = path.join(root, 'artifacts')
const cli = ['--yes', '@anthropic-ai/mcpb@2.1.2']
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const output = path.join(artifacts, `vibe-testing-${packageJson.version}.mcpb`)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: options.capture ? ['pipe', 'pipe', 'inherit'] : 'inherit',
    })
    let stdout = ''
    if (options.capture) child.stdout.on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code}`))
    })
    if (options.input) child.stdin.end(options.input)
  })
}

async function copyBundleFiles() {
  await fs.rm(stage, { recursive: true, force: true })
  await fs.mkdir(stage, { recursive: true })
  await fs.mkdir(artifacts, { recursive: true })

  await Promise.all([
    fs.cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true }),
    fs.copyFile(path.join(root, 'mcpb', 'manifest.json'), path.join(stage, 'manifest.json')),
    fs.copyFile(path.join(root, 'assets', 'vibe-testing-icon-512.png'), path.join(stage, 'icon.png')),
    fs.copyFile(path.join(root, 'package.json'), path.join(stage, 'package.json')),
    fs.copyFile(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json')),
    fs.copyFile(path.join(root, 'README.md'), path.join(stage, 'README.md')),
  ])
}

async function verifyHandshake() {
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcpb-build', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]
  const input = `${messages.map(message => JSON.stringify(message)).join('\n')}\n`
  const stdout = await run('node', ['dist/mcp-server.js'], { cwd: stage, capture: true, input })
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line))
  const initialized = responses.find(response => response.id === 1)
  const tools = responses.find(response => response.id === 2)?.result?.tools

  if (initialized?.result?.serverInfo?.version !== packageJson.version) {
    throw new Error('Bundled server reported the wrong version')
  }
  if (!Array.isArray(tools) || tools.length !== 14) {
    throw new Error(`Bundled server reported ${tools?.length ?? 0} tools; expected 14`)
  }
}

try {
  await run('npm', ['run', 'build'])
  await copyBundleFiles()
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stage })
  await run('npx', [...cli, 'validate', stage])
  await verifyHandshake()
  await fs.rm(output, { force: true })
  await run('npx', [...cli, 'pack', stage, output])
  await run('npx', [...cli, 'info', output])
  console.log(`MCPB ready: ${path.relative(root, output)}`)
} finally {
  if (process.env.MCPB_KEEP_STAGE !== '1') {
    await fs.rm(stage, { recursive: true, force: true })
  }
}
