import type {
  CompositionExpressionSource,
  CompositionFieldSource,
  CompositionFromSource,
  CompositionSourceRef,
} from '../composition.js'

export function fromRead(
  source: CompositionSourceRef,
  cap: string,
  fieldPath: string,
): CompositionFromSource {
  return { kind: 'from', source, cap, fieldPath }
}

export function expression(
  expr: string,
  bindings: CompositionExpressionSource['bindings'],
): CompositionFieldSource {
  return { kind: 'expression', expr, bindings }
}

export function literal(expr: string): CompositionFieldSource {
  return expression(expr, {})
}

export function isLiteral(source: CompositionFieldSource | undefined, expr: string): boolean {
  return (
    source?.kind === 'expression' &&
    source.expr === expr &&
    Object.keys(source.bindings).length === 0
  )
}
