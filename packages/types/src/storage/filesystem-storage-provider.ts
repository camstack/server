import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { writeFileAtomic } from './atomic-write.js'
import type {
  IStorageProvider,
  StorageResolveInput,
  StorageWriteInput,
  StorageReadInput,
  StorageExistsInput,
  StorageListInput,
  StorageDeleteInput,
  StorageAvailableSpaceInput,
} from '../interfaces/storage.js'
import type { StorageLocationType } from '../interfaces/storage-location.js'

// Inline constants to avoid runtime dependency on @camstack/types
// (types is external in tsup bundle, may not be resolvable from data/addons/)
const STORAGE_LOCATION_TYPES: readonly StorageLocationType[] = [
  'data',
  'media',
  'recordings',
  'recordings-high',
  'recordings-low',
  'recordings-clips',
  'event-images',
  'models',
  'addons-data',
  'cache',
  'logs',
  'backups',
]

const DEFAULT_LOCATION_SUBDIRS: Readonly<Record<StorageLocationType, string>> = {
  data: 'db',
  media: 'media',
  recordings: 'recordings',
  'recordings-high': 'recordings-high',
  'recordings-low': 'recordings-low',
  'recordings-clips': 'recordings-clips',
  'event-images': 'event-images',
  models: 'models',
  'addons-data': 'addons-data',
  cache: '/tmp/camstack-cache',
  logs: 'logs',
  backups: 'backups',
}

/**
 * Filesystem storage provider — serves all location types from a local directory tree.
 *
 * Default layout:
 *   {rootPath}/recordings-high/
 *   {rootPath}/recordings-low/
 *   {rootPath}/recordings-clips/
 *   {rootPath}/event-images/
 *   {rootPath}/models/
 *   {rootPath}/addons-data/
 *   {rootPath}/logs/
 *   /tmp/camstack-cache/   (cache is always local)
 *
 * Individual location paths can be overridden.
 */
export class FilesystemStorageProvider implements IStorageProvider {
  readonly id = 'local'
  readonly name = 'Local Filesystem'
  readonly supportedLocations: readonly StorageLocationType[] = [...STORAGE_LOCATION_TYPES]

  private readonly rootPath: string
  private readonly locationPaths: Map<StorageLocationType, string>

  constructor(rootPath: string, overrides?: Partial<Record<StorageLocationType, string>>) {
    this.rootPath = path.resolve(rootPath)
    this.locationPaths = new Map()

    for (const loc of STORAGE_LOCATION_TYPES) {
      const override = overrides?.[loc]
      if (override) {
        this.locationPaths.set(loc, path.resolve(override))
      } else {
        const subdir = DEFAULT_LOCATION_SUBDIRS[loc] ?? loc
        // Absolute paths (like /tmp/camstack-cache) are used as-is
        this.locationPaths.set(
          loc,
          path.isAbsolute(subdir) ? subdir : path.join(this.rootPath, subdir),
        )
      }
    }
    // Location ids are an OPEN string set (addon-declared kinds like
    // `eventMedia`) — honor overrides for those too, not only the legacy enum
    // members iterated above (whose loop silently dropped any other key).
    for (const [loc, override] of Object.entries(overrides ?? {})) {
      if (typeof override === 'string' && !this.locationPaths.has(loc)) {
        this.locationPaths.set(loc, path.resolve(override))
      }
    }
  }

  async resolve({ location, relativePath }: StorageResolveInput): Promise<string> {
    // Known preset types use their mapped path; any other (addon-declared)
    // location id resolves to `<rootPath>/<id>`, matching the orchestrator's
    // `localData/<id>` default — so new declared locations (eventMedia,
    // recordingsLow, …) work without a hardcoded entry here.
    const base = this.locationPaths.get(location) ?? path.join(this.rootPath, location)
    return path.join(base, relativePath)
  }

  async write({ location, relativePath, data }: StorageWriteInput): Promise<void> {
    const filePath = await this.resolve({ location, relativePath })
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })

    // Temp-then-rename (D654): a reader of a fixed path that is overwritten in
    // place (`lastFrame`, `lastSceneFrame`) sees the old file or the new one,
    // never a truncated prefix.
    if (Buffer.isBuffer(data)) {
      await writeFileAtomic(filePath, data)
    } else {
      // Stream: piped to a unique temp beside the target, then swapped in.
      const tmp = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${randomUUID()}.tmp`,
      )
      try {
        // `pipeline`, not `pipe`: a SOURCE error rejects here (with `pipe` it
        // was never observed and the write hung), so the temp is removed.
        await pipeline(data, fs.createWriteStream(tmp))
        await fs.promises.rename(tmp, filePath)
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
    }
  }

  async read({ location, relativePath }: StorageReadInput): Promise<Buffer> {
    return fs.promises.readFile(await this.resolve({ location, relativePath }))
  }

  async exists({ location, relativePath }: StorageExistsInput): Promise<boolean> {
    try {
      await fs.promises.access(await this.resolve({ location, relativePath }))
      return true
    } catch {
      return false
    }
  }

  async list({ location, prefix }: StorageListInput): Promise<readonly string[]> {
    const base = this.locationPaths.get(location)
    if (!base) return []
    const dir = prefix ? path.join(base, prefix) : base
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      return entries.map((e) => (prefix ? `${prefix}/${e.name}` : e.name))
    } catch {
      return []
    }
  }

  async delete({ location, relativePath }: StorageDeleteInput): Promise<void> {
    const filePath = await this.resolve({ location, relativePath })
    await fs.promises.rm(filePath, { force: true })
  }

  async getAvailableSpace({ location }: StorageAvailableSpaceInput): Promise<number | null> {
    const base = this.locationPaths.get(location)
    if (!base) return null
    // If the directory doesn't exist yet (lazy creation), walk up to
    // the nearest existing ancestor so statfs can still report free
    // space on the mount point. This keeps the storage dashboard
    // working on a fresh install where no file has been written yet.
    try {
      let target = base
      while (!fs.existsSync(target)) {
        const parent = path.dirname(target)
        if (!parent || parent === target) return null
        target = parent
      }
      const stats = await fs.promises.statfs(target)
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  }

  /** Get the resolved path for a location type (addon-declared ids fall back
   *  to `<rootPath>/<id>`). */
  getLocationPath(location: StorageLocationType): string {
    return this.locationPaths.get(location) ?? path.join(this.rootPath, location)
  }

  /** Get the root path */
  getRootPath(): string {
    return this.rootPath
  }
}

export default FilesystemStorageProvider
