import { existsSync, accessSync, constants } from 'node:fs'
import { join, resolve, dirname, isAbsolute } from 'node:path'

export interface IStorageBackend {
  /** Backend type identifier */
  readonly type: string
  /** Base path of this backend */
  readonly basePath: string
  /** Resolve a subpath to an absolute path */
  resolve(subpath: string): string
  /**
   * Check whether the backend is usable: either the base directory
   * already exists and is writable, OR we can create it on first
   * write (i.e. the nearest existing ancestor is writable).
   */
  isAvailable(): boolean
  /** No-op for lazy backends. Kept for API compatibility. */
  initialize(): Promise<void>
}

/**
 * Filesystem storage backend — lazy by design.
 *
 * `initialize()` does NOT create the base directory eagerly. Instead,
 * consumers that write via `FilesystemStorageProvider` (and other write
 * helpers in storage-manager.ts) run `fs.mkdir(dirname(filePath), { recursive: true })`
 * right before every `writeFile`, so the directory tree appears on demand.
 *
 * The previous behaviour eagerly mkdir'd every location declared in
 * `StorageLocationManager.initializeDefaults()` — six directories (`db`,
 * `media`, `recordings`, `models`, `cache`, `logs`) got created at boot
 * even if the installation had no cameras, no recording addon, no
 * analytics addon, etc. That meant every fresh install looked like it
 * was producing data when it had nothing to write. Laziness fixes that:
 * a directory only exists once an addon decides to put a file there.
 */
export class FsStorageBackend implements IStorageBackend {
  readonly type = 'local'
  readonly basePath: string

  constructor(basePath: string) {
    this.basePath = resolve(basePath)
  }

  resolve(subpath: string): string {
    if (isAbsolute(subpath)) return subpath
    return join(this.basePath, subpath)
  }

  isAvailable(): boolean {
    // If the base dir already exists, check write permission directly.
    // Otherwise walk up to the first existing ancestor (guaranteed to
    // terminate at the filesystem root) and check it is writable — we
    // can then mkdir the missing segments on first write.
    try {
      if (existsSync(this.basePath)) {
        accessSync(this.basePath, constants.W_OK)
        return true
      }
      let parent = dirname(this.basePath)
      while (parent && parent !== dirname(parent)) {
        if (existsSync(parent)) {
          accessSync(parent, constants.W_OK)
          return true
        }
        parent = dirname(parent)
      }
      return false
    } catch {
      return false
    }
  }

  async initialize(): Promise<void> {
    // No-op: base directory is created lazily on first write. See the
    // class docstring for the rationale.
  }
}
