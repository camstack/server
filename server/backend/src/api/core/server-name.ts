/**
 * Reads the hub's human name (D861) from the one row that holds it,
 * `system-settings` / `server.name`, and falls back to the machine hostname.
 *
 * Read-only on purpose: the only writer is the `system-config` addon's form
 * (System -> Settings), which validates with the same `ServerNameSchema`. Nothing
 * here writes a default, at boot or on a read.
 *
 * A read that FAILS is not an unset name: it answers the hostname default for
 * display (a title is never worth a failed page) but says so in the log, so a
 * hub that looks unnamed because its store is down is not mistaken for one that
 * was never named.
 */

import os from 'node:os'
import type { IScopedLogger, ServerNameInfo } from '@camstack/types'
import { errMsg, resolveServerName, SERVER_NAME_SETTING_KEY } from '@camstack/types'
import type { CapabilityRegistry } from '@camstack/system'
import type { ISettingsStoreProvider } from '@camstack/types'
import type { SettingsStoreGateway } from './site-location.js'

const SYSTEM_SETTINGS_COLLECTION = 'system-settings'

export interface ServerNameReaderDeps {
  readonly store: Pick<SettingsStoreGateway, 'get'>
  readonly logger?: IScopedLogger
  /** Test seam: the machine hostname. */
  readonly hostname?: () => string
}

export class ServerNameReader {
  constructor(private readonly deps: ServerNameReaderDeps) {}

  async read(): Promise<ServerNameInfo> {
    const hostname = (this.deps.hostname ?? os.hostname)()
    try {
      const stored = await this.deps.store.get({
        collection: SYSTEM_SETTINGS_COLLECTION,
        key: SERVER_NAME_SETTING_KEY,
      })
      return resolveServerName(stored, hostname)
    } catch (err: unknown) {
      this.deps.logger?.warn('server name read failed - answering the hostname default', {
        meta: { error: errMsg(err) },
      })
      return resolveServerName(undefined, hostname)
    }
  }
}

/**
 * A reader that resolves the `settings-store` cap lazily from the registry (it
 * boots after the routers are built). Without a registry, or before the cap is
 * up, the read throws and {@link ServerNameReader} answers the hostname default.
 */
export function serverNameReaderFor(
  registry: CapabilityRegistry | null,
  logger?: IScopedLogger,
): ServerNameReader {
  return new ServerNameReader({
    store: {
      get: async (input) => {
        const provider = registry?.getSingleton<ISettingsStoreProvider>('settings-store') ?? null
        if (provider === null) throw new Error('settings-store unavailable: cap not registered yet')
        return provider.get(input)
      },
    },
    ...(logger !== undefined ? { logger } : {}),
  })
}
