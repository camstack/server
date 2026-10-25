/**
 * Card editor model for a stored composition (D939).
 */
import type {
  Composition,
  CompositionExpressionSource,
  CompositionFieldRead,
  CompositionFieldsFeature,
  CompositionPassthroughFeature,
} from '../composition.js'
import type { KeyedArrayRead } from '../customize/keyed-array-decode.js'
import type { PulseDecoded } from '../customize/event-decode.js'
import type { ScalarDecoded } from '../customize/scalar-decode.js'

export type FieldAggregateKind = 'avg-round-1' | 'max'

export interface FromFieldEntry {
  readonly kind: 'from'
  readonly sources: readonly CompositionFieldRead[]
  readonly aggregate: FieldAggregateKind | null
}

export interface CompanionFieldEntry {
  readonly kind: 'companion'
  readonly companion: 'now'
}

export interface FormulaFieldEntry {
  readonly kind: 'formula'
  readonly expr: string
  readonly bindings: CompositionExpressionSource['bindings']
}

/** Publish this field converted from its declared unit to `to` (D939). */
export interface ConvertUnitFieldEntry {
  readonly kind: 'convert-unit'
  readonly bindingName: string
  readonly from: string
  readonly to: string
  readonly source: CompositionFieldRead
}

export type CompositionCardFieldEntry =
  | FromFieldEntry
  | CompanionFieldEntry
  | FormulaFieldEntry
  | ConvertUnitFieldEntry

export interface CompositionFieldsCard {
  readonly cardKind: 'fields'
  readonly cap: string
  readonly enabled: boolean | undefined
  readonly entries: Readonly<Record<string, CompositionCardFieldEntry>>
  readonly items: CompositionFieldsFeature['items']
}

export interface CompositionPulseCard {
  readonly cardKind: 'pulse'
  readonly cap: string
  readonly targetId: string
  readonly decoded: PulseDecoded
}

export interface CompositionScalarCard {
  readonly cardKind: 'scalar'
  readonly cap: string
  readonly targetId: string
  readonly decoded: ScalarDecoded
}

export interface CompositionKeyedArrayCard {
  readonly cardKind: 'keyedArray'
  readonly cap: string
  readonly targetId: string
  readonly decoded: KeyedArrayRead
}

export type CompositionCard =
  | CompositionFieldsCard
  | CompositionPulseCard
  | CompositionScalarCard
  | CompositionKeyedArrayCard

export interface CompositionPassthroughSlot {
  readonly featureIndex: number
  readonly feature: CompositionPassthroughFeature
}

export interface CompositionCardSlot {
  readonly featureIndex: number
  readonly card: CompositionCard
}

export interface CompositionCardEditorModel {
  readonly original: Composition
  readonly passthroughFeatures: readonly CompositionPassthroughSlot[]
  readonly cards: readonly CompositionCardSlot[]
  /** Field paths edited on a `fields` card, keyed by cap. */
  readonly editedFieldPaths: Readonly<Record<string, readonly string[]>>
  /** Whole-card overrides (pulse / scalar / keyed) marked edited. */
  readonly editedCards: Readonly<Record<string, true>>
}

export interface DecodedCompositionCards {
  readonly model: CompositionCardEditorModel
}
