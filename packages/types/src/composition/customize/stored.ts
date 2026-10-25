import type { CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'

/** A composition claim. `target` is the device the feature lands on. */
export interface CompositionCustomizeStored {
  readonly family: 'composition'
  readonly target: CompositionSourceRef
  readonly feature: CompositionFieldsFeature
}

export type CustomizeStored = CompositionCustomizeStored

export type CustomizeRoundTrip<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }
