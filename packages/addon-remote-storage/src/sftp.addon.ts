import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, storageProviderCapability } from '@camstack/types'
import { SftpStorageProvider } from './providers/sftp/sftp-provider.js'

/**
 * SFTP storage-provider addon.
 *
 * Each cap-collection registrant must have a distinct addonId — the
 * `CapabilityRegistry` keys collection providers by `Map<addonId, …>`,
 * so registering N providers from the same addon collapses to one.
 * Splitting SFTP / S3 / WebDAV into three addon entries (all shipped
 * by the same npm package `@camstack/addon-remote-storage`) is the
 * standard fan-out pattern.
 */
export class SftpStorageAddon extends BaseAddon {
  private impl: SftpStorageProvider | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.impl = new SftpStorageProvider(this.ctx.logger)
    return [{ capability: storageProviderCapability, provider: this.impl }]
  }

  protected async onShutdown(): Promise<void> {
    await this.impl?.dispose()
    this.impl = null
  }
}

export default SftpStorageAddon
