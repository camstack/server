/**
 * The two decisions the orchestrator makes from "is this location backed by a
 * local filesystem?", extracted so both are directly testable without standing
 * up an addon.
 *
 * They are the second and third locks of D296. The first is
 * `upsertLocation`'s refusal, which stops the configuration from existing.
 * These two hold for a row that predates the guard, for one written by a
 * future code path, and for a provider that changes its own `nodeLocal`
 * answer after a location was made.
 */
import type { StorageLocation } from '@camstack/types'

/** What a provider answered about itself; `undefined` = not yet classified. */
export type ProviderLocality = boolean | undefined

/**
 * May `storage.resolve` return a path for this location?
 *
 * `resolve` is the only method on the cap whose result LEAVES the storage
 * abstraction — every caller of it opens the string with `node:fs`. A remote
 * provider answers with a path on the remote host, which on this node is
 * either missing or an unrelated local directory of the same name. For the
 * recorder, writing to the wrong place is not an error the operator sees; it
 * is a black window in the footage.
 *
 * Only a POSITIVE `false` refuses. `undefined` is "not yet classified", not
 * "remote" — and a conclusion drawn from a read that was never made is how a
 * doorbell rang 0/3 (D49).
 */
export function resolveRefusalFor(
  location: StorageLocation,
  locality: ProviderLocality,
): string | null {
  if (locality !== false) return null
  return (
    `storage.resolve is a request for a path this node can open with node:fs, and location ` +
    `"${location.id}" is served by the remote provider "${location.providerId}" ` +
    `(nodeLocal: false) — the path it would return exists on the remote host, not here. ` +
    `Read and write this location through the storage cap (read/write, or ` +
    `beginUpload/writeChunk/finalizeUpload) instead.`
  )
}

/**
 * Can this node's filesystem answer "does this location still hold anything?"
 *
 * Only for a provider it KNOWS to be node-local. Everything else is `unknown`,
 * which refuses a delete.
 *
 * The direction that matters is the one this closes. A remote location carries
 * a plain-looking `basePath` (`/backups/camstack`); `fs.readdir` of it on the
 * hub answers `ENOENT`, and `ENOENT` is deliberately read as `empty` — because
 * for a LOCAL location an absent root means there is nothing the delete can
 * strand. Applied to a remote row, that same reasoning turns a full share into
 * a vacant one and walks D293's delete guard straight past it.
 */
export function canProbeOccupancyLocally(locality: ProviderLocality): boolean {
  return locality === true
}
