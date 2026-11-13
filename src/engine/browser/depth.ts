/**
 * How much of the explorer runs on a page.
 * light:    load + passive checks (server/console errors, broken values and
 *           resources, crash text); no clicks or submissions.
 * standard: light + tabs, fills, toggles, buttons that don't change data
 *           (incl. the empty-state check), links checked by request.
 * thorough: everything: also data-changing buttons, the in-app journey,
 *           totals after actions, create-then-verify and boundary probes.
 */
export type Depth = 'light' | 'standard' | 'thorough'

export const DEPTH_RANK: Record<Depth, number> = { light: 0, standard: 1, thorough: 2 }

export interface DepthDecision {
  depth: Depth
  /** Why, in a few words: "changed src/pages/POSPage.jsx", "unchanged", "same template as /tutorial/a1". */
  reason: string
}

export function atLeast(a: Depth, b: Depth): boolean {
  return DEPTH_RANK[a] >= DEPTH_RANK[b]
}

/** The deeper of two decisions (the first wins a tie). */
export function deeperOf(a: DepthDecision, b: DepthDecision | undefined): DepthDecision {
  if (!b) return a
  return DEPTH_RANK[b.depth] > DEPTH_RANK[a.depth] ? b : a
}
