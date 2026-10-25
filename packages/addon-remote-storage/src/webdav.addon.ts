import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, storageProviderCapability } from '@camstack/types'
import { WebDavStorageProvider } from './providers/webdav/webdav-provider.js'

/**
 * WebDAV storage-provider addon. See sibling `sftp.addon.ts` for the
 * rationale on why each provider lives in its own addon entry.
 */
export class WebDavStorageAddon extends BaseAddon {
  private impl: WebDavStorageProvider | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.impl = new WebDavStorageProvider(this.ctx.logger)
    return [{ capability: storageProviderCapability, provider: this.impl }]
  }

  protected async onShutdown(): Promise<void> {
    await this.impl?.dispose()
    this.impl = null
  }
}

export default WebDavStorageAddon
