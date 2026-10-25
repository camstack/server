import { homedir } from 'node:os'
import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, filesystemBrowseCapability, storageProviderCapability } from '@camstack/types'
import { FilesystemBrowseProvider } from './filesystem-browse-provider.js'
import { FilesystemStorageProvider } from './filesystem-storage-provider.js'

interface FilesystemStorageConfig {
  readonly rootPath: string
  readonly storageAllowedRoots: readonly string[]
}

function defaultAllowedRoots(): readonly string[] {
  // process.platform-aware sensible defaults; '/mnt' + '/Volumes' cover Linux/mac
  // external disks, plus the user home so the dev data dir is reachable.
  return ['/mnt', '/Volumes', '/media', homedir()]
}

/**
 * Filesystem Storage addon — registers a filesystem-backed
 * `storage-provider` (Task 7).
 *
 * Pre-Task 7 this addon registered against the (then-collection)
 * `storage` cap. After Tasks 2/3/4 the consumer-facing `storage` cap is
 * a singleton owned by `storage-orchestrator`; the orchestrator
 * dispatches each call to whichever `storage-provider` matches
 * `location.providerId`.
 *
 * The OLD `rootPath` config field is preserved for back-compat: the
 * orchestrator's first-boot seeding step still uses the same env-var
 * resolution chain (operator override → `CAMSTACK_DATA` → fallback) to
 * derive the base path of every default location, then writes
 * `config.basePath` into each persisted `StorageLocation` row. The
 * provider itself is now stateless — every call carries the live
 * `StorageLocation` inline.
 */
export class FilesystemStorageAddon extends BaseAddon<FilesystemStorageConfig> {
  private provider: FilesystemStorageProvider | null = null

  constructor() {
    super({
      rootPath: 'camstack-data',
      // Default allowed roots browsing is sandboxed to on THIS node. Operators
      // extend per node via the addon store. Defaults cover the data dir's
      // parent + common external-mount points.
      storageAllowedRoots: defaultAllowedRoots(),
    })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.provider = new FilesystemStorageProvider()
    const browse = new FilesystemBrowseProvider(() => this.config.storageAllowedRoots)
    this.ctx.logger.info('Filesystem storage-provider initialized')
    return [
      { capability: storageProviderCapability, provider: this.provider },
      { capability: filesystemBrowseCapability, provider: browse },
    ]
  }

  protected async onShutdown(): Promise<void> {
    await this.provider?.dispose()
    this.provider = null
  }

  getProvider(): FilesystemStorageProvider | null {
    return this.provider
  }
}

export default FilesystemStorageAddon
