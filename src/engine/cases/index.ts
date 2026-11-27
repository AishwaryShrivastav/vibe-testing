import fs from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { VibeConfigSchema, type VibeConfigInput } from '../../types/config.js'
import { readCaseFiles } from './parse.js'
import { runCases, type CaseRunOptions, type CaseRunResult } from './run.js'
import { toHtml, toJson, toJUnit, toLedger } from './reports.js'

export { parseCaseMarkdown, readCaseFiles, resolveBase, type TestCase, type CaseFile } from './parse.js'
export { parseSteps, tokenize, type CaseOptions } from './dsl.js'
export { runCases, type CaseResult, type CaseRunResult, type CaseStatus } from './run.js'
export { toHtml, toJson, toJUnit, toLedger, isoWithOffset } from './reports.js'

export interface RunCaseFilesInput extends Omit<CaseRunOptions, 'outDir' | 'projectRoot'> {
  files: string[]
  /** vibe.config.json contents (url may be omitted when the files say @base or baseUrl is given). */
  config: Omit<VibeConfigInput, 'url'> & { url?: string }
  projectRoot: string
  /** Output folder for report.html, results.json and screenshots (default <projectRoot>/.vibe/cases). */
  outDir?: string
  junit?: string
  json?: string
  ledger?: { file: string; task: string; stage?: string; by?: string; path?: string }
  sha?: string
  toolVersion: string
  idPattern?: RegExp
}

export interface RunCaseFilesOutput {
  run: CaseRunResult
  report_path: string
  json_path: string
  junit_path?: string
  ledger_path?: string
  sha?: string
  /** File-level problems (unreadable vibe blocks before the first case). */
  warnings: string[]
}

async function gitSha(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim() || undefined
  } catch { return undefined }
}

/** Reads case files, runs them, and writes report.html + results.json (+ JUnit / ledger when asked). */
export async function runCaseFiles(input: RunCaseFilesInput): Promise<RunCaseFilesOutput> {
  const outDir = path.resolve(input.outDir ?? path.join(input.projectRoot, '.vibe', 'cases'))
  await fs.mkdir(outDir, { recursive: true })
  const files = await readCaseFiles(input.files, input.idPattern)
  // The schema needs a URL; static-design runs may only have @base in the files.
  const config = VibeConfigSchema.parse({ ...input.config, url: input.baseUrl ?? input.config.url ?? 'http://localhost' })
  const configUrl = input.config.url ?? input.baseUrl
  const run = await runCases(files, { ...config, url: configUrl ?? '' }, { ...input, outDir, projectRoot: input.projectRoot })
  const sha = input.sha ?? await gitSha(input.projectRoot)
  const meta = { tool_version: input.toolVersion, base_url: input.baseUrl ?? input.config.url, sha, files: files.map(f => f.file) }

  const reportPath = path.join(outDir, 'report.html')
  const jsonPath = input.json ? path.resolve(input.json) : path.join(outDir, 'results.json')
  await fs.writeFile(reportPath, toHtml(run, meta, outDir), 'utf8')
  await fs.mkdir(path.dirname(jsonPath), { recursive: true })
  await fs.writeFile(jsonPath, JSON.stringify(toJson(run, meta, path.dirname(jsonPath)), null, 2) + '\n', 'utf8')
  let junitPath: string | undefined
  if (input.junit) {
    junitPath = path.resolve(input.junit)
    await fs.mkdir(path.dirname(junitPath), { recursive: true })
    await fs.writeFile(junitPath, toJUnit(run), 'utf8')
  }
  let ledgerPath: string | undefined
  if (input.ledger) {
    ledgerPath = path.resolve(input.ledger.file)
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true })
    // Append-only, like the ledger itself.
    await fs.appendFile(ledgerPath, toLedger(run, {
      task: input.ledger.task, stage: input.ledger.stage ?? 'E4_vibe_test', by: input.ledger.by ?? 'agent:vibe-testing',
      sha, path: input.ledger.path ?? path.relative(process.cwd(), reportPath),
    }), 'utf8')
  }
  return { run, report_path: reportPath, json_path: jsonPath, junit_path: junitPath, ledger_path: ledgerPath, sha, warnings: files.flatMap(f => f.errors) }
}
