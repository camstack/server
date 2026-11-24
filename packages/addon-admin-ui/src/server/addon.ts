import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IAdminUiProvider, IAppSourceProvider, ProviderRegistration } from '@camstack/types'
import { BaseAddon, adminUiCapability, appSourceCapability } from '@camstack/types'
import { buildAdminApp } from './admin-app'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveAdminUiDistDir(): string {
  return path.resolve(__dirname, '..')
}

/**
 * AdminUIAddon — serves the Vite-built frontend.
 */
export class AdminUIAddon extends BaseAddon {
  readonly id = 'admin-ui'

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const provider: IAdminUiProvider = {
      getStaticDir: async () => ({ staticDir: resolveAdminUiDistDir() }),
      getVersion: async () => ({ version: __APP_VERSION__ }),
    }
    const appSource: IAppSourceProvider = {
      listApps: async () => [buildAdminApp()],
    }
    return [
      { capability: adminUiCapability, provider },
      { capability: appSourceCapability, provider: appSource },
    ]
  }
}

export default AdminUIAddon
