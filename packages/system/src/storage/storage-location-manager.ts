import { join, isAbsolute } from 'node:path'
import { FsStorageBackend, type IStorageBackend } from './fs-storage-backend.js'

export type StorageLocationName = 'data' | 'media' | 'recordings' | 'models' | 'cache' | 'logs'

export class StorageLocationManager {
  private readonly backends: Map<StorageLocationName, IStorageBackend> = new Map()
  private readonly dataPath: string

  constructor(dataPath: string) {
    this.dataPath = dataPath
  }

  /** Initialize all locations with default paths */
  async initializeDefaults(): Promise<void> {
    const defaults: Record<StorageLocationName, string> = {
      data: join(this.dataPath, 'db'),
      media: join(this.dataPath, 'media'),
      recordings: join(this.dataPath, 'recordings'),
      models: join(this.dataPath, 'models'),
      cache: '/tmp/camstack-cache',
      logs: join(this.dataPath, 'logs'),
    }

    for (const [name, path] of Object.entries(defaults)) {
      const backend = new FsStorageBackend(path)
      await backend.initialize()
      this.backends.set(name as StorageLocationName, backend)
    }
  }

  /** Override a specific location's backend path */
  async setLocationPath(name: StorageLocationName, basePath: string): Promise<void> {
    const resolved = isAbsolute(basePath) ? basePath : join(this.dataPath, basePath)
    const backend = new FsStorageBackend(resolved)
    await backend.initialize()
    this.backends.set(name, backend)
  }

  /** Get the backend for a location */
  getBackend(name: StorageLocationName): IStorageBackend {
    const backend = this.backends.get(name)
    if (!backend) throw new Error(`Storage location "${name}" not initialized`)
    return backend
  }

  /** Resolve a path within a location */
  resolve(location: StorageLocationName, subpath: string): string {
    return this.getBackend(location).resolve(subpath)
  }

  /** Check if all locations are available */
  getStatus(): Array<{ name: StorageLocationName; available: boolean; path: string }> {
    return Array.from(this.backends.entries()).map(([name, backend]) => ({
      name,
      available: backend.isAvailable(),
      path: backend.basePath,
    }))
  }

  /** All location names */
  getLocationNames(): StorageLocationName[] {
    return Array.from(this.backends.keys())
  }
}
