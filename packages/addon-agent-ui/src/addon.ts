import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IAdminUiProvider, ProviderRegistration } from '@camstack/types'

import { BaseAddon, adminUiCapability } from '@camstack/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Agent UI addon — lightweight status dashboard for agent nodes.
 *
 * Implements the `admin-ui` capability with a minimal React SPA
 * showing agent status, connected cameras, logs, and metrics.
 * When installed on an agent, this replaces the full admin-ui
 * (which is hub-only) so the agent can serve its own dashboard
 * on its local HTTP port.
 */
export class AgentUIAddon extends BaseAddon {
  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const provider: IAdminUiProvider = {
      getStaticDir: async () => ({ staticDir: path.resolve(__dirname) }),
      getVersion: async () => ({ version: __APP_VERSION__ }),
    }
    return [{ capability: adminUiCapability, provider }]
  }
}

export default AgentUIAddon
