/**
 * The id of a room, a tag or a zone (D1089).
 *
 * An entity is a record with an opaque, stable id; everything else stores the id.
 * Two ways to get one:
 *
 * - {@link roomIdFromKey} / {@link tagIdFromKey} / {@link zoneIdFromKey}: a PURE
 *   function of the folded name. Used ONLY by the migrations, so three owners that
 *   each add `tagIds` to their own records mint the same id for `"Garden"` without
 *   reading each other.
 * - {@link newEntityId}: random, for every entity created afterwards, so renaming
 *   a room back to a name an old migrated room once had cannot collide with it.
 *
 * Not a secret and not a hash anyone relies on for integrity: two 53-bit mixes
 * spelled in hex, so the function is the same in Node, Electron and a browser.
 */

export type EntityKind = 'room' | 'tag' | 'zone'

/** The fold every entity name compares by: trimmed, lower-cased. */
export function entityNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** cyrb53 — a small, well-mixed 53-bit string hash. */
function mix53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

function hex14(n: number): string {
  return n.toString(16).padStart(14, '0')
}

/** The id a migration mints for `kind` from the entity's folded `key`. Pure. */
export function entityIdFromKey(kind: EntityKind, key: string): string {
  const folded = `${kind}:${entityNameKey(key)}`
  return `${kind}_${hex14(mix53(folded, 1))}${hex14(mix53(folded, 2))}`
}

export const roomIdFromKey = (key: string): string => entityIdFromKey('room', key)
export const tagIdFromKey = (key: string): string => entityIdFromKey('tag', key)
export const zoneIdFromKey = (key: string): string => entityIdFromKey('zone', key)

/** A fresh random id for an entity created after the migrations. */
export function newEntityId(kind: EntityKind): string {
  return `${kind}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
}

/** True when `id` has the shape of an id of `kind` (a name never does). */
export function isEntityId(kind: EntityKind, id: string): boolean {
  return new RegExp(`^${kind}_[0-9a-f]{28,32}$`).test(id)
}
