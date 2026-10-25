import * as fs from 'node:fs'
import * as path from 'node:path'
import { StorageLocationManager, type StorageLocationName } from './storage-location-manager.js'
import type {
  IStorageProvider as INewStorageProvider,
  ISettingsBackend,
  HistogramBucket,
} from '@camstack/types'
import { userError } from '@camstack/types'

// Legacy interfaces — still used by consumers during migration
export interface IStorageProvider {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  getLocation(name: StorageLocationName): IStorageLocation
  export?(locationName: StorageLocationName): Promise<Buffer>
  import?(locationName: StorageLocationName, data: Buffer): Promise<void>
}

export interface QueryFilter {
  where?: Record<string, unknown>
  whereIn?: Record<string, unknown[]>
  whereBetween?: Record<string, [unknown, unknown]>
  orderBy?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

export interface StorageRecord {
  collection: string
  id: string
  data: Record<string, unknown>
}

export interface IStructuredStorage {
  query(collection: string, filter?: QueryFilter): Promise<readonly StorageRecord[]>
  insert(record: StorageRecord): Promise<StorageRecord>
  update(collection: string, id: string, data: Record<string, unknown>): Promise<StorageRecord>
  delete(collection: string, id: string): Promise<void>
  count(collection: string, filter?: QueryFilter): Promise<number>
  histogram(input: {
    collection: string
    field: string
    bucketSize: number
    origin: number
    filter?: QueryFilter
  }): Promise<readonly HistogramBucket[]>
}

export interface IFileStorage {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  listFiles(prefix?: string): Promise<readonly string[]>
  getFileUrl(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

export interface IStorageLocation {
  structured?: IStructuredStorage
  files?: IFileStorage
}

/**
 * StorageManager — bridge between legacy code (getLocation/getLocationPath)
 * and the new capability-based storage system.
 *
 * Legacy consumers call getLocation('addon', namespace) to get structured + file storage.
 * This manager builds the response from:
 *   - SettingsBackend (for structured queries) — provided by sqlite-settings addon
 *   - LocationManager (for file paths) — set during Phase 2 boot
 */
export class StorageManager {
  private legacyProvider: IStorageProvider | null = null
  private locationManager: StorageLocationManager | null = null
  private newStorageProvider: INewStorageProvider | null = null
  private settingsBackend: ISettingsBackend | null = null

  /** @deprecated Set by legacy capability consumer — use setNewStorageProvider instead */
  setProvider(provider: IStorageProvider | INewStorageProvider): void {
    // Check if it's the new provider (has 'supportedLocations') or legacy (has 'getLocation')
    if ('getLocation' in provider) {
      this.legacyProvider = provider
    } else {
      this.newStorageProvider = provider
    }
  }

  setNewStorageProvider(provider: INewStorageProvider): void {
    this.newStorageProvider = provider
  }

  setSettingsBackend(backend: ISettingsBackend): void {
    this.settingsBackend = backend
  }

  getSettingsBackend(): ISettingsBackend {
    if (!this.settingsBackend) {
      throw new Error('SettingsBackend not initialized — storage addon not yet loaded')
    }
    return this.settingsBackend
  }

  getProvider(): IStorageProvider {
    if (this.legacyProvider) return this.legacyProvider
    if (!this.newStorageProvider && !this.settingsBackend && !this.locationManager) {
      throw userError('storage.no-provider', undefined, 'No storage provider configured')
    }
    // Return a shim that wraps new providers
    return this.createLegacyShim()
  }

  setLocationManager(manager: StorageLocationManager): void {
    this.locationManager = manager
  }

  getLocationManager(): StorageLocationManager {
    if (!this.locationManager) {
      throw new Error('StorageLocationManager not initialized')
    }
    return this.locationManager
  }

  async initializeLocations(dataPath: string): Promise<void> {
    // Was previously a dynamic `await import(...)` for code-split, but the
    // module is also re-exported statically by core/src/index.ts so the
    // dynamic split never materialized (Rolldown reported it as
    // INEFFECTIVE_DYNAMIC_IMPORT). Switched to a top-of-file named
    // import — same shape, no chunk-graph confusion.
    const manager = new StorageLocationManager(dataPath)
    await manager.initializeDefaults()
    this.locationManager = manager
  }

  getLocationPath(name: StorageLocationName): string {
    return this.getLocationManager().getBackend(name).basePath
  }

  /**
   * Get a storage location with optional namespace scoping.
   * Builds IStorageLocation from settingsBackend (structured) + locationManager (files).
   */
  getLocation(name: StorageLocationName | string, namespace?: string): IStorageLocation {
    if (
      !this.legacyProvider &&
      !this.newStorageProvider &&
      !this.settingsBackend &&
      !this.locationManager
    ) {
      throw userError('storage.no-provider', undefined, 'No storage provider configured')
    }
    // Try legacy provider first
    if (this.legacyProvider) {
      try {
        // Legacy alias → new location name mapping. `name` may be any string
        // coming from addon code; the final narrowing cast is the single
        // boundary between the public API (string) and the internal union.
        const LEGACY_MAP = {
          config: 'data',
          events: 'data',
          addon: 'data',
        } as const satisfies Record<string, StorageLocationName>
        const mapped =
          name in LEGACY_MAP
            ? LEGACY_MAP[name as keyof typeof LEGACY_MAP]
            : (name as StorageLocationName)
        const mappedName: StorageLocationName = mapped
        const location = this.legacyProvider.getLocation(mappedName)
        return namespace ? this.createNamespacedLocation(location, namespace) : location
      } catch {
        // Fall through to new approach
      }
    }

    // Build from new providers
    const location: IStorageLocation = {}

    // Structured storage from settingsBackend
    if (this.settingsBackend) {
      const backend = this.settingsBackend
      location.structured = {
        async query(collection: string, filter?: QueryFilter) {
          const results = await backend.query({ collection, filter })
          return results.map((r) => ({ collection, id: r.id, data: r.data }))
        },
        async insert(record: StorageRecord) {
          const id = record.id || (await import('node:crypto')).randomUUID()
          await backend.insert({ collection: record.collection, record: { id, data: record.data } })
          return { ...record, id }
        },
        async update(collection: string, id: string, data: Record<string, unknown>) {
          await backend.update({ collection, id, data })
          return { collection, id, data }
        },
        async delete(collection: string, id: string) {
          await backend.delete({ collection, key: id })
        },
        async count(collection: string, filter?: QueryFilter) {
          return backend.count({ collection, filter })
        },
        async histogram(input: {
          collection: string
          field: string
          bucketSize: number
          origin: number
          filter?: QueryFilter
        }): Promise<readonly HistogramBucket[]> {
          return backend.histogram({
            collection: input.collection,
            field: input.field,
            bucketSize: input.bucketSize,
            origin: input.origin,
            filter: input.filter,
          })
        },
      }
    }

    // File storage from locationManager
    if (this.locationManager) {
      const LEGACY_MAP = {
        config: 'data',
        events: 'data',
        addon: 'data',
      } as const satisfies Record<string, StorageLocationName>
      const mappedName: StorageLocationName =
        name in LEGACY_MAP
          ? LEGACY_MAP[name as keyof typeof LEGACY_MAP]
          : (name as StorageLocationName)
      try {
        const basePath = this.locationManager.getBackend(mappedName).basePath
        location.files = {
          async readFile(p: string) {
            return fs.promises.readFile(path.join(basePath, p))
          },
          async writeFile(p: string, data: Buffer) {
            const full = path.join(basePath, p)
            await fs.promises.mkdir(path.dirname(full), { recursive: true })
            await fs.promises.writeFile(full, data)
          },
          async deleteFile(p: string) {
            await fs.promises.rm(path.join(basePath, p), { force: true })
          },
          async listFiles(prefix?: string) {
            const dir = prefix ? path.join(basePath, prefix) : basePath
            try {
              return (await fs.promises.readdir(dir)).map((f) => (prefix ? `${prefix}/${f}` : f))
            } catch {
              return []
            }
          },
          async getFileUrl(p: string) {
            return path.join(basePath, p)
          },
          async exists(p: string) {
            try {
              await fs.promises.access(path.join(basePath, p))
              return true
            } catch {
              return false
            }
          },
        }
      } catch {
        // Location not available
      }
    }

    return namespace ? this.createNamespacedLocation(location, namespace) : location
  }

  private createLegacyShim(): IStorageProvider {
    return {
      async initialize() {},
      async shutdown() {},
      getLocation: (name: StorageLocationName) => {
        return this.getLocation(name)
      },
    }
  }

  private createNamespacedLocation(
    location: IStorageLocation,
    namespace: string,
  ): IStorageLocation {
    const prefix = namespace.endsWith('/') ? namespace : `${namespace}/`

    return {
      structured: location.structured
        ? {
            async query(collection: string, filter?: QueryFilter) {
              return location.structured!.query(`${prefix}${collection}`, filter)
            },
            async insert(record: StorageRecord) {
              return location.structured!.insert({
                ...record,
                collection: `${prefix}${record.collection}`,
              })
            },
            async update(collection: string, id: string, data: Record<string, unknown>) {
              return location.structured!.update(`${prefix}${collection}`, id, data)
            },
            async delete(collection: string, id: string) {
              return location.structured!.delete(`${prefix}${collection}`, id)
            },
            async count(collection: string, filter?: QueryFilter) {
              return location.structured!.count(`${prefix}${collection}`, filter)
            },
            async histogram(input: {
              collection: string
              field: string
              bucketSize: number
              origin: number
              filter?: QueryFilter
            }): Promise<readonly HistogramBucket[]> {
              return location.structured!.histogram({
                ...input,
                collection: `${prefix}${input.collection}`,
              })
            },
          }
        : undefined,

      files: location.files
        ? {
            async readFile(p: string) {
              return location.files!.readFile(`${prefix}${p}`)
            },
            async writeFile(p: string, data: Buffer) {
              return location.files!.writeFile(`${prefix}${p}`, data)
            },
            async deleteFile(p: string) {
              return location.files!.deleteFile(`${prefix}${p}`)
            },
            async listFiles(filePrefix?: string) {
              return location.files!.listFiles(`${prefix}${filePrefix ?? ''}`)
            },
            async getFileUrl(p: string) {
              return location.files!.getFileUrl(`${prefix}${p}`)
            },
            async exists(p: string) {
              return location.files!.exists(`${prefix}${p}`)
            },
          }
        : undefined,
    }
  }
}
