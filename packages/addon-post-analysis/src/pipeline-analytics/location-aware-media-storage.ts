/**
 * Location-aware blob storage for event media (entity-routing spec, Phase 3).
 *
 * Media rows may carry a `locationId` (stamped by the relocate mover when a
 * blob is moved off the default location). The write-rate bypass provider
 * only knows the default media root — this wrapper routes any OTHER location
 * id through a resolver (the storage cap's `resolve`, cached forever: a
 * location's root only changes via operator reconfig, which restarts us) and
 * does direct fs I/O against that root, keeping the bypass's
 * no-RPC-per-blob property for every location.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '@camstack/types/node'

/** The subset of the storage surface MediaStore actually uses. */
export interface MediaBlobStorage {
  write(input: { location: string; relativePath: string; data: Buffer }): Promise<void>
  read(input: { location: string; relativePath: string }): Promise<Buffer>
  delete(input: { location: string; relativePath: string }): Promise<void>
  exists?(input: { location: string; relativePath: string }): Promise<boolean>
}

/** A media storage router can forget roots after defaults are repointed. */
export interface LocationAwareMediaBlobStorage extends MediaBlobStorage {
  invalidateRoots(): void
}

export interface LocationAwareDeps {
  /** Handles the DEFAULT media location (the CAMSTACK_MEDIA_ROOT bypass). */
  readonly base: MediaBlobStorage
  /** The location id the base provider owns. */
  readonly defaultLocation: string
  /** Resolve a non-default location id to its absolute root (storage cap). */
  readonly resolveRoot: (locationId: string) => Promise<string>
}

export function createLocationAwareMediaStorage(
  deps: LocationAwareDeps,
): LocationAwareMediaBlobStorage {
  const roots = new Map<string, string>()
  // The base provider is the boot-time eventMedia default. After a migration
  // repoints that default, route the bare `eventMedia` ref through storage
  // resolution instead; otherwise it would continue writing to the old root.
  let defaultBypassInvalidated = false
  const rootOf = async (locationId: string): Promise<string> => {
    const cached = roots.get(locationId)
    if (cached !== undefined) return cached
    const root = await deps.resolveRoot(locationId)
    roots.set(locationId, root)
    return root
  }
  const absOf = async (locationId: string, relativePath: string): Promise<string> =>
    path.join(await rootOf(locationId), relativePath)

  return {
    write: async (input) => {
      if (input.location === deps.defaultLocation && !defaultBypassInvalidated)
        return deps.base.write(input)
      const abs = await absOf(input.location, input.relativePath)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      // Temp-then-rename (D654): a fixed-path single-instance kind is read
      // while the next roll overwrites it; a reader must never get a prefix.
      await writeFileAtomic(abs, input.data)
    },
    read: async (input) => {
      if (input.location === deps.defaultLocation && !defaultBypassInvalidated)
        return deps.base.read(input)
      return fs.readFile(await absOf(input.location, input.relativePath))
    },
    delete: async (input) => {
      if (input.location === deps.defaultLocation && !defaultBypassInvalidated)
        return deps.base.delete(input)
      await fs.rm(await absOf(input.location, input.relativePath), {
        force: true,
      })
    },
    exists: async (input) => {
      if (input.location === deps.defaultLocation && !defaultBypassInvalidated) {
        if (deps.base.exists) return deps.base.exists(input)
        try {
          await deps.base.read(input)
          return true
        } catch {
          return false
        }
      }
      try {
        await fs.access(await absOf(input.location, input.relativePath))
        return true
      } catch {
        return false
      }
    },
    invalidateRoots: (): void => {
      roots.clear()
      defaultBypassInvalidated = true
    },
  }
}
