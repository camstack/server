/**
 * The "Source device" of a cap group the spec declares (`sourceGroups`). Storage
 * stays per target: picking a device is a fill over the per-target assignments,
 * and the group's state is read back from them. This is the pure half.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type Composition,
  type CompositionSourceRef,
  type CustomizeCatalogTarget,
  type CustomizeSourceGroup,
  compositionSourceKey,
  decodeScalarOverride,
  targetFeature,
} from '@camstack/types'
import { featureOf, withScalarTarget } from '../customization-save'
import { type ScalarFieldOffer, scalarFieldFit } from '../scalar/scalar-fit'
import { scalarFeatureFromForm } from '../scalar/scalar-form'

export interface GroupFillInput {
  readonly cap: string
  readonly group: CustomizeSourceGroup
  readonly host: CompositionSourceRef
  /** The device the operator picked. */
  readonly source: CompositionSourceRef
  /** The fields that device exposes (all caps). */
  readonly offers: readonly ScalarFieldOffer[]
  readonly current: Composition | null
}

export interface GroupFillResult {
  /** `current` with the filled targets linked; `current` itself when nothing was filled. */
  readonly composition: Composition | null
  /** Target ids linked to the device. */
  readonly filled: readonly string[]
  /** Target ids the device cannot fill; their assignments are untouched. */
  readonly skipped: readonly string[]
}

function catalogTargets(cap: string): readonly CustomizeCatalogTarget[] {
  return Object.entries(CAP_CUSTOMIZE_CATALOG).find(([name]) => name === cap)?.[1].targets ?? []
}

/** The field of the SAME cap the target reads, by name; the device may or may not expose it. */
function matchingOffer(
  cap: string,
  target: CustomizeCatalogTarget,
  offers: readonly ScalarFieldOffer[],
): ScalarFieldOffer | null {
  const path = target.vocabularyStateField ?? target.path ?? target.id
  return offers.find((offer) => offer.cap === cap && offer.path === path) ?? null
}

export function fillSourceGroup(input: GroupFillInput): GroupFillResult {
  const targets = catalogTargets(input.cap)
  const filled: string[] = []
  const skipped: string[] = []
  let composition = input.current
  for (const id of input.group.targets) {
    const target = targets.find((row) => row.id === id)
    const offer = target === undefined ? null : matchingOffer(input.cap, target, input.offers)
    const fit = offer === null ? null : scalarFieldFit(input.cap, id, offer)
    // Identity only: a conversion or another transform is the per-field picker's job.
    if (
      target === undefined ||
      offer === null ||
      fit === null ||
      !fit.ok ||
      fit.conversion !== undefined ||
      !fit.transforms.includes('identity')
    ) {
      skipped.push(id)
      continue
    }
    const feature = scalarFeatureFromForm({
      cap: input.cap,
      targetId: id,
      device: input.host,
      apply: target.apply,
      source: {
        addonId: input.source.addonId,
        stableId: input.source.stableId,
        cap: offer.cap,
        fieldPath: offer.path,
        valueKind: fit.valueKind,
        sourceUnit: fit.sourceUnit,
        changedAtField: null,
      },
      transform: { kind: 'identity' },
    })
    if (feature === null) {
      skipped.push(id)
      continue
    }
    composition = withScalarTarget(composition, input.host, feature, input.cap, id)
    filled.push(id)
  }
  return { composition, filled, skipped }
}

export type GroupSourceState =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly source: CompositionSourceRef }
  | { readonly kind: 'mixed' }

export interface GroupStateInput {
  readonly cap: string
  readonly group: CustomizeSourceGroup
  readonly host: CompositionSourceRef
  readonly current: Composition | null
}

/**
 * One device when every assigned target reads it, "mixed" when they read
 * different devices (or one is another formula), none when nothing is assigned.
 * An unassigned target does not break "one device".
 */
export function groupSourceState(input: GroupStateInput): GroupSourceState {
  const stored = featureOf(input.current, input.cap)
  const sources = new Map<string, CompositionSourceRef>()
  for (const id of input.group.targets) {
    const feature = targetFeature(stored, input.cap, id)
    if (feature === null) continue
    const decoded = decodeScalarOverride({
      feature,
      device: input.host,
      cap: input.cap,
      targetId: id,
    })
    if (decoded === null) return { kind: 'mixed' }
    const { addonId, stableId } = decoded.draft.source
    sources.set(compositionSourceKey({ addonId, stableId }), { addonId, stableId })
  }
  const [first, ...rest] = [...sources.values()]
  if (first === undefined) return { kind: 'none' }
  return rest.length === 0 ? { kind: 'single', source: first } : { kind: 'mixed' }
}
