import type { CustomizeStored } from './stored.js'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sortKeys(inner)]),
  )
}

/** Key order is not part of the stored contract. Array order is. */
export function normalizeStored(stored: CustomizeStored): unknown {
  return sortKeys(stored)
}

export function sameStored(a: CustomizeStored, b: CustomizeStored): boolean {
  return JSON.stringify(normalizeStored(a)) === JSON.stringify(normalizeStored(b))
}
