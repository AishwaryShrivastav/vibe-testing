import fs from 'fs/promises'
import path from 'path'

/** Name the server is registered under in every editor. */
export const MCP_SERVER_NAME = 'vibe-test'
/** Names an earlier setup (init, plugin, or by hand) may have used. */
const KNOWN_SERVER_NAMES = [MCP_SERVER_NAME, 'vibe-testing']

export const MCP_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'vibe-testing@latest', '--mcp'],
}

const SERVER_COMMAND_LINE = `${MCP_SERVER_ENTRY.command} ${MCP_SERVER_ENTRY.args.join(' ')}`

/**
 * - created: the file did not exist (or held no servers) and now holds ours
 * - updated: our entry was added next to existing content
 * - skipped: already registered
 * - unreadable: the file exists but could not be parsed, so it was left untouched
 */
export type UpsertResult = 'created' | 'updated' | 'skipped' | 'unreadable'

export interface JsonConfigOptions {
  /** Write `"type": "stdio"` on the entry (VS Code requires it; Cursor and Claude Code document it). */
  withType?: boolean
}

/**
 * Register the server in a JSON MCP config (`mcpServers` or VS Code's `servers`),
 * keeping everything else in the file. A file that exists but is not plain JSON
 * (comments, a syntax error) is never overwritten.
 */
export async function upsertJsonMcpConfig(
  filePath: string,
  rootKey: string,
  options: JsonConfigOptions = {},
): Promise<UpsertResult> {
  let config: Record<string, any> = {}
  let existed = false
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    existed = true
    if (raw.trim()) {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
      config = parsed
    }
  } catch (error) {
    if (existed) return 'unreadable'
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unreadable'
  }

  const servers = config[rootKey]
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) return 'unreadable'
  if (servers && KNOWN_SERVER_NAMES.some(name => servers[name])) return 'skipped'

  const hadServers = !!servers && Object.keys(servers).length > 0
  config[rootKey] = {
    ...(servers ?? {}),
    [MCP_SERVER_NAME]: options.withType ? { type: 'stdio', ...MCP_SERVER_ENTRY } : { ...MCP_SERVER_ENTRY },
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  // Write then rename: an editor reading its config mid-write (Claude Code
  // keeps live state in ~/.claude.json) must never see half a file.
  const temporary = `${filePath}.vibe-test-${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  await fs.rename(temporary, filePath)
  return hadServers ? 'updated' : 'created'
}

/** The table Codex reads from `~/.codex/config.toml`. */
export function codexTomlBlock(): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(MCP_SERVER_ENTRY.command)}`,
    `args = [${MCP_SERVER_ENTRY.args.map(arg => JSON.stringify(arg)).join(', ')}]`,
  ].join('\n') + '\n'
}

const CODEX_TABLE = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["']?(?:${KNOWN_SERVER_NAMES.join('|')})["']?\\s*\\]`, 'm',
)
/** `mcp_servers = { … }` written inline: appending a table would make the file invalid. */
const CODEX_INLINE_SERVERS = /^\s*mcp_servers\s*=/m

/**
 * Register the server in Codex's `config.toml` by appending its table. The
 * existing text is kept byte for byte, and a second run changes nothing.
 */
export async function upsertCodexToml(filePath: string): Promise<UpsertResult> {
  let existing = ''
  let existed = false
  try {
    existing = await fs.readFile(filePath, 'utf-8')
    existed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unreadable'
  }

  if (CODEX_TABLE.test(existing)) return 'skipped'
  if (CODEX_INLINE_SERVERS.test(existing)) return 'unreadable'

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, existing + separator + codexTomlBlock(), 'utf-8')
  return existed && existing.trim() ? 'updated' : 'created'
}

/** One-line commands that register the server without `init`, keyed by editor name. */
export const MANUAL_COMMANDS: Record<string, string> = {
  'Claude Code': `claude mcp add --scope user ${MCP_SERVER_NAME} -- ${SERVER_COMMAND_LINE}`,
  'Codex': `codex mcp add ${MCP_SERVER_NAME} -- ${SERVER_COMMAND_LINE}`,
  'VS Code (Copilot)': `code --add-mcp '${JSON.stringify({ name: MCP_SERVER_NAME, type: 'stdio', ...MCP_SERVER_ENTRY })}'`,
}

/** What to do in each editor once the config is written. */
export const EDITOR_NEXT_STEP: Record<string, string> = {
  'Claude Code': 'Start a new `claude` session in this folder and approve the vibe-test server when asked. `/mcp` shows it as connected.',
  'Cursor': 'Open Cursor Settings > MCP and check vibe-test is switched on. Reload the window if it is not listed.',
  'Codex': 'Start a new `codex` session (the Codex IDE extension and desktop app read the same config). `/mcp` lists vibe-test.',
  'Windsurf': 'Open the Cascade MCP panel and press Refresh. vibe-test appears in the server list.',
  'VS Code (Copilot)': 'Open .vscode/mcp.json, press Start above vibe-test, then use Agent mode in Copilot Chat.',
  'Roo Code': 'Open the MCP Servers tab in Roo Code and check vibe-test is switched on.',
}

/** The sentence a user says to their agent to run the first test. */
export function firstPrompt(appUrl: string): string {
  return `Scan this codebase and test it against ${appUrl}`
}

/** Lines printed at the end of `init`: one step per configured editor, then the first prompt. */
export function buildNextSteps(input: { editors: string[]; appUrl: string }): string[] {
  const lines: string[] = []
  for (const editor of input.editors) {
    const step = EDITOR_NEXT_STEP[editor]
    if (step) lines.push(`${editor}: ${step}`)
  }
  lines.push(`Then say to your agent: "${firstPrompt(input.appUrl)}"`)
  lines.push('No agent? Run it yourself: npx vibe-testing@latest run ' + input.appUrl)
  return lines
}
