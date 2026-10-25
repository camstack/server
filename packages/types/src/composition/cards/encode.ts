/**
 * Encode card editor model back to a composition (D939). Untouched fields reuse
 * the original wire objects for byte-identical round-trip.
 */
import { compilePulseOverride } from '../customize/event-compile.js'
import type {
  Composition,
  CompositionFeature,
  CompositionFieldsFeature,
  CompositionSourceRef,
} from '../composition.js'
import type { CompositionCardEditorModel, CompositionCardSlot } from './card-types.js'
import { fieldEntryToSource } from './classify-field.js'

function deviceRef(composition: Composition): CompositionSourceRef | null {
  if (composition.target.kind === 'existing') return composition.target.device
  return null
}

function encodeFieldsCard(
  slot: CompositionCardSlot,
  model: CompositionCardEditorModel,
): CompositionFieldsFeature {
  const original = model.original.features[slot.featureIndex]
  if (original === undefined || original.kind !== 'fields') {
    throw new Error('card encode: missing original fields feature')
  }
  const card = slot.card
  if (card.cardKind !== 'fields') {
    throw new Error('card encode: expected fields card')
  }
  const edited = new Set(model.editedFieldPaths[card.cap] ?? [])
  const fields: CompositionFieldsFeature['fields'] = {}
  for (const path of Object.keys(original.fields)) {
    const origSource = original.fields[path]
    if (origSource === undefined) continue
    if (!edited.has(path)) {
      fields[path] = origSource
      continue
    }
    const entry = card.entries[path]
    if (entry === undefined) {
      fields[path] = origSource
      continue
    }
    fields[path] = fieldEntryToSource(entry, origSource)
  }
  for (const path of edited) {
    if (fields[path] !== undefined) continue
    const entry = card.entries[path]
    if (entry === undefined) continue
    fields[path] = fieldEntryToSource(entry, undefined)
  }
  return {
    kind: 'fields',
    cap: card.cap,
    ...(card.enabled !== undefined ? { enabled: card.enabled } : {}),
    fields,
    ...(card.items !== undefined ? { items: card.items } : {}),
    ...(original.commands !== undefined ? { commands: original.commands } : {}),
  }
}

function encodePulseCard(
  slot: CompositionCardSlot,
  model: CompositionCardEditorModel,
): CompositionFieldsFeature {
  const original = model.original.features[slot.featureIndex]
  if (original === undefined || original.kind !== 'fields') {
    throw new Error('card encode: missing pulse feature')
  }
  if (model.editedCards[original.cap] === true) {
    const card = slot.card
    if (card.cardKind !== 'pulse') throw new Error('card encode: expected pulse card')
    const device = deviceRef(model.original)
    if (device === null) throw new Error('card encode: pulse requires existing target device')
    const compiled = compilePulseOverride({
      draft: card.decoded.draft,
      device,
      changedAtFields: card.decoded.changedAtFields,
    })
    if (!compiled.ok) throw new Error(compiled.reason)
    return compiled.value
  }
  return original
}

function encodeScalarCard(
  slot: CompositionCardSlot,
  model: CompositionCardEditorModel,
): CompositionFieldsFeature {
  const original = model.original.features[slot.featureIndex]
  if (original === undefined || original.kind !== 'fields') {
    throw new Error('card encode: missing scalar feature')
  }
  if (model.editedCards[original.cap] === true) {
    throw new Error('card encode: scalar edit not implemented in phase 1')
  }
  return original
}

function encodeKeyedCard(
  slot: CompositionCardSlot,
  model: CompositionCardEditorModel,
): CompositionFieldsFeature {
  const original = model.original.features[slot.featureIndex]
  if (original === undefined || original.kind !== 'fields') {
    throw new Error('card encode: missing keyed feature')
  }
  if (model.editedCards[original.cap] === true) {
    throw new Error('card encode: keyed edit not implemented in phase 1')
  }
  return original
}

function encodeCardSlot(
  slot: CompositionCardSlot,
  model: CompositionCardEditorModel,
): CompositionFieldsFeature {
  switch (slot.card.cardKind) {
    case 'pulse':
      return encodePulseCard(slot, model)
    case 'scalar':
      return encodeScalarCard(slot, model)
    case 'keyedArray':
      return encodeKeyedCard(slot, model)
    case 'fields':
      return encodeFieldsCard(slot, model)
  }
}

export function encodeCardsToComposition(model: CompositionCardEditorModel): Composition {
  const featureByIndex = new Map<number, CompositionFeature>()
  for (const slot of model.passthroughFeatures) {
    featureByIndex.set(slot.featureIndex, slot.feature)
  }
  for (const slot of model.cards) {
    featureByIndex.set(slot.featureIndex, encodeCardSlot(slot, model))
  }
  const features: CompositionFeature[] = []
  for (let index = 0; index < model.original.features.length; index += 1) {
    const feature = featureByIndex.get(index)
    if (feature !== undefined) features.push(feature)
  }
  return {
    target: model.original.target,
    features,
  }
}
