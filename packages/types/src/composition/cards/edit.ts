/**
 * Immutable edits on the card editor model (D939).
 */
import type { CompositionCardEditorModel } from './card-types.js'

export function markFieldEdited(
  model: CompositionCardEditorModel,
  cap: string,
  fieldPath: string,
): CompositionCardEditorModel {
  const prev = model.editedFieldPaths[cap] ?? []
  if (prev.includes(fieldPath)) return model
  return {
    ...model,
    editedFieldPaths: {
      ...model.editedFieldPaths,
      [cap]: [...prev, fieldPath],
    },
  }
}

export function setFormulaExpr(
  model: CompositionCardEditorModel,
  cap: string,
  fieldPath: string,
  expr: string,
): CompositionCardEditorModel {
  const marked = markFieldEdited(model, cap, fieldPath)
  const cards = marked.cards.map((slot) => {
    if (slot.card.cardKind !== 'fields' || slot.card.cap !== cap) return slot
    const entry = slot.card.entries[fieldPath]
    if (entry === undefined || entry.kind !== 'formula') return slot
    return {
      ...slot,
      card: {
        ...slot.card,
        entries: {
          ...slot.card.entries,
          [fieldPath]: { ...entry, expr },
        },
      },
    }
  })
  return { ...marked, cards }
}
