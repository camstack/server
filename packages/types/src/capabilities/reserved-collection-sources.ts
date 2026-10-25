/**
 * Source ids of a device COLLECTION that exactly one addon may mint (D625).
 *
 * A collection cap's picker treats its rows as peers, and that is right almost
 * everywhere. It is wrong for exactly one thing: a DEFAULT that must be
 * impossible to express otherwise.
 *
 * `recording`'s default is ours, always (the operator's ruling, 2026-09-24).
 * The way that is made structural rather than a sort order is a RESERVED id:
 * the absence of an operator choice MEANS `camstack`, so a surface never needs
 * a "first row" fallback and there is nowhere to put one. `clip-sources.ts`
 * ends with `?? sources[0]`, and `videoclips.listSources` on 592 answers the
 * ONBOARD row first — for clips that fallback was argued for, for a timeline it
 * would silently swap an 85 362 s bar for a 21 388 s one.
 *
 * A reserved id is only worth anything if nothing else can spell it, so it is
 * enforced twice and neither is a paragraph:
 *
 *  1. `device-collection-dispatch.ts` DROPS a `listSources` row carrying a
 *     reserved id from any addon but its owner, naming the impostor in a log
 *     line with `tags: { deviceId }`. It drops the row rather than throwing:
 *     one lying provider must not empty a camera's picker.
 *  2. `scripts/check-reserved-collection-sources.ts` fails CI on any package
 *     but the owner's that spells the id at all. It reads THIS table, so a new
 *     reservation is guarded the moment it is added here.
 */

/** One reservation: `sourceId` on `capName` may be served only by `addonId`. */
export interface ReservedCollectionSource {
  readonly capName: string
  readonly sourceId: string
  readonly addonId: string
}

/**
 * Every reserved (cap, source) pair in the system.
 *
 * KEEP THE LITERALS INLINE. The CI guard parses this array textually — it
 * cannot execute TypeScript — so an entry built from an imported constant
 * would be invisible to it, and a guard that reads the wrong surface is worse
 * than none.
 */
export const RESERVED_COLLECTION_SOURCES: readonly ReservedCollectionSource[] = [
  { capName: 'recording', sourceId: 'camstack', addonId: 'recorder' },
]

/**
 * The addon allowed to serve `sourceId` on `capName`, or `null` when the id is
 * not reserved at all (which is the common case — most sources are peers).
 */
export function reservedSourceOwner(capName: string, sourceId: string): string | null {
  for (const entry of RESERVED_COLLECTION_SOURCES) {
    if (entry.capName === capName && entry.sourceId === sourceId) return entry.addonId
  }
  return null
}
