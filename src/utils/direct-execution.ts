import { realpathSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

function canonicalPath(filePath: string): string {
  const absolutePath = path.resolve(filePath)
  try {
    return realpathSync.native(absolutePath)
  } catch {
    return absolutePath
  }
}

export function isDirectExecution(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false
  return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(argvPath)
}
