/**
 * Surface composer validation for a formula entry (D939).
 */
import type { CompositionExpressionSource } from '../composition.js'
import { validateExpressionSource } from '../../expression/expression-source.js'

export function formulaProblem(
  expr: string,
  bindings: CompositionExpressionSource['bindings'],
): string | null {
  return validateExpressionSource({ expr, bindings })
}
