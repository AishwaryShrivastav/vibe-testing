import type { VibeRunResult } from '../types/index.js'
import { VibeConfigSchema, type VibeConfig, type VibeConfigInput } from '../types/config.js'
import { buildProductModel } from './context/index.js'
import { executeScenarios, type PageExploration } from './browser/index.js'
import { MemoryManager } from './memory/index.js'
import { saveRunSnapshot } from './memory/manifest.js'
import { generateHtmlReport } from './reporter/html.js'
import { generateCoverageGaps } from './coverage-gaps.js'
import { runConverge, type ConvergeOptions } from './converge.js'
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

    // Save run snapshot and diff against previous run
    const vibeDir = path.join(this.projectRoot, '.vibe')
    const snapshotDiff = await saveRunSnapshot(vibeDir, results)
    if (snapshotDiff) {
      logger.section('Changes since last run')
      if (snapshotDiff.newly_passing.length > 0)
        logger.success(`  Fixed: ${snapshotDiff.newly_passing.join(', ')}`)
      if (snapshotDiff.newly_failing.length > 0)
        logger.error(`  Regression: ${snapshotDiff.newly_failing.join(', ')}`)
      if (snapshotDiff.new_routes.length > 0)
        logger.info(`  New: ${snapshotDiff.new_routes.join(', ')}`)
      if (snapshotDiff.removed_routes.length > 0)
        logger.warn(`  Removed: ${snapshotDiff.removed_routes.join(', ')}`)
    }

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
      snapshot_diff: snapshotDiff ? {
        newly_passing: snapshotDiff.newly_passing,
        newly_failing: snapshotDiff.newly_failing,
        still_failing: snapshotDiff.still_failing,
        new_routes: snapshotDiff.new_routes,
        removed_routes: snapshotDiff.removed_routes,
      } : undefined,
      summary: { total: results.length, passed, failed, errors, duration_ms: duration, elements_explored: elementsExplored, api_calls_observed: apiCallsObserved },
    }
  }

  /**
   * Iterative coverage: run baseline scenarios, then follow-up rounds from
   * coverage gaps + failed retests until thresholds or max rounds.
   */
  async converge(opts?: ConvergeOptions): Promise<VibeRunResult> {
    const startTime = Date.now()
    logger.section(`Vibe Converge — ${this.config.url}`)

    const memory = new MemoryManager(this.projectRoot)
    await memory.load()

    const cr = await runConverge(this.config, opts)
    const recommendations = memory.getRecommendations()
    const productModel = await buildProductModel(this.config, memory.getMemory(), recommendations)

    // Save run snapshot and diff against previous run
    const convergeVibeDir = path.join(this.projectRoot, '.vibe')
    const convergeSnapshotDiff = await saveRunSnapshot(convergeVibeDir, cr.total_results)
    if (convergeSnapshotDiff) {
      logger.section('Changes since last run')
      if (convergeSnapshotDiff.newly_passing.length > 0)
        logger.success(`  Fixed: ${convergeSnapshotDiff.newly_passing.join(', ')}`)
      if (convergeSnapshotDiff.newly_failing.length > 0)
        logger.error(`  Regression: ${convergeSnapshotDiff.newly_failing.join(', ')}`)
      if (convergeSnapshotDiff.new_routes.length > 0)
        logger.info(`  New: ${convergeSnapshotDiff.new_routes.join(', ')}`)
      if (convergeSnapshotDiff.removed_routes.length > 0)
        logger.warn(`  Removed: ${convergeSnapshotDiff.removed_routes.join(', ')}`)
    }

    const passed = cr.total_results.filter(r => r.status === 'pass').length
    const failed = cr.total_results.filter(r => r.status === 'fail').length
    const errors = cr.total_results.filter(r => r.status === 'error').length
    const elementsExplored = cr.explorations.reduce((sum, e) => sum + e.elements_discovered, 0)
    const apiCallsObserved = cr.explorations.reduce((sum, e) => sum + e.api_calls.length, 0)

    const report = await generateHtmlReport(
      cr.total_results,
      productModel,
      this.config,
      cr.explorations,
      cr.final_gaps,
      recommendations
    )
    const reportPath = path.join(this.projectRoot, '.vibe', 'report.html')
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, report, 'utf-8')

    logger.section('Converge report')
    logger.success(`Rounds: ${cr.rounds}, final gaps: ${cr.final_gaps.length}, total executions: ${cr.total_results.length}`)
    logger.dim(`Report: ${reportPath}`)

    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${openCmd} "${reportPath}"`, () => {})

    return {
      product_model: productModel,
      results: cr.total_results,
      report,
      report_path: reportPath,
      coverage_gaps: cr.final_gaps,
      snapshot_diff: convergeSnapshotDiff ? {
        newly_passing: convergeSnapshotDiff.newly_passing,
        newly_failing: convergeSnapshotDiff.newly_failing,
        still_failing: convergeSnapshotDiff.still_failing,
        new_routes: convergeSnapshotDiff.new_routes,
        removed_routes: convergeSnapshotDiff.removed_routes,
      } : undefined,
      summary: {
        total: cr.total_results.length,
        passed,
        failed,
        errors,
        duration_ms: Date.now() - startTime,
        elements_explored: elementsExplored,
        api_calls_observed: apiCallsObserved,
        converge_rounds: cr.rounds,
      },
    }
  }
}

export { generateCoverageGaps } from './coverage-gaps.js'
export type { ConvergeOptions } from './converge.js'
export { buildProductModel } from './context/index.js'
export { executeScenarios } from './browser/index.js'
export { MemoryManager } from './memory/index.js'
