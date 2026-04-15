import { Framework } from '../../types/index.js'
import { readJSON, fileExists, glob } from '../../utils/file.js'
import path from 'path'

export async function detectFramework(codebasePath: string): Promise<Framework> {
  const pkg = await readJSON<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    path.join(codebasePath, 'package.json')
  )

  if (!pkg) return 'unknown'

  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  if (deps['next']) {
    const appPages = await glob('app/**/page.{tsx,jsx,ts,js}', codebasePath)
    if (appPages.length > 0) return 'nextjs-app'

    const pagesDir = await fileExists(path.join(codebasePath, 'pages'))
    if (pagesDir) return 'nextjs-pages'

    return 'nextjs-app'
  }

  if (deps['react'] && (deps['react-router-dom'] || deps['react-router'])) {
    return 'react-spa'
  }

  if (deps['express']) return 'express'

  return 'unknown'
}
