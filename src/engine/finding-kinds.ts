/**
 * Which explorer errors are real failures in the app, as opposed to the
 * explorer's own diagnostics (navigation or discovery problems). Kept free of
 * imports so the browser modules can use it without an import cycle.
 */
const EXPLORER_FAILURE = /Server error \d{3}|Crash text|No response within|^Uncaught exception|^Console error|^Broken value|^Broken resource|Empty-state action|Submitted value not shown|^Total mismatch/

/** True when an explorer error is a real failure in the app (not a navigation or discovery diagnostic). */
export function isExplorerFailure(error: string): boolean {
  return EXPLORER_FAILURE.test(error)
}
