import fs from 'fs/promises'
import path from 'path'
import { glob as globFn } from 'glob'

const GENERATED_OUTPUT_DIRECTORIES = ['.next', '.output', 'dist', 'build', 'coverage']
const RECURSIVE_SCAN_IGNORES = ['**/node_modules/**', '**/.git/**', '**/.vibe/**']
const packageRootCache = new Map<string, Promise<string[]>>()

export const SCAN_IGNORES = [
  ...RECURSIVE_SCAN_IGNORES,
  ...GENERATED_OUTPUT_DIRECTORIES.map(directory => `${directory}/**`),
]

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function findPackageRoots(cwd: string): Promise<string[]> {
  const cacheKey = path.resolve(cwd)
  const cached = packageRootCache.get(cacheKey)
  if (cached) return cached

  const discovered = globFn('**/package.json', {
    cwd,
    absolute: false,
    posix: true,
    ignore: [
      ...RECURSIVE_SCAN_IGNORES,
      ...GENERATED_OUTPUT_DIRECTORIES.map(directory => `**/${directory}/**`),
    ],
  }).then(files => [...new Set(
    files
      .map(toPosixPath)
      .map(file => path.posix.dirname(file))
      .filter(root => root !== '.')
  )])

  packageRootCache.set(cacheKey, discovered)
  return discovered
}

async function scanIgnores(cwd: string): Promise<string[]> {
  const packageRoots = await findPackageRoots(cwd)
  return [
    ...SCAN_IGNORES,
    ...packageRoots.flatMap(root =>
      GENERATED_OUTPUT_DIRECTORIES.map(directory => `${root}/${directory}/**`)
    ),
  ]
}

export async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function glob(pattern: string, cwd: string): Promise<string[]> {
  const files = await globFn(pattern, {
    cwd,
    absolute: false,
    posix: true,
    ignore: await scanIgnores(cwd),
  })
  return files.map(toPosixPath)
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}
