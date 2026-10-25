/**
 * Episode logging for package look drops — one info line per reason per streak.
 */

import type { PackageLookDrop } from './package-look-sightings.js'

export type PackageLookDropReason = PackageLookDrop['reason']

export interface PackageLookDropEpisodes {
  readonly announce: readonly PackageLookDrop[]
  readonly next: ReadonlySet<PackageLookDropReason>
}

export function nextPackageLookDropEpisodes(
  previous: ReadonlySet<PackageLookDropReason>,
  drops: readonly PackageLookDrop[],
): PackageLookDropEpisodes {
  const seen = new Set<PackageLookDropReason>()
  const announce: PackageLookDrop[] = []
  for (const drop of drops) {
    if (previous.has(drop.reason) || seen.has(drop.reason)) continue
    seen.add(drop.reason)
    announce.push(drop)
  }
  const next = new Set<PackageLookDropReason>()
  for (const d of drops) next.add(d.reason)
  return { announce, next }
}
