/**
 * Guards for the filesystem-browse cap. Pure + synchronous so they are
 * trivially unit-testable; the provider applies containment AFTER resolving the
 * real path (so symlink escapes are also caught upstream).
 *
 * The guard is SPLIT (D115): `assertWithinAllowedRoots` contains WRITES
 * (`createDir`) to the operator's allowed roots, while `assertBrowsablePath`
 * lets read-only discovery (`browse`) see the whole filesystem. Confining
 * discovery to the same roots meant the admin UI could not list `/`, so the
 * path picker could not offer — or even reach — the mounts this node's own
 * storage locations live on.
 */
import { isAbsolute, resolve, sep } from 'node:path'

/** True iff `candidate` is one of, or nested under, an allowed root. */
export function isWithinAllowedRoots(candidate: string, allowedRoots: readonly string[]): boolean {
  const norm = resolve(candidate)
  return allowedRoots.some((root) => {
    const r = resolve(root)
    return norm === r || norm.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

/** Throws unless `candidate` is within an allowed root. WRITES only. */
export function assertWithinAllowedRoots(candidate: string, allowedRoots: readonly string[]): void {
  if (!isWithinAllowedRoots(candidate, allowedRoots)) {
    throw new Error(`path "${candidate}" is not within an allowed root`)
  }
}

/**
 * Throws unless `candidate` is a browsable path. Read-only discovery is
 * deliberately unconfined — the only requirement is an absolute path, so a
 * relative one can never be resolved against whatever the runner's cwd
 * happens to be.
 */
export function assertBrowsablePath(candidate: string): void {
  if (!isAbsolute(candidate)) {
    throw new Error(`browse path "${candidate}" must be absolute`)
  }
}
