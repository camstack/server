/**
 * How a list-valued customization is said in the table: a count plus the
 * item names. An object is never stringified with the default object tag.
 */
export const LIST_VALUE_PREVIEW = 3

export interface ListPreview {
  readonly labels: readonly string[]
  readonly shown: readonly string[]
  readonly truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A name an operator can read. An object without one is its JSON, never the default object tag. */
export function labelOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (!isRecord(value)) return null
  const named = value['label'] ?? value['name']
  if (typeof named === 'string' && named.trim().length > 0) return named.trim()
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : json
  } catch {
    return null
  }
}

/** Item names of a list. `null` when the value is not a list. */
export function labelsFromList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((item) => {
    const label = labelOf(item)
    return label === null ? [] : [label]
  })
}

export function listPreview(labels: readonly string[]): ListPreview {
  const shown = labels.slice(0, LIST_VALUE_PREVIEW)
  return { labels, shown, truncated: labels.length > shown.length }
}
