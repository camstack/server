/**
 * Eviction-DOMAIN resolution for recordings locations.
 *
 * Recordings locations are operator-configurable and MAY alias one physical
 * filesystem root: today `recordings:default` + `recordingsLow:default` both
 * resolve to `/recordings`, but an operator could also point two locations at a
 * symlink or bind-mount of the same disk. Locations sharing a physical root
 * MUST evict as one oldest-first pool — otherwise disk-pressure relief on one
 * alias deletes the newest footage while the other alias still holds the old
 * (the age-partition data-loss bug).
 *
 * The domain key is the location root's PHYSICAL identity: `fs.realpathSync` of
 * the lexically-resolved path, which collapses symlinks and `.`/`..` so aliases
 * reaching one disk share a key — a plain `path.resolve` string compare would
 * miss a symlinked/bind-aliased path and silently re-introduce the partition.
 * When realpath THROWS (the root is missing at boot — a disk not yet mounted)
 * we fall back to the lexically-resolved path string: distinct-but-unmounted
 * roots then stay distinct domains. That fallback can only ever OVER-partition
 * (treat one disk as two), never MERGE two different disks — the safe failure
 * mode for a data-loss guard.
 */
import { realpathSync } from 'node:fs'
import type { RealpathSync } from '@camstack/types/node'
import { physicalRootOf } from '@camstack/types/node'
import type { RecordingsLocation } from './roots.js'

export type { RealpathSync }

/**
 * The physical-device key of a location root: `realpath` of the resolved path,
 * or the resolved path string itself when realpath throws (root missing).
 *
 * ONE derivation, shared with the orchestrator's same-type root refusal (D389)
 * — two implementations of "is this the same disk" is two answers waiting to
 * disagree. This side deliberately DROPS the `resolved` flag: an unresolvable
 * root falls back to the lexical path, which can only over-partition (treat one
 * disk as two) and never merge two different disks, the safe failure mode for a
 * data-loss guard. The orchestrator needs the flag, because a refusal must not
 * be built on a read that failed.
 */
export function physicalRootKey(root: string, realpath: RealpathSync = realpathSync): string {
  return physicalRootOf(root, realpath).key
}

/**
 * The eviction DOMAIN of `locationId`: the set of location ids (INCLUDING
 * itself) whose roots share `locationId`'s physical root key. An unknown
 * `locationId` (not present in `locations`) is its own singleton domain.
 */
export function resolveEvictionDomain(
  locations: readonly RecordingsLocation[],
  locationId: string,
  realpath: RealpathSync = realpathSync,
): ReadonlySet<string> {
  const self = locations.find((l) => l.id === locationId)
  if (!self) return new Set([locationId])
  const selfKey = physicalRootKey(self.root, realpath)
  const domain = new Set<string>([locationId])
  for (const l of locations) {
    if (physicalRootKey(l.root, realpath) === selfKey) domain.add(l.id)
  }
  return domain
}
