import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, storageProviderCapability } from '@camstack/types'
import { SmbStorageProvider } from './providers/smb/smb-provider.js'

/**
 * SMB / CIFS storage-provider addon — the fourth manifest entry in
 * `@camstack/addon-remote-storage`.
 *
 * Each cap-collection registrant needs a distinct addonId: `CapabilityRegistry`
 * keys collection providers by `Map<addonId, …>`, so registering a second
 * provider from `sftp-storage` would silently replace SFTP rather than join it.
 *
 * The binary this provider wraps (`smbclient`) is declared in the package
 * manifest under `camstack.addons[].systemDependencies` and installed by the
 * runner BEFORE this class initialises. When that install fails the addon
 * still loads — the provider refuses every call with
 * `SmbBinaryUnavailableError`, so its locations read as unreachable rather
 * than as empty. Empty is deletable (D293); unreachable is not.
 */
export class SmbStorageAddon extends BaseAddon {
  private impl: SmbStorageProvider | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.impl = new SmbStorageProvider(this.ctx.logger)
    return [{ capability: storageProviderCapability, provider: this.impl }]
  }

  protected async onShutdown(): Promise<void> {
    await this.impl?.dispose()
    this.impl = null
  }
}

export default SmbStorageAddon
