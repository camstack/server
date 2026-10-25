/**
 * Whether a composition still needs required value fields (D939).
 */
import type { CompositionProblem } from '../composition-report.js'

export type CompositionFillStatus = 'complete' | 'incomplete'

export function isUnfilledRequiredProblem(problem: CompositionProblem): boolean {
  return problem.code === 'missing-field'
}

export function compositionFillStatus(
  problems: readonly CompositionProblem[],
): CompositionFillStatus {
  return problems.some(isUnfilledRequiredProblem) ? 'incomplete' : 'complete'
}

/** True when the only problems are unfilled required fields — save may proceed. */
export function problemsBlockSave(problems: readonly CompositionProblem[]): boolean {
  return problems.some((p) => !isUnfilledRequiredProblem(p))
}
