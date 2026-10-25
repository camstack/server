/**
 * How a change to a device's customization reaches the server (D663, D676).
 * The block is the ONE composition that targets the device: a card merges
 * its feature into it, and the plan is create / update-with-the-updatedAt-it-
 * read / delete / nothing. It never creates while the customization is not
 * KNOWN to be absent — a blind create would be refused `duplicate-target`
 * at best and hide the operator's existing block at worst (D315).
 */
import type {
  Composition,
  CompositionBlockInput,
  CompositionFieldSource,
  CompositionFieldsFeature,
  CompositionSourceRef,
} from '@camstack/types'
import type { CustomizationState } from './customization-read'
import i18n from '../../../i18n/index'

export interface CustomizationCreatePlan {
  readonly kind: 'create'
  readonly input: CompositionBlockInput
}
export interface CustomizationUpdatePlan {
  readonly kind: 'update'
  readonly blockId: string
  readonly expectedUpdatedAt: number
  readonly composition: Composition
}
export interface CustomizationDeletePlan {
  readonly kind: 'delete'
  readonly blockId: string
}
export interface CustomizationNoopPlan {
  readonly kind: 'noop'
}
export interface CustomizationRefusedPlan {
  readonly kind: 'refused'
  readonly reason: string
}
export type CustomizationSavePlan =
  | CustomizationCreatePlan
  | CustomizationUpdatePlan
  | CustomizationDeletePlan
  | CustomizationNoopPlan
  | CustomizationRefusedPlan

/** The composition with `feature` added, or replacing the feature of the same cap. */
export function withFeature(
  current: Composition | null,
  target: CompositionSourceRef,
  feature: CompositionFieldsFeature,
): Composition {
  const features = current?.features ?? []
  const index = features.findIndex((f) => f.cap === feature.cap)
  return {
    target: current?.target ?? { kind: 'existing', device: target },
    features:
      index === -1 ? [...features, feature] : features.map((f, i) => (i === index ? feature : f)),
  }
}

/** The composition without the feature of `cap`; `null` when nothing is left (≥ 1 feature). */
export function withoutFeature(current: Composition, cap: string): Composition | null {
  const features = current.features.filter((f) => f.cap !== cap)
  return features.length === 0 ? null : { target: current.target, features }
}

export function featureOf(
  current: Composition | null,
  cap: string,
): CompositionFieldsFeature | null {
  const feature = current?.features.find((f) => f.cap === cap)
  return feature !== undefined && feature.kind === 'fields' ? feature : null
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sortKeys(inner)]),
  )
}

/** Key order is not a change: the server stores JSON, and a re-save must not bump `updatedAt`. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** Two field maps are the same when their canonical JSON is (key order is not a difference). */
export function sameFieldSources(
  a: Readonly<Record<string, CompositionFieldSource>>,
  b: Readonly<Record<string, CompositionFieldSource>>,
): boolean {
  return canonical(a) === canonical(b)
}

/** Two features are the same when their canonical JSON is (key order is not a difference). */
export function sameFeature(a: CompositionFieldsFeature, b: CompositionFieldsFeature): boolean {
  return canonical(a) === canonical(b)
}

export function planCustomizationSave(
  state: CustomizationState,
  next: Composition | null,
): CustomizationSavePlan {
  switch (state.kind) {
    case 'pending':
      return { kind: 'refused', reason: i18n.t('helpers.customizationSave.notReadYet') }
    case 'unknown':
      return { kind: 'refused', reason: `the customization could not be read: ${state.reason}` }
    case 'not-loaded':
      return { kind: 'refused', reason: `the customizations are not loaded yet: ${state.reason}` }
    case 'none':
      return next === null
        ? { kind: 'noop' }
        : { kind: 'create', input: { enabled: true, composition: next } }
    case 'present': {
      const blockId = state.view.block.id
      if (next === null) return { kind: 'delete', blockId }
      if (canonical(next) === canonical(state.composition)) return { kind: 'noop' }
      return {
        kind: 'update',
        blockId,
        expectedUpdatedAt: state.view.block.updatedAt,
        composition: next,
      }
    }
  }
}
