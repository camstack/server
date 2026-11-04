import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  APPLIANCE_SECRETS_KEY,
  homeConnectSettingsForPersist,
  mergeAppliancesForPersist,
  type HomeConnectConfig,
} from './config.js'
import type { HomeConnectStored } from './home-connect-instances.js'

export interface HomeConnectConnectionPersistDeps {
  /** The integration's record as a settings map; `locked` when its secrets cannot be read. */
  readonly read: (integrationId: string) => Promise<HomeConnectStored | null>
  /** Merge a patch into the record (a secret key goes to the keychain). */
  readonly patch: (integrationId: string, patch: Record<string, unknown>) => Promise<unknown>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

/**
 * Persist what a connection learned at runtime — enriched IDDF entity maps and a rotated
 * access / refresh token — in ONE patch of the record. Writes nothing when the stored secrets
 * cannot be read right now: the patch would replace a key it cannot see. Never throws and
 * never logs a value.
 */
export function buildHomeConnectConnectionPersister(
  deps: HomeConnectConnectionPersistDeps,
): (integrationId: string, connection: HomeConnectConfig) => Promise<void> {
  return async (integrationId, connection) => {
    if (!connection.appliances || connection.appliances.length === 0) return
    try {
      const stored = await deps.read(integrationId)
      if (stored === null) return
      if (stored.locked) {
        deps.logger.warn(
          'Home Connect not persisting the connection — stored secrets are locked or unreadable',
          { tags: { integrationId } },
        )
        return
      }
      const settings = stored.settings
      const refresh = connection.refresh ?? ''
      // The merged rows may carry a pairing key: this moves it into `applianceSecrets`.
      const merged = homeConnectSettingsForPersist({
        ...settings,
        token: connection.token,
        ...(refresh.length > 0 ? { refresh } : {}),
        appliances: mergeAppliancesForPersist(settings['appliances'], connection.appliances),
      })
      await deps.patch(integrationId, {
        token: merged['token'],
        ...(merged['refresh'] !== undefined ? { refresh: merged['refresh'] } : {}),
        appliances: merged['appliances'],
        ...(merged[APPLIANCE_SECRETS_KEY] !== undefined
          ? { [APPLIANCE_SECRETS_KEY]: merged[APPLIANCE_SECRETS_KEY] }
          : {}),
      })
    } catch (err) {
      deps.logger.warn('Home Connect failed to persist the connection', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }
}
