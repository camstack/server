/**
 * The PHYSICAL root behind a storage-location path — ONE derivation, shared.
 *
 * A symlink or a bind mount reaches one disk under two names, and a string
 * comparison misses exactly the case that matters: two locations that look
 * distinct in the config and are the same directory. Every consumer that has to
 * answer "are these the same disk" resolves it here.
 *
 * Two consumers today, and they need different things from the SAME derivation,
 * which is why the resolution failure is reported rather than swallowed:
 *
 *  - the recorder's eviction domain merges same-root aliases into one
 *    oldest-first pool. It wants a key either way — an unresolvable root falls
 *    back to the lexically-resolved path, which can only ever OVER-partition
 *    (treat one disk as two) and never merge two different disks. That is the
 *    safe failure mode for a data-loss guard.
 *  - the orchestrator's collision refusal (D389) must NOT refuse on a root it
 *    could not resolve: a location on another node, or behind a remote
 *    provider, is unresolvable from here, and refusing on an unanswerable read
 *    blocks the operator on a doubt (D49's spirit). It needs to know.
 *
 * Node-only (`node:fs`), so it lives off the root entry and is re-exported from
 * `@camstack/types/node`.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Injectable realpath (defaults to the sync fs call) — lets tests drive it. */
export type RealpathSync = (p: string) => string

/** A resolved physical root, and whether the filesystem actually answered. */
export interface PhysicalRoot {
  /** `realpath` of the path, or the lexically-resolved path when it could not
   *  be taken. Always usable as a comparison key. */
  readonly key: string
  /** True when `realpath` answered. FALSE means "I could not tell" — which is
   *  not the same as "they differ", and a refusal must never be built on it. */
  readonly resolved: boolean
}

/** Resolve a location root to its physical key. Never throws. */
export function physicalRootOf(root: string, realpath: RealpathSync = realpathSync): PhysicalRoot {
  const resolved = path.resolve(root)
  try {
    return { key: realpath(resolved), resolved: true }
  } catch {
    return { key: resolved, resolved: false }
  }
}

/**
 * Is `inner` the same directory as `outer`, or nested inside it?
 *
 * Containment matters as much as equality: a location inside another's tree is
 * WORSE than two equal roots, because the occupancy accounting silently
 * overlaps and a deletion under the outer one can take the inner one's footage
 * with it.
 *
 * Compared on path SEGMENTS, never as a string prefix — `/mnt/disk1` is not
 * inside `/mnt/disk` even though the string says so.
 */
export function containsOrEquals(outer: string, inner: string): boolean {
  if (outer === inner) return true
  const relative = path.relative(outer, inner)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
