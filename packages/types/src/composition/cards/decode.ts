/**
 * Decode a stored composition into card editor slots (D939).
 */
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalogTarget } from '../../capabilities/customize-catalog.js'
import type { Composition, CompositionFieldsFeature, CompositionSourceRef } from '../composition.js'
import { decodePulseOverride } from '../customize/event-decode.js'
import { decodeScalarOverride } from '../customize/scalar-decode.js'
import { decodeKeyedArrayOverride } from '../customize/keyed-array-decode.js'
import type {
  CompositionCardEditorModel,
  CompositionCardSlot,
  CompositionFieldsCard,
  DecodedCompositionCards,
} from './card-types.js'
import { classifyFieldSource } from './classify-field.js'

function deviceForTarget(composition: Composition): CompositionSourceRef | null {
  if (composition.target.kind === 'existing') return composition.target.device
  return null
}

function isCatalogCap(cap: string): cap is keyof typeof CAP_CUSTOMIZE_CATALOG {
  return Object.hasOwn(CAP_CUSTOMIZE_CATALOG, cap)
}

function catalogTargets(cap: string): readonly CustomizeCatalogTarget[] {
  if (!isCatalogCap(cap)) return []
  return CAP_CUSTOMIZE_CATALOG[cap].targets
}

function tryPulseCard(
  feature: CompositionFieldsFeature,
  featureIndex: number,
  device: CompositionSourceRef,
): CompositionCardSlot | null {
  for (const target of catalogTargets(feature.cap)) {
    if (target.cardinality !== 'event' || target.shape !== 'pulse') continue
    if (target.timestampPath === undefined || target.counterPath === undefined) continue
    const decoded = decodePulseOverride({
      feature,
      device,
      cap: feature.cap,
      targetId: target.id,
      timestampPath: target.timestampPath,
      counterPath: target.counterPath,
    })
    if (decoded !== null) {
      return {
        featureIndex,
        card: {
          cardKind: 'pulse',
          cap: feature.cap,
          targetId: target.id,
          decoded,
        },
      }
    }
  }
  return null
}

function tryScalarCard(
  feature: CompositionFieldsFeature,
  featureIndex: number,
  device: CompositionSourceRef,
): CompositionCardSlot | null {
  for (const target of catalogTargets(feature.cap)) {
    if (target.cardinality !== 'scalar') continue
    const decoded = decodeScalarOverride({
      feature,
      device,
      cap: feature.cap,
      targetId: target.id,
    })
    if (decoded !== null) {
      return {
        featureIndex,
        card: {
          cardKind: 'scalar',
          cap: feature.cap,
          targetId: target.id,
          decoded,
        },
      }
    }
  }
  return null
}

function tryKeyedCard(
  feature: CompositionFieldsFeature,
  featureIndex: number,
  device: CompositionSourceRef,
): CompositionCardSlot | null {
  for (const target of catalogTargets(feature.cap)) {
    if (target.cardinality !== 'keyedArray') continue
    const decoded = decodeKeyedArrayOverride({
      feature,
      device,
      cap: feature.cap,
      targetId: target.id,
    })
    if (decoded !== null) {
      return {
        featureIndex,
        card: {
          cardKind: 'keyedArray',
          cap: feature.cap,
          targetId: target.id,
          decoded,
        },
      }
    }
  }
  return null
}

function fieldsCard(feature: CompositionFieldsFeature): CompositionFieldsCard {
  const entries: Record<string, ReturnType<typeof classifyFieldSource>> = {}
  for (const [path, source] of Object.entries(feature.fields)) {
    entries[path] = classifyFieldSource(source)
  }
  return {
    cardKind: 'fields',
    cap: feature.cap,
    enabled: feature.enabled,
    entries,
    items: feature.items,
  }
}

function decodeFieldsFeature(
  feature: CompositionFieldsFeature,
  featureIndex: number,
): CompositionCardSlot {
  return { featureIndex, card: fieldsCard(feature) }
}

function decodeFieldsWithOverrides(
  feature: CompositionFieldsFeature,
  featureIndex: number,
  device: CompositionSourceRef | null,
): CompositionCardSlot {
  if (device !== null) {
    const pulse = tryPulseCard(feature, featureIndex, device)
    if (pulse !== null) return pulse
    const scalar = tryScalarCard(feature, featureIndex, device)
    if (scalar !== null) return scalar
    const keyed = tryKeyedCard(feature, featureIndex, device)
    if (keyed !== null) return keyed
  }
  return decodeFieldsFeature(feature, featureIndex)
}

export function decodeCompositionToCards(composition: Composition): DecodedCompositionCards {
  const device = deviceForTarget(composition)
  const passthroughFeatures = composition.features.flatMap((feature, featureIndex) =>
    feature.kind === 'passthrough' ? [{ featureIndex, feature }] : [],
  )
  const cards = composition.features.flatMap((feature, featureIndex) =>
    feature.kind === 'fields' ? [decodeFieldsWithOverrides(feature, featureIndex, device)] : [],
  )
  const model: CompositionCardEditorModel = {
    original: composition,
    passthroughFeatures,
    cards,
    editedFieldPaths: {},
    editedCards: {},
  }
  return { model }
}
