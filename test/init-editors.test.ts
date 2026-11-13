import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildNextSteps,
  codexTomlBlock,
  MANUAL_COMMANDS,
  upsertCodexToml,
  upsertJsonMcpConfig,
} from '../src/init-editors.js'

const temporaryDirectories: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-init-'))
  temporaryDirectories.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

const ENTRY = { command: 'npx', args: ['-y', 'vibe-testing@latest', '--mcp'] }

describe('upsertJsonMcpConfig', () => {
  it('creates the file, with the stdio type when asked', async () => {
    const file = path.join(await tempDir(), '.vscode', 'mcp.json')
    expect(await upsertJsonMcpConfig(file, 'servers', { withType: true })).toBe('created')
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ servers: { 'vibe-test': { type: 'stdio', ...ENTRY } } })
  })

  it('keeps everything already in the file (the shape of ~/.claude.json)', async () => {
    const file = path.join(await tempDir(), '.claude.json')
    await fs.writeFile(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } }, projects: { '/p': {} } }))
    expect(await upsertJsonMcpConfig(file, 'mcpServers')).toBe('updated')
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
      numStartups: 3,
      mcpServers: { other: { command: 'x' }, 'vibe-test': ENTRY },
      projects: { '/p': {} },
    })
  })

  it('is idempotent, and treats a "vibe-testing" entry as already registered', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'mcp.json')
    await upsertJsonMcpConfig(file, 'mcpServers')
    const first = await fs.readFile(file, 'utf-8')
    expect(await upsertJsonMcpConfig(file, 'mcpServers')).toBe('skipped')
    expect(await fs.readFile(file, 'utf-8')).toBe(first)

    const plugin = path.join(dir, 'plugin.json')
    await fs.writeFile(plugin, JSON.stringify({ mcpServers: { 'vibe-testing': ENTRY } }))
    expect(await upsertJsonMcpConfig(plugin, 'mcpServers')).toBe('skipped')
  })

  it('never overwrites a file it cannot parse (comments, syntax errors, wrong shape)', async () => {
    const dir = await tempDir()
    for (const content of ['{ // my servers\n "mcpServers": {} }', '{ "mcpServers": ', '[]', '{ "mcpServers": [] }']) {
      const file = path.join(dir, 'mcp.json')
      await fs.writeFile(file, content)
      expect(await upsertJsonMcpConfig(file, 'mcpServers')).toBe('unreadable')
      expect(await fs.readFile(file, 'utf-8')).toBe(content)
    }
  })

  it('fills an empty file', async () => {
    const file = path.join(await tempDir(), 'mcp.json')
    await fs.writeFile(file, '')
    expect(await upsertJsonMcpConfig(file, 'mcpServers')).toBe('created')
  })
})

describe('upsertCodexToml', () => {
  it('creates ~/.codex/config.toml with the server table', async () => {
    const file = path.join(await tempDir(), '.codex', 'config.toml')
    expect(await upsertCodexToml(file)).toBe('created')
    expect(await fs.readFile(file, 'utf-8')).toBe(
      '[mcp_servers.vibe-test]\ncommand = "npx"\nargs = ["-y", "vibe-testing@latest", "--mcp"]\n',
    )
  })

  it('appends to an existing config without changing a byte of it', async () => {
    const file = path.join(await tempDir(), 'config.toml')
    const existing = 'model = "gpt-5"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]'
    await fs.writeFile(file, existing)
    expect(await upsertCodexToml(file)).toBe('updated')
    expect(await fs.readFile(file, 'utf-8')).toBe(`${existing}\n\n${codexTomlBlock()}`)
  })

  it('is idempotent', async () => {
    const file = path.join(await tempDir(), 'config.toml')
    await fs.writeFile(file, 'model = "gpt-5"\n')
    await upsertCodexToml(file)
    const first = await fs.readFile(file, 'utf-8')
    expect(await upsertCodexToml(file)).toBe('skipped')
    expect(await upsertCodexToml(file)).toBe('skipped')
    expect(await fs.readFile(file, 'utf-8')).toBe(first)
    expect(first.match(/\[mcp_servers\.vibe-test\]/g)).toHaveLength(1)
  })

  it('recognises an entry added by hand or by `codex mcp add` under either name', async () => {
    const dir = await tempDir()
    for (const header of ['[mcp_servers.vibe-testing]', '[mcp_servers."vibe-test"]', '  [ mcp_servers . vibe-test ]']) {
      const file = path.join(dir, 'config.toml')
      await fs.writeFile(file, `${header}\ncommand = "npx"\n`)
      expect(await upsertCodexToml(file)).toBe('skipped')
    }
  })

  it('leaves an inline mcp_servers table alone (appending would break the file)', async () => {
    const file = path.join(await tempDir(), 'config.toml')
    const existing = 'mcp_servers = { other = { command = "x" } }\n'
    await fs.writeFile(file, existing)
    expect(await upsertCodexToml(file)).toBe('unreadable')
    expect(await fs.readFile(file, 'utf-8')).toBe(existing)
  })
})

describe('next steps and manual commands', () => {
  it('gives one step per configured editor, then the sentence to say', () => {
    const steps = buildNextSteps({ editors: ['Claude Code', 'Codex'], appUrl: 'http://localhost:5173' })
    expect(steps[0]).toMatch(/^Claude Code: Start a new `claude` session/)
    expect(steps[1]).toMatch(/^Codex: Start a new `codex` session/)
    expect(steps[2]).toBe('Then say to your agent: "Scan this codebase and test it against http://localhost:5173"')
    expect(steps[3]).toContain('npx vibe-testing@latest run http://localhost:5173')
  })

  it('documents the one-line commands for Claude Code, Codex and VS Code', () => {
    expect(MANUAL_COMMANDS['Claude Code']).toBe('claude mcp add --scope user vibe-test -- npx -y vibe-testing@latest --mcp')
    expect(MANUAL_COMMANDS['Codex']).toBe('codex mcp add vibe-test -- npx -y vibe-testing@latest --mcp')
    expect(JSON.parse(MANUAL_COMMANDS['VS Code (Copilot)'].replace(/^code --add-mcp '|'$/g, ''))).toEqual({ name: 'vibe-test', type: 'stdio', ...ENTRY })
  })
})

describe('init end to end (temporary HOME and project)', () => {
  function init(home: string, project: string, ...args: string[]) {
    const tsx = path.resolve('node_modules/.bin/tsx')
    return spawnSync(tsx, [path.resolve('src/cli.ts'), 'init', '--skip-browser-install', ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '' },
    })
  }
  const exists = (file: string) => fs.access(file).then(() => true, () => false)

  it('registers Claude Code, Cursor and Codex where each one reads its config', async () => {
    const root = await tempDir()
    const home = path.join(root, 'home')
    const project = path.join(root, 'proj')
    await fs.mkdir(path.join(home, '.claude'), { recursive: true })
    await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n')

    const first = init(home, project)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('Detected editors: Cursor, Claude Code, Codex')

    // Claude Code: user scope is ~/.claude.json, never ~/.claude/settings.json.
    expect(JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf-8')).mcpServers['vibe-test'].command).toBe('npx')
    expect(await exists(path.join(home, '.claude', 'settings.json'))).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(project, '.mcp.json'), 'utf-8')).mcpServers['vibe-test'].type).toBe('stdio')
    // Cursor: global and project.
    expect(JSON.parse(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).mcpServers['vibe-test']).toBeTruthy()
    expect(await exists(path.join(project, '.cursor', 'mcp.json'))).toBe(true)
    // Codex: table appended, existing settings kept.
    const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
    expect(toml).toBe(`model = "gpt-5"\n\n${codexTomlBlock()}`)
    expect(first.stdout).toContain('Then say to your agent: "Scan this codebase and test it against')

    const second = init(home, project)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('Everything is already set up.')
    expect(await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')).toBe(toml)
  }, 60000)

  it('with no editor installed, writes project configs only and prints the manual commands', async () => {
    const root = await tempDir()
    const home = path.join(root, 'home')
    const project = path.join(root, 'proj')
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(project, { recursive: true })

    for (let run = 0; run < 2; run++) {
      const result = init(home, project)
      expect(result.status, result.stderr).toBe(0)
      expect(await fs.readdir(home)).toEqual([])
      if (run === 0) {
        expect(result.stdout).toContain('No editor detected on this machine')
        expect(result.stdout).toContain(MANUAL_COMMANDS['Codex'])
        expect(result.stdout).toContain(MANUAL_COMMANDS['Claude Code'])
      }
    }
    expect(await exists(path.join(project, '.mcp.json'))).toBe(true)
    expect(await exists(path.join(project, '.cursor', 'mcp.json'))).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(project, '.vscode', 'mcp.json'), 'utf-8')).servers['vibe-test'].type).toBe('stdio')
  }, 60000)

  it('--editor codex registers Codex even when it is not detected', async () => {
    const root = await tempDir()
    const home = path.join(root, 'home')
    const project = path.join(root, 'proj')
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    const result = init(home, project, '--editor', 'codex')
    expect(result.status, result.stderr).toBe(0)
    expect(await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')).toBe(codexTomlBlock())
  }, 60000)
})
