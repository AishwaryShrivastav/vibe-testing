import path from 'path'
import { pathToFileURL } from 'url'
import fs from 'fs/promises'
import type { TestStep } from '../../types/index.js'
import { parseSteps, type CaseOptions } from './dsl.js'

/**
 * Test cases written in markdown, the way product teams already write them:
 *
 *   ### TC-r2-06 Wrong password (P0)
 *   - Steps: ...
 *   - vibe: "Sign in with the password wrong and check ..."
 *
 *   ```vibe
 *   open v1.html?clean=1
 *   fill "label=Work email" aish@example.com
 *   ...
 *   ```
 *
 * A heading whose first word is a case id (TC-..., or any id given by
 * --id-pattern) starts a case; the case runs until the next heading of the
 * same or a higher level. Priority comes from "(P0)" in the heading, a
 * "priority: P1" line, or a summary table row. The natural-language hint
 * ("vibe:" or "Vibe-testing hint:") is kept for the report. A ```vibe (or
 * ```vibe-testing / ```vibe-json) block holds the runnable steps; a case
 * without one is listed as "needs steps", never as passed. A vibe block
 * before the first case sets defaults (base URL, viewports, motion, auth)
 * for every case in the file.
 */

export interface TestCase {
  id: string
  title: string
  priority?: string
  file: string
  /** 1-based line of the heading. */
  line: number
  hint?: string
  steps: TestStep[]
  options: CaseOptions
  /** Why the steps could not be read, when they could not. */
  parse_error?: string
  /** "live", "manual" or other tags from the heading or @tag. */
  tags: string[]
  /** "automatable: no" or "manual" in the case. */
  manual: boolean
}

export interface CaseFile {
  file: string
  defaults: CaseOptions
  cases: TestCase[]
  /** Problems in file-level blocks. */
  errors: string[]
}

export const DEFAULT_ID_PATTERN = /^(TC-[A-Za-z0-9][\w.-]*)/

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE_OPEN = /^\s*(```+|~~~+)\s*([\w-]*)\s*(.*)$/
const VIBE_LANGS = new Set(['vibe', 'vibe-testing', 'vibe-json', 'vibetest'])

function priorityOf(text: string): string | undefined {
  return text.match(/\b(P[0-4])\b/)?.[1]
}

/** Cleans a heading into a title: drops the id, "(P0, WCAG ...)", "(live)". */
function titleOf(rest: string): string {
  return rest
    .replace(/^[\s:.\-–—]+/, '')
    .replace(/^\((?:P\d|live|manual)[^)]*\)[\s:.\-–—]*/i, '')
    .replace(/\s*\((?:P\d|live|manual)[^)]*\)\s*$/i, '')
    .trim()
}

function hintOf(line: string): string | undefined {
  const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:vibe(?:-testing)?(?: hint)?|vibe-testing hint)(?:\*\*)?\s*(?:\([^)]*\))?\s*:\s*(.+)$/i)
  if (!m) return undefined
  return m[1].trim().replace(/^["“]|["”]$/g, '').trim()
}

export function parseCaseMarkdown(markdown: string, file: string, idPattern: RegExp = DEFAULT_ID_PATTERN): CaseFile {
  const lines = markdown.split(/\r?\n/)
  const result: CaseFile = { file, defaults: {}, cases: [], errors: [] }
  const tablePriority = new Map<string, string>()
  const tableManual = new Set<string>()
  let current: (TestCase & { level: number }) | undefined
  let inFence: { marker: string; lang: string; start: number; body: string[] } | undefined
  let hintNext = false

  const finish = () => { if (current) { const { level: _level, ...tc } = current; result.cases.push(tc) } current = undefined }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inFence) {
      if (line.trim().startsWith(inFence.marker) && line.trim().replace(/[`~]/g, '') === '') {
        if (VIBE_LANGS.has(inFence.lang)) {
          try {
            const parsed = parseSteps(inFence.body.join('\n'), inFence.start + 1)
            if (current) {
              current.steps.push(...parsed.steps)
              current.options = { ...current.options, ...parsed.options }
            } else {
              result.defaults = { ...result.defaults, ...parsed.options }
              if (parsed.steps.length) result.errors.push(`${file}:${inFence.start}: steps before the first case are ignored (only @options apply to every case)`)
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (current) current.parse_error = message
            else result.errors.push(`${file}: ${message}`)
          }
        }
        inFence = undefined
      } else inFence.body.push(line)
      continue
    }
    const fence = line.match(FENCE_OPEN)
    if (fence) {
      inFence = { marker: fence[1], lang: fence[2].toLowerCase(), start: i + 1, body: [] }
      continue
    }

    // Summary tables: | TC-FF-01 | Seed notebook | P0 | yes (live) |
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean)
      const id = cells[0]?.match(idPattern)?.[1]
      if (id) {
        const p = cells.slice(1).map(priorityOf).find(Boolean)
        if (p) tablePriority.set(id, p)
        // An "automatable" column saying manual or no ("no (needs a mailbox); unit"), not a title like "No steps".
        if (cells.slice(1).some(c => /^manual\b/i.test(c) || /^no(\s*[(;,].*)?$/i.test(c))) tableManual.add(id)
      }
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const level = heading[1].length
      const text = heading[2]
      const id = text.match(idPattern)?.[1]
      if (id) {
        finish()
        hintNext = false
        const rest = text.slice(id.length)
        const tags = [...rest.matchAll(/\((live|manual)[^)]*\)/gi)].map(m => m[1].toLowerCase())
        current = {
          id, title: titleOf(rest) || id, priority: priorityOf(rest), file, line: i + 1,
          steps: [], options: {}, tags, manual: tags.includes('manual'), level,
        }
        continue
      }
      if (current && level <= current.level) finish()
      // "## vibe-testing hint" as a section heading: its first line is the hint.
      else if (current && /\bvibe(?:-testing)?\s+hint\b/i.test(text)) hintNext = true
      continue
    }

    if (current && hintNext && line.trim()) {
      hintNext = false
      if (!current.hint) current.hint = line.trim().replace(/^["“]|["”]$/g, '').trim()
      continue
    }
    if (current) {
      const hint = hintOf(line)
      if (hint && !current.hint) current.hint = hint
      if (!current.priority) {
        const p = line.match(/\bpriority\s*:\s*(P[0-4])\b/i)?.[1]
        if (p) current.priority = p
      }
      if (/\bautomatable(?: by vibe-testing)?\s*:\s*no\b/i.test(line) || /\bmanual only\b/i.test(line)) current.manual = true
    }
  }
  finish()

  for (const tc of result.cases) {
    if (!tc.priority) tc.priority = tablePriority.get(tc.id)
    if (tableManual.has(tc.id)) tc.manual = true
    if (tc.options.tags) tc.tags = [...new Set([...tc.tags, ...tc.options.tags])]
  }
  return result
}

/** Reads case files (markdown, or JSON: an array of {id, title, steps, ...}). */
export async function readCaseFiles(files: string[], idPattern?: RegExp): Promise<CaseFile[]> {
  const out: CaseFile[] = []
  for (const file of files) {
    const abs = path.resolve(file)
    const text = await fs.readFile(abs, 'utf8')
    if (/\.json$/i.test(abs)) out.push(parseCaseJson(text, abs))
    else out.push(parseCaseMarkdown(text, abs, idPattern))
  }
  return mergeCaseFiles(out)
}

/**
 * A case id that appears in more than one file is one case: the first file
 * keeps it (title, priority, hint), and a later file's steps and options are
 * added to it. This lets steps live in a separate file next to cases that
 * someone else owns ("steps overlay"). The later file's @options (e.g. @base)
 * apply to the cases it fills in.
 */
export function mergeCaseFiles(files: CaseFile[]): CaseFile[] {
  const seen = new Map<string, { tc: TestCase; file: CaseFile }>()
  const out: CaseFile[] = []
  for (const file of files) {
    const kept: TestCase[] = []
    for (const tc of file.cases) {
      const first = seen.get(tc.id)
      if (!first) { seen.set(tc.id, { tc, file }); kept.push(tc); continue }
      const target = first.tc
      if (tc.steps.length) {
        target.steps = [...target.steps, ...tc.steps]
        target.options = { ...first.file.defaults, ...file.defaults, ...target.options, ...tc.options }
        // A relative @base belongs to the file that said it.
        const base = tc.options.base ?? file.defaults.base
        if (base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) target.options.base = pathToFileURL(path.resolve(path.dirname(file.file), base)).href
        target.parse_error ??= tc.parse_error
        target.manual = target.manual && tc.manual
      } else if (tc.parse_error) target.parse_error ??= tc.parse_error
      target.priority ??= tc.priority
      target.hint ??= tc.hint
      target.tags = [...new Set([...target.tags, ...tc.tags])]
    }
    if (kept.length || file.errors.length) out.push({ ...file, cases: kept })
  }
  return out
}

function parseCaseJson(text: string, file: string): CaseFile {
  const data = JSON.parse(text) as unknown
  const list = (Array.isArray(data) ? data : (data as { cases?: unknown[] }).cases ?? []) as Array<Record<string, unknown>>
  const cases: TestCase[] = list.map((c, i) => {
    const parsed = parseSteps(JSON.stringify({ ...c, steps: c.steps ?? [] }))
    return {
      id: String(c.id ?? `case-${i + 1}`), title: String(c.title ?? c.name ?? c.id ?? `case ${i + 1}`),
      priority: typeof c.priority === 'string' ? c.priority : undefined, file, line: 0,
      hint: typeof c.hint === 'string' ? c.hint : undefined,
      steps: parsed.steps, options: parsed.options, tags: Array.isArray(c.tags) ? c.tags.map(String) : [], manual: c.manual === true,
    }
  })
  return { file, defaults: {}, cases, errors: [] }
}

/**
 * Base URL for a case: an explicit run URL wins; then @base from the case or
 * file (relative to the markdown file, so `@base .` serves static designs from
 * their folder over file://); then the config URL.
 */
export function resolveBase(tc: Pick<TestCase, 'file' | 'options'>, defaults: CaseOptions, explicit?: string, configUrl?: string): string | undefined {
  if (explicit) return withSlash(explicit)
  const base = tc.options.base ?? defaults.base
  if (base) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return withSlash(base)
    return withSlash(pathToFileURL(path.resolve(path.dirname(tc.file), base)).href)
  }
  return configUrl ? withSlash(configUrl) : undefined
}

/** Directories need a trailing slash so relative URLs resolve inside them; an http origin is left as is. */
function withSlash(url: string): string {
  if (/^file:/i.test(url)) return /\.[a-z0-9]+$/i.test(url) || url.endsWith('/') ? url : `${url}/`
  return url
}
