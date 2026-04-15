import type { RouteBehaviour, CoverageGapSuggestion } from '../types/index.js'
import type { PageExploration } from './browser/index.js'

export function generateCoverageGaps(
  behaviours: RouteBehaviour[],
  explorations: PageExploration[]
): CoverageGapSuggestion[] {
  const gaps: CoverageGapSuggestion[] = []

  for (const behaviour of behaviours) {
    const route = behaviour.route.path
    const func = behaviour.functionality
    if (!func) continue

    const exploration = explorations.find(e => e.route === route)

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

  const seen = new Set<string>()
  return gaps.filter(g => {
    const key = `${g.route}:${g.missing.slice(0, 80)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
