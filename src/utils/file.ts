import fs from 'fs/promises'
import path from 'path'
import { glob as globFn } from 'glob'

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
  return globFn(pattern, { cwd, absolute: false })
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}
