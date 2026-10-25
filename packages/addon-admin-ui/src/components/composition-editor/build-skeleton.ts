/**
 * Initial composition for a new composed device (required fields omitted).
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapabilityLookup,
  type Composition,
  type CompositionFieldsFeature,
  type CompositionFillStatus,
  compositionFillStatus,
  type DeviceRole,
  DeviceType,
  primaryCapForRole,
  requiredTopLevelKeys,
  validateComposition,
} from '@camstack/types'

function capDefinition(name: string) {
  return ALL_CAPABILITY_DEFINITIONS.find((def) => def.name === name)
}

function companionSuffix(path: string): boolean {
  return path === 'lastFetchedAt' || path.endsWith('At')
}

export function buildSkeletonComposition(input: {
  readonly type: DeviceType
  readonly role: DeviceRole | null
}): Composition | null {
  const cap = primaryCapForRole(input.role)
  if (cap === null) return null
  const def = capDefinition(cap)
  if (def?.status === undefined) return null
  const fields: CompositionFieldsFeature['fields'] = {}
  return {
    target: {
      kind: 'new',
      type: input.type,
      ...(input.role === null ? {} : { role: input.role }),
    },
    features: [{ kind: 'fields', cap, fields }],
  }
}

/** A new skeleton has no sources yet, so it reads incomplete until those fields are filled. */
export function skeletonFillStatus(composition: Composition | null): CompositionFillStatus {
  if (composition === null) return 'incomplete'
  const result = validateComposition(composition, {
    lookupCap: buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS),
    sources: new Map(),
    self: null,
    blockId: null,
    target: null,
    peers: [],
  })
  return compositionFillStatus(result.problems)
}

/** Required value fields of a cap that the composition has not given a source. */
export function unfilledRequiredFields(
  cap: string,
  filled: ReadonlySet<string>,
): readonly string[] {
  const def = capDefinition(cap)
  if (def?.status === undefined) return []
  return requiredTopLevelKeys(def.status.schema).filter(
    (path) => !companionSuffix(path) && !filled.has(path),
  )
}
