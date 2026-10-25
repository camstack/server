/**
 * Which paths under a shared root BELONG to a storage class (D327).
 *
 * A recordings disk hosts several classes at one `basePath`:
 * `<camera>/high|mid` (recordings), `<camera>/low` (recordingsLow),
 * `<camera>/events` (eventMedia) and `homekit-clips/…` (homekitClips). A
 * location may touch only its own subtree; the rest of the root is another
 * location's data. On 2026-10-20 a repoint of `homekitClips:default` walked the
 * WHOLE shared root and deleted ~8.6k event-media files that were not its own.
 *
 * The per-camera map is {@link STORAGE_CLASS_SUBTREES} (the one source, shared
 * with occupancy scoring). A class whose subtree sits at the ROOT, not under a
 * camera, is listed here. A type in neither map owns its whole root (backups,
 * artifacts, …): there is no subtree to scope to.
 */
import { STORAGE_CLASS_SUBTREES } from './location-occupancy.js'

/** Class → top-level directories directly under the root (no camera segment). */
export const STORAGE_CLASS_ROOT_SUBTREES: Readonly<Record<string, readonly string[]>> = {
  homekitClips: ['homekit-clips'],
}

/**
 * - `own`     — at or under the class subtree: copy it, delete it.
 * - `descend` — an ancestor of the subtree (the camera directory): walk into
 *               it, but it is not itself a file to move.
 * - `foreign` — another class's data: never read, never copied, never deleted.
 */
export type PathVerdict = 'own' | 'descend' | 'foreign'

/** Does this class own only part of its root? */
export function isSubtreeScoped(type: string): boolean {
  return type in STORAGE_CLASS_SUBTREES || type in STORAGE_CLASS_ROOT_SUBTREES
}

/** Classify a root-relative path (`/` separators) for a location of `type`. */
export function classifyPath(type: string, relativePath: string): PathVerdict {
  const rootSubtrees = STORAGE_CLASS_ROOT_SUBTREES[type]
  const cameraSubtrees = STORAGE_CLASS_SUBTREES[type]
  if (rootSubtrees === undefined && cameraSubtrees === undefined) return 'own'
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  if (rootSubtrees !== undefined) {
    const top = segments[0]
    return top !== undefined && rootSubtrees.includes(top) ? 'own' : 'foreign'
  }
  // Per-camera layout: segment 0 is the camera, segment 1 the class subtree.
  if (segments.length < 2) return 'descend'
  const subtree = segments[1]
  return subtree !== undefined && cameraSubtrees?.includes(subtree) === true ? 'own' : 'foreign'
}
