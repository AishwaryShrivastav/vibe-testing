import { VibeRunResult, CoverageGapSuggestion, RouteBehaviour } from '../types/index.js'
import { VibeConfigSchema, type VibeConfig, type VibeConfigInput } from '../types/config.js'
import { buildProductModel } from './context/index.js'
import { executeScenarios, type PageExploration } from './browser/index.js'
import { MemoryManager } from './memory/index.js'
import { generateHtmlReport } from './reporter/html.js'
import { logger } from '../utils/logger.js'
import { exec } from 'child_process'
import fs from 'fs/promises'
import path from 'path'

export class VibeTester {
  private config: VibeConfig
  private projectRoot: string

  constructor(rawConfig: VibeConfigInput) {
    this.config = VibeConfigSchema.parse(rawConfig)
    this.projectRoot = this.config.codebase_path ?? process.cwd()
  }

  async run(): Promise<VibeRunResult> {
    const startTime = Date.now()

    logger.section(`Vibe Testing — ${this.config.url}`)

    const memory = new MemoryManager(this.projectRoot)
    await memory.load()
    const recommendations = memory.getRecommendations()

    if (!recommendations.first_run) {
      logger.info(`Using intelligence from ${memory.getMemory().run_count} previous run(s)`)
    }

    const productModel = await buildProductModel(this.config, memory.getMemory(), recommendations)

    if (productModel.scenarios.length === 0) {
      logger.warn('No test scenarios generated. Check codebase path and scope config.')
      const reportPath = path.join(this.projectRoot, '.vibe', 'report.html')
      const emptyReport = '<html><body><h1>Vibe Test Report</h1><p>No scenarios generated.</p></body></html>'
      await fs.mkdir(path.dirname(reportPath), { recursive: true })
      await fs.writeFile(reportPath, emptyReport, 'utf-8')
      return {
        product_model: productModel,
        results: [],
        report: emptyReport,
        report_path: reportPath,
        coverage_gaps: [],
        summary: { total: 0, passed: 0, failed: 0, errors: 0, duration_ms: 0, elements_explored: 0, api_calls_observed: 0 },
      }
    }

    const { results, explorations } = await executeScenarios(productModel.scenarios, this.config, this.projectRoot)

    await memory.updateFromResults(results)

    // Generate coverage gap suggestions
    const coverageGaps = generateCoverageGaps(productModel.behaviours, explorations)

    if (coverageGaps.length > 0) {
      logger.section('Coverage gaps found')
      for (const gap of coverageGaps.slice(0, 5)) {
        logger.warn(`  ${gap.severity.toUpperCase()}: ${gap.missing} (${gap.route})`)
      }
    }

    const recs = memory.getRecommendations()
    const report = await generateHtmlReport(results, productModel, this.config, explorations, coverageGaps, recs)
    const reportPath = path.join(this.projectRoot, '.vibe', 'report.html')
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, report, 'utf-8')

    const passed  = results.filter(r => r.status === 'pass').length
    const failed  = results.filter(r => r.status === 'fail').length
    const errors  = results.filter(r => r.status === 'error').length
    const duration = Date.now() - startTime
    const elementsExplored = explorations.reduce((sum, e) => sum + e.elements_discovered, 0)
    const apiCallsObserved = explorations.reduce((sum, e) => sum + e.api_calls.length, 0)

    logger.section('Run complete')
    logger.success(`Passed: ${passed}`)
    if (failed > 0)  logger.error(`Failed: ${failed}`)
    if (errors > 0)  logger.warn(`Errors: ${errors}`)
    if (elementsExplored > 0) logger.dim(`Elements explored: ${elementsExplored} across ${explorations.length} pages`)
    if (apiCallsObserved > 0) logger.dim(`API calls observed: ${apiCallsObserved}`)
    if (coverageGaps.length > 0) logger.warn(`Coverage gaps: ${coverageGaps.length} missing test areas`)
    logger.dim(`Report saved to: ${reportPath}`)
    logger.dim(`Duration: ${(duration / 1000).toFixed(1)}s`)

    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${openCmd} "${reportPath}"`, () => {})

    return {
      product_model: productModel,
      results,
      report,
      report_path: reportPath,
      coverage_gaps: coverageGaps,
      summary: { total: results.length, passed, failed, errors, duration_ms: duration, elements_explored: elementsExplored, api_calls_observed: apiCallsObserved },
    }
  }
}

// ─── Coverage Gap Analysis ────────────────────────────────────────────────────

function generateCoverageGaps(
  behaviours: RouteBehaviour[],
  explorations: PageExploration[]
): CoverageGapSuggestion[] {
  const gaps: CoverageGapSuggestion[] = []

  for (const behaviour of behaviours) {
    const route = behaviour.route.path
    const func = behaviour.functionality
    if (!func) continue

    const exploration = explorations.find(e => e.route === route)

    // Check CRUD operations: if code has a create mutation but no test created an item
    for (const feature of func.features) {
      if (feature.type === 'crud_create') {
        const dialog = func.dialogs[0]
        if (dialog && dialog.fields.length > 0) {
          gaps.push({
            route,
            missing: `No end-to-end test for creating ${feature.name.replace('Create ', '')} via "${dialog.title || dialog.trigger}" dialog`,
            severity: 'critical',
            suggested_test: {
              name: `Create ${feature.name.replace('Create ', '')} on ${route}`,
              steps: [
                `Navigate to ${route}`,
                `Click "${dialog.trigger}" to open dialog`,
                ...dialog.fields.map(f => `Fill "${f.placeholder || f.name}" with test data`),
                `Click "${dialog.submit_text || 'Submit'}"`,
                `Verify new item appears in list or success toast shown`,
              ],
            },
          })
        }
      }

      if (feature.type === 'crud_update') {
        gaps.push({
          route,
          missing: `No test for updating ${feature.name.replace('Update ', '')}`,
          severity: 'important',
          suggested_test: {
            name: `Update ${feature.name.replace('Update ', '')} on ${route}`,
            steps: [
              `Navigate to ${route}`,
              `Click an existing item to select it`,
              `Modify fields with new data`,
              `Save changes`,
              `Verify updated values persist`,
            ],
          },
        })
      }

      if (feature.type === 'crud_delete') {
        gaps.push({
          route,
          missing: `No test for deleting ${feature.name.replace('Delete ', '')}`,
          severity: 'important',
          suggested_test: {
            name: `Delete ${feature.name.replace('Delete ', '')} on ${route}`,
            steps: [
              `Navigate to ${route}`,
              `Click delete on an item`,
              `Confirm deletion in dialog`,
              `Verify item removed from list`,
            ],
          },
        })
      }

      if (feature.type === 'pagination') {
        gaps.push({
          route,
          missing: `No test for pagination on ${route}`,
          severity: 'nice_to_have',
          suggested_test: {
            name: `Pagination on ${route}`,
            steps: [
              `Navigate to ${route}`,
              `Verify page 1 content displayed`,
              `Click "Next" or page 2`,
              `Verify different content loaded`,
              `Click "Previous" or page 1`,
              `Verify original content restored`,
            ],
          },
        })
      }

      if (feature.type === 'upload') {
        gaps.push({
          route,
          missing: `No test for file upload on ${route}`,
          severity: 'important',
          suggested_test: {
            name: `File upload on ${route}`,
            steps: [
              `Navigate to ${route}`,
              `Select file via upload input`,
              `Verify file preview or upload progress`,
              `Submit the upload`,
              `Verify file saved or processing started`,
            ],
          },
        })
      }
    }

    // Check for buttons that weren't successfully tested during exploration
    if (exploration) {
      const brokenElements = exploration.interactions.filter(i => i.result === 'error')
      for (const broken of brokenElements) {
        gaps.push({
          route,
          missing: `Element "${broken.element}" failed during testing: ${broken.details}`,
          severity: 'important',
          suggested_test: {
            name: `Fix "${broken.element}" on ${route}`,
            steps: [
              `Navigate to ${route}`,
              `Locate element "${broken.element}"`,
              `Verify it is visible and clickable`,
              `Test interaction: ${broken.action}`,
              `Verify expected response`,
            ],
          },
        })
      }

      // API errors found during exploration
      const apiErrors = exploration.api_calls.filter(a => a.isError)
      for (const err of apiErrors) {
        gaps.push({
          route,
          missing: `API error: ${err.method} ${err.path} returned ${err.status}`,
          severity: err.status >= 500 ? 'critical' : 'important',
          suggested_test: {
            name: `Fix API ${err.method} ${err.path}`,
            steps: [
              `Navigate to ${route}`,
              `Trigger the action that calls ${err.method} ${err.path}`,
              `Verify API returns 2xx status`,
              `Verify UI handles response correctly`,
            ],
          },
        })
      }
    }
  }

  // Deduplicate by route + missing description
  const seen = new Set<string>()
  return gaps.filter(g => {
    const key = `${g.route}:${g.missing.slice(0, 80)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export { generateCoverageGaps }
export { buildProductModel } from './context/index.js'
export { executeScenarios } from './browser/index.js'
export { MemoryManager } from './memory/index.js'
