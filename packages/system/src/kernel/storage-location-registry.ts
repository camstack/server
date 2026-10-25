import type { StorageAccess, StorageLocationDeclaration } from '@camstack/types'
import { STORAGE_ACCESS_FALLBACK } from '@camstack/types'

/**
 * Read-only view over all aggregated storage-location declarations.
 *
 * Built at kernel boot by {@link buildStorageLocationRegistry} from the
 * `storageLocations` arrays declared in each installed addon's manifest.
 */
export interface StorageLocationRegistry {
  /** Returns the declaration for `id`, or `undefined` if not declared. */
  get(id: string): StorageLocationDeclaration | undefined

  /** Returns `true` when at least one addon declared `id`. */
  has(id: string): boolean

  /**
   * Returns the cardinality of `id`, or `null` when no addon declared it.
   * Convenience shortcut over `get(id)?.cardinality`.
   */
  cardinalityOf(id: string): 'single' | 'multi' | null

  /**
   * The declared {@link StorageAccess} of `id`, or `null` when no addon
   * declared it. An UNDECLARED `access` on a DECLARED id resolves to
   * `STORAGE_ACCESS_FALLBACK` (`'local-path'`) — fail-closed, so a kind that
   * says nothing is treated as doing raw filesystem I/O and refuses a remote
   * provider. `null` is reserved for "nobody declared this id at all", which
   * callers treat separately.
   */
  accessOf(id: string): StorageAccess | null

  /**
   * Stable, immutable list of all aggregated declarations (insertion order of
   * first occurrence per `id`).
   */
  list(): readonly StorageLocationDeclaration[]
}

/**
 * Aggregates per-addon {@link StorageLocationDeclaration} arrays into a single
 * {@link StorageLocationRegistry}.
 *
 * Merge rules:
 * - Declarations are keyed by `id`; iteration order follows first occurrence.
 * - **First declarer wins** for metadata (`displayName`, `description`,
 *   `defaultsTo`): if a later addon declares the same `id`, its metadata is
 *   silently ignored.
 * - **Cardinality conflict throws**: if two addons declare the same `id` with
 *   different `cardinality` values an `Error` is thrown immediately (message
 *   contains the words "cardinality" and the conflicting `id`).
 * - **Access conflict throws**, for the same reason and more sharply: the
 *   EFFECTIVE access (declared, else `STORAGE_ACCESS_FALLBACK`) must agree.
 *   "First declarer wins" is the right rule for a display name and a
 *   catastrophic one for a safety constraint — it would let a second addon
 *   silently widen a kind that the first one restricted, which is exactly the
 *   accident this constraint exists to make impossible.
 *
 * @param perAddon - One entry per addon; each entry is that addon's
 *   `storageLocations` declaration array.
 */
export function buildStorageLocationRegistry(
  perAddon: readonly (readonly StorageLocationDeclaration[])[],
): StorageLocationRegistry {
  const map = new Map<string, StorageLocationDeclaration>()

  for (const addonDeclarations of perAddon) {
    for (const declaration of addonDeclarations) {
      const existing = map.get(declaration.id)

      if (existing !== undefined) {
        if (existing.cardinality !== declaration.cardinality) {
          throw new Error(
            `Storage location cardinality conflict for id "${declaration.id}": ` +
              `"${existing.cardinality}" (first declarer) vs "${declaration.cardinality}" (later declarer). ` +
              `All addons declaring the same storage location id must agree on cardinality.`,
          )
        }
        const existingAccess = existing.access ?? STORAGE_ACCESS_FALLBACK
        const declaredAccess = declaration.access ?? STORAGE_ACCESS_FALLBACK
        if (existingAccess !== declaredAccess) {
          throw new Error(
            `Storage location access conflict for id "${declaration.id}": ` +
              `"${existingAccess}" (first declarer) vs "${declaredAccess}" (later declarer). ` +
              `All addons declaring the same storage location id must agree on access — ` +
              `a later declaration must never widen what an earlier one restricted.`,
          )
        }
        // First declarer wins — skip metadata from later declarations.
        continue
      }

      map.set(declaration.id, declaration)
    }
  }

  const frozen = Object.freeze([...map.values()])

  return {
    get(id: string): StorageLocationDeclaration | undefined {
      return map.get(id)
    },

    has(id: string): boolean {
      return map.has(id)
    },

    cardinalityOf(id: string): 'single' | 'multi' | null {
      return map.get(id)?.cardinality ?? null
    },

    accessOf(id: string): StorageAccess | null {
      const declaration = map.get(id)
      if (declaration === undefined) return null
      return declaration.access ?? STORAGE_ACCESS_FALLBACK
    },

    list(): readonly StorageLocationDeclaration[] {
      return frozen
    },
  }
}
