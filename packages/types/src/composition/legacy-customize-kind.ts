/**
 * The OLD shape of the three composition Customize kinds (D1098): before `customizeKind`, a power
 * source, a lock door sensor and a follow-switch opt-out were recognised only by the shape of a
 * stored fields feature. The readers no longer accept that shape; this detector exists for the
 * one core-blocks migration that stamps it, and for the warning that names a block which still
 * holds it (a restored or imported composition the migration did not see).
 */
import type { Composition, CompositionCustomizeKind, CompositionFeature } from './composition.js'

/** The kind the OLD shape of `feature` stood for, or null when it is none of the three or already names one. */
export function legacyCustomizeKindOf(
  feature: CompositionFeature,
): CompositionCustomizeKind | null {
  if (feature.kind !== 'fields' || feature.customizeKind !== undefined) return null
  if (feature.cap === 'power-source') return 'power-source'
  if (feature.cap === 'lock-control') {
    const state = feature.fields['state']
    const x = state?.kind === 'expression' ? state.bindings['x'] : undefined
    return x !== undefined && x.kind === 'from' ? 'lock-door-sensor' : null
  }
  if (
    feature.cap === 'running-state' &&
    feature.enabled === false &&
    Object.keys(feature.fields).length === 0
  ) {
    return 'follow-switch'
  }
  return null
}

/** The kinds a composition still holds in the old, unstamped shape. */
export function legacyCustomizeKindsOf(
  composition: Composition,
): readonly CompositionCustomizeKind[] {
  return composition.features.flatMap((feature) => {
    const kind = legacyCustomizeKindOf(feature)
    return kind === null ? [] : [kind]
  })
}
