/**
 * Classify one composition field into a card entry.
 */
import type {
  CompositionExpressionSource,
  CompositionFieldRead,
  CompositionFieldSource,
  CompositionFromSource,
} from '../composition.js'
import type {
  CompositionCardFieldEntry,
  ConvertUnitFieldEntry,
  FieldAggregateKind,
} from './card-types.js'

function fromSources(binding: CompositionFromSource): CompositionFieldRead {
  return { source: binding.source, cap: binding.cap, fieldPath: binding.fieldPath }
}

function sameRead(a: CompositionFieldRead, b: CompositionFieldRead): boolean {
  return (
    a.cap === b.cap &&
    a.fieldPath === b.fieldPath &&
    a.source.addonId === b.source.addonId &&
    a.source.stableId === b.source.stableId
  )
}

function bindingNamesInOrder(bindings: CompositionExpressionSource['bindings']): readonly string[] {
  return Object.keys(bindings)
}

function allFromSameCapField(
  field: CompositionExpressionSource,
): { cap: string; fieldPath: string; sources: readonly CompositionFieldRead[] } | null {
  const names = bindingNamesInOrder(field.bindings)
  if (names.length === 0) return null
  const reads: CompositionFieldRead[] = []
  for (const name of names) {
    const binding = field.bindings[name]
    if (binding === undefined || binding.kind !== 'from') return null
    reads.push(fromSources(binding))
  }
  const first = reads[0]
  if (first === undefined) return null
  if (!reads.every((read) => read.cap === first.cap && read.fieldPath === first.fieldPath)) {
    return null
  }
  return { cap: first.cap, fieldPath: first.fieldPath, sources: reads }
}

const CONVERT_EXPR = /^convert\(([A-Za-z_][A-Za-z0-9_]*),\s*"([^"]*)",\s*"([^"]*)"\)$/

function matchConvert(source: CompositionExpressionSource): ConvertUnitFieldEntry | null {
  const match = CONVERT_EXPR.exec(source.expr.trim())
  if (match === null) return null
  const name = match[1]
  const from = match[2]
  const to = match[3]
  if (name === undefined || from === undefined || to === undefined) return null
  if (from === '' || to === '' || from === to) return null
  const names = Object.keys(source.bindings)
  if (names.length !== 1 || names[0] !== name) return null
  const binding = source.bindings[name]
  if (binding === undefined || binding.kind !== 'from') return null
  return {
    kind: 'convert-unit',
    bindingName: name,
    from,
    to,
    source: fromSources(binding),
  }
}

function matchAggregate(
  field: CompositionExpressionSource,
  aggregate: FieldAggregateKind,
): readonly CompositionFieldRead[] | null {
  const shared = allFromSameCapField(field)
  if (shared === null) return null
  const names = bindingNamesInOrder(field.bindings)
  const joined = names.join(', ')
  if (aggregate === 'avg-round-1' && field.expr === `round(avg(${joined}), 1)`) {
    return shared.sources
  }
  if (aggregate === 'max' && field.expr === `max(${joined})`) {
    return shared.sources
  }
  return null
}

export function classifyFieldSource(source: CompositionFieldSource): CompositionCardFieldEntry {
  if (source.kind === 'from') {
    return {
      kind: 'from',
      sources: [fromSources(source)],
      aggregate: null,
    }
  }
  if (source.kind !== 'expression') {
    return {
      kind: 'formula',
      expr: '',
      bindings: {},
    }
  }
  if (source.expr === 'now' && Object.keys(source.bindings).length === 0) {
    return { kind: 'companion', companion: 'now' }
  }
  const avgSources = matchAggregate(source, 'avg-round-1')
  if (avgSources !== null) {
    return { kind: 'from', sources: avgSources, aggregate: 'avg-round-1' }
  }
  const maxSources = matchAggregate(source, 'max')
  if (maxSources !== null) {
    return { kind: 'from', sources: maxSources, aggregate: 'max' }
  }
  const convert = matchConvert(source)
  if (convert !== null) return convert
  return {
    kind: 'formula',
    expr: source.expr,
    bindings: source.bindings,
  }
}

export function fieldEntryToSource(
  entry: CompositionCardFieldEntry,
  original: CompositionFieldSource | undefined,
): CompositionFieldSource {
  if (entry.kind === 'formula') {
    return { kind: 'expression', expr: entry.expr, bindings: entry.bindings }
  }
  if (entry.kind === 'convert-unit') {
    return {
      kind: 'expression',
      expr: `convert(${entry.bindingName}, ${JSON.stringify(entry.from)}, ${JSON.stringify(entry.to)})`,
      bindings: {
        [entry.bindingName]: {
          kind: 'from',
          source: entry.source.source,
          cap: entry.source.cap,
          fieldPath: entry.source.fieldPath,
        },
      },
    }
  }
  if (entry.kind === 'companion') {
    return { kind: 'expression', expr: 'now', bindings: {} }
  }
  if (entry.aggregate === null) {
    const first = entry.sources[0]
    if (first === undefined) {
      return original ?? { kind: 'expression', expr: 'null', bindings: {} }
    }
    return {
      kind: 'from',
      source: first.source,
      cap: first.cap,
      fieldPath: first.fieldPath,
    }
  }
  if (original !== undefined && original.kind === 'expression') {
    return original
  }
  return { kind: 'expression', expr: 'null', bindings: {} }
}

export { sameRead }
