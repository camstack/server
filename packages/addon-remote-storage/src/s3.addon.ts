import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, storageProviderCapability } from '@camstack/types'
import { S3StorageProvider } from './providers/s3/s3-provider.js'

/**
 * S3 storage-provider addon. See sibling `sftp.addon.ts` for the
 * rationale on why each provider lives in its own addon entry.
 */
export class S3StorageAddon extends BaseAddon {
  private impl: S3StorageProvider | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.impl = new S3StorageProvider(this.ctx.logger)
    return [{ capability: storageProviderCapability, provider: this.impl }]
  }

  protected async onShutdown(): Promise<void> {
    await this.impl?.dispose()
    this.impl = null
  }
}

export default S3StorageAddon
