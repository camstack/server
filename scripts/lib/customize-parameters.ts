/**
 * A declared behaviour parameter that the catalog projection dropped (D944).
 * Codegen and the parameter guard both refuse a non-empty result.
 */
import type {
  CustomizeCatalogEntry,
  CustomizeCatalogTarget,
  CustomizeCatalogTransform,
} from '../../packages/types/src/capabilities/customize-catalog.ts'
import type {
  CapabilityCustomizeSpec,
  CapabilityCustomizeTarget,
  CustomizeSourceSpec,
  CustomizeTransformSpec,
  EventCustomizeTarget,
  KeyedArrayCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'

export function customizeParameterGaps(
  spec: CapabilityCustomizeSpec,
  entry: CustomizeCatalogEntry,
): readonly string[] {
  const gaps: string[] = []
  for (const target of spec.targets) {
    const projected = entry.targets.find((row) => row.id === target.id)
    if (projected === undefined) {
      gaps.push(`${target.id}`)
      continue
    }
    gaps.push(...gapsForTarget(target, projected))
  }
  return gaps
}

function gapsForTarget(
  target: CapabilityCustomizeTarget,
  projected: CustomizeCatalogTarget,
): readonly string[] {
  switch (target.cardinality) {
    case 'scalar':
      return sourceGaps(target.id, target.sources, projected.sources)
    case 'keyedArray':
      return keyedGaps(target, projected)
    case 'event':
      return eventGaps(target, projected)
  }
}

function keyedGaps(
  target: KeyedArrayCustomizeTarget,
  projected: CustomizeCatalogTarget,
): readonly string[] {
  const gaps: string[] = []
  for (const field of target.fields) {
    const match = projected.fields?.find((row) => row.path === field.path)
    const where = `${target.id}.${field.path}`
    if (match === undefined) {
      gaps.push(where)
      continue
    }
    gaps.push(...sourceGaps(where, field.sources, match.sources))
  }
  return gaps
}

function sourceGaps(
  where: string,
  declared: readonly CustomizeSourceSpec[],
  projected: CustomizeCatalogTarget['sources'],
): readonly string[] {
  const gaps: string[] = []
  declared.forEach((source, index) => {
    const match = projected[index]
    const at = `${where}.sources[${index}]`
    if (match === undefined || match.kind !== source.kind) {
      gaps.push(at)
      return
    }
    source.transforms.forEach((transform, transformIndex) => {
      gaps.push(
        ...transformGaps(
          `${at}.transforms[${transformIndex}]`,
          transform,
          match.transforms[transformIndex],
        ),
      )
    })
  })
  return gaps
}

function transformGaps(
  where: string,
  declared: CustomizeTransformSpec,
  projected: CustomizeCatalogTransform | undefined,
): readonly string[] {
  if (projected === undefined || projected.kind !== declared.kind) return [where]
  switch (declared.kind) {
    case 'identity':
    case 'invert':
      return []
    case 'threshold':
      return thresholdGaps(where, declared, projected)
    case 'linear':
      return linearGaps(where, declared, projected)
    case 'enum-map':
      return enumGaps(where, declared, projected)
  }
}

function thresholdGaps(
  where: string,
  declared: Extract<CustomizeTransformSpec, { kind: 'threshold' }>,
  projected: CustomizeCatalogTransform,
): readonly string[] {
  if (projected.kind !== 'threshold') return [where]
  const gaps: string[] = []
  if (!sameList(projected.comparisons, declared.comparisons)) gaps.push(`${where}.comparisons`)
  if (projected.comparison !== declared.comparison) gaps.push(`${where}.comparison`)
  if (projected.defaultThreshold !== declared.defaultThreshold)
    gaps.push(`${where}.defaultThreshold`)
  if (projected.defaultStartDwellMs !== declared.defaultStartDwellMs) {
    gaps.push(`${where}.defaultStartDwellMs`)
  }
  if (projected.defaultStopDwellMs !== declared.defaultStopDwellMs) {
    gaps.push(`${where}.defaultStopDwellMs`)
  }
  if (projected.thresholdUnit !== declared.thresholdUnit) gaps.push(`${where}.thresholdUnit`)
  return gaps
}

function linearGaps(
  where: string,
  declared: Extract<CustomizeTransformSpec, { kind: 'linear' }>,
  projected: CustomizeCatalogTransform,
): readonly string[] {
  if (projected.kind !== 'linear') return [where]
  const gaps: string[] = []
  if (projected.defaultScale !== declared.defaultScale) gaps.push(`${where}.defaultScale`)
  if (projected.defaultOffset !== declared.defaultOffset) gaps.push(`${where}.defaultOffset`)
  if (projected.clampMin !== declared.clampMin) gaps.push(`${where}.clampMin`)
  if (projected.clampMax !== declared.clampMax) gaps.push(`${where}.clampMax`)
  return gaps
}

function enumGaps(
  where: string,
  declared: Extract<CustomizeTransformSpec, { kind: 'enum-map' }>,
  projected: CustomizeCatalogTransform,
): readonly string[] {
  if (projected.kind !== 'enum-map') return [where]
  const gaps: string[] = []
  if (!sameList(projected.outputValues, declared.outputValues)) gaps.push(`${where}.outputValues`)
  if (projected.unmapped !== declared.unmapped) gaps.push(`${where}.unmapped`)
  return gaps
}

function eventGaps(
  target: EventCustomizeTarget,
  projected: CustomizeCatalogTarget,
): readonly string[] {
  if (target.shape === 'pulse') return pulseGaps(target, projected)
  return spanGaps(target, projected)
}

function pulseGaps(
  target: Extract<EventCustomizeTarget, { shape: 'pulse' }>,
  projected: CustomizeCatalogTarget,
): readonly string[] {
  const where = target.id
  const gaps: string[] = []
  if (!sameList(projected.edges ?? [], target.edges)) gaps.push(`${where}.edges`)
  if (projected.defaultEdge !== target.defaultEdge) gaps.push(`${where}.defaultEdge`)
  if (projected.debounceMs !== target.debounce.defaultDebounceMs) gaps.push(`${where}.debounceMs`)
  return gaps
}

function spanGaps(
  target: Extract<EventCustomizeTarget, { shape: 'span' }>,
  projected: CustomizeCatalogTarget,
): readonly string[] {
  const where = target.id
  const gaps: string[] = []
  if (projected.timeoutMs !== target.timeoutMs) gaps.push(`${where}.timeoutMs`)
  if (!sameList(projected.sourceModes ?? [], target.sourceModes ?? [])) {
    gaps.push(`${where}.sourceModes`)
  }
  if (projected.cooldownMs !== target.cooldownMs) gaps.push(`${where}.cooldownMs`)
  return gaps
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function assertProjectedParameters(
  capName: string,
  spec: CapabilityCustomizeSpec,
  entry: CustomizeCatalogEntry,
): void {
  const gaps = customizeParameterGaps(spec, entry)
  if (gaps.length === 0) return
  throw new Error(`customize catalog: ${capName} does not project ${gaps.join(', ')}`)
}
