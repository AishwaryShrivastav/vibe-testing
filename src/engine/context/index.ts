import { ProductModel, Memory } from '../../types/index.js'
import { VibeConfig, VibeGuidance } from '../../types/config.js'
import { detectFramework } from './detector.js'
import { parseRoutes } from './router.js'
import { extractBehaviours } from './extractor.js'
import { readExistingTests } from './test-reader.js'
import { analyzeGaps } from './gap-analyzer.js'
import { generateScenarios } from './enricher.js'
import { logger } from '../../utils/logger.js'
import { readVibeGuidance } from '../../utils/vibe-md.js'
import type { MemoryRecommendations } from '../memory/index.js'
import path from 'path'

export async function buildProductModel(
  config: VibeConfig,
  memory: Memory,
  recommendations?: MemoryRecommendations
): Promise<ProductModel> {
  const codebasePath = config.codebase_path ?? process.cwd()
  const mode = config.mode ?? 'deep'

  logger.section('Building product model')

  // Read VIBE.md project guidance
  const guidance = await readVibeGuidance(codebasePath)
  if (guidance) {
    logger.info('Found VIBE.md — applying project guidance')
    if (guidance.login_url && !config.auth?.login_url) {
      logger.dim(`  Login URL from VIBE.md: ${guidance.login_url}`)
    }
    if (guidance.never_automate?.length) {
      logger.dim(`  Never-interact rules from VIBE.md: ${guidance.never_automate.length}`)
    }
    if (guidance.known_flaky?.length) {
      logger.dim(`  Known flaky flows: ${guidance.known_flaky.length}`)
    }
  }

  const spin1 = logger.spin('Detecting framework...')
  const framework = await detectFramework(codebasePath)
  spin1.succeed(`Framework: ${framework}`)

  const spin2 = logger.spin('Parsing routes...')
  let routes = await parseRoutes(framework, codebasePath)

  const { include = ['/**'], exclude = [], max_routes = 30 } = config.scope ?? {}
  routes = routes
    .filter(r => matchesScope(r.path, include, exclude))
    .slice(0, max_routes)

  spin2.succeed(`Found ${routes.length} routes`)

  const spin3 = logger.spin('Extracting route behaviours...')
  const behaviours = await extractBehaviours(routes, mode)
  const totalFeatures = behaviours.reduce((sum, b) => sum + (b.functionality?.features.length ?? 0), 0)
  const totalDialogs = behaviours.reduce((sum, b) => sum + (b.functionality?.dialogs.length ?? 0), 0)
  spin3.succeed(`Behaviours extracted (${totalFeatures} features, ${totalDialogs} dialogs found)`)

  const spin4 = logger.spin('Reading existing test files...')
  const coverage = await readExistingTests(codebasePath)
  const coveredCount = Object.values(coverage).filter(c => c.tested).length
  const totalFlows = Object.values(coverage).reduce((sum, c) => sum + (c.intelligence?.user_flows.length ?? 0), 0)
  const totalSelectors = Object.values(coverage).reduce((sum, c) => {
    const i = c.intelligence?.selectors
    return sum + (i ? i.by_text.length + i.by_role.length + i.by_placeholder.length + i.by_test_id.length : 0)
  }, 0)
  spin4.succeed(`Coverage: ${coveredCount} routes tested, ${totalSelectors} selectors learned, ${totalFlows} user flows found`)

  const spin5 = logger.spin('Analysing test gaps...')
  const gaps = analyzeGaps(routes, coverage, memory)
  const highGaps = gaps.filter(g => g.priority === 'high').length
  spin5.succeed(`Gaps found: ${gaps.length} total (${highGaps} high priority)`)

  const spin6 = logger.spin(`Generating test scenarios (${mode} mode)...`)
  const scenarios = await generateScenarios(gaps, behaviours, coverage, mode, recommendations)
  spin6.succeed(`Generated ${scenarios.length} test scenarios`)

  const projectName = path.basename(codebasePath)

  return {
    project_name: projectName,
    url: config.url,
    framework,
    codebase_path: codebasePath,
    scanned_at: new Date().toISOString(),
    routes,
    behaviours,
    coverage,
    gaps,
    scenarios,
  }
}

function matchesScope(routePath: string, include: string[], exclude: string[]): boolean {
  const matches = (pattern: string, p: string): boolean => {
    const regex = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\//g, '\\/')
    return new RegExp(`^${regex}$`).test(p)
  }

  const included = include.some(p => matches(p, routePath))
  const excluded = exclude.some(p => matches(p, routePath))

  return included && !excluded
}
