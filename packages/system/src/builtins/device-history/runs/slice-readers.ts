/**
 * Typed reads of a device-state slice, which arrives as an untyped record.
 * A field of the wrong type is "not said" (`null`), never coerced (D393).
 */
export type Slice = Readonly<Record<string, unknown>>

export function numberField(slice: Slice | null, key: string): number | null {
  const value = slice?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function stringField(slice: Slice | null, key: string): string | null {
  const value = slice?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function booleanField(slice: Slice | null, key: string): boolean | null {
  const value = slice?.[key]
  return typeof value === 'boolean' ? value : null
}

export function isSlice(value: unknown): value is Slice {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
