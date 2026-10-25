import { errMsg, isSecretMarker, isSecretMarkerLike, type IScopedLogger } from '@camstack/types'
import {
  APPLIANCE_SECRETS_KEY,
  HOME_CONNECT_SECRET_KEYS,
  homeConnectSettingsForPersist,
  mergeAppliancesForPersist,
  readApplianceSecrets,
  type HomeConnectConfig,
} from './config.js'

/** A type alias (not an interface) so it stays assignable to the router's indexed input. */
export type HomeConnectSetSettingsInput = {
  readonly id: string
  readonly settings: Record<string, unknown>
  readonly secretKeys: string[]
}

export interface HomeConnectConnectionPersistDeps {
  /** `integrations.getSettings` — resolved values (D798); a locked secret reads as its marker. */
  readonly getSettings: (integrationId: string) => Promise<Record<string, unknown>>
  /** `integrations.setSettings`; the `secretKeys` go to the keychain. */
  readonly setSettings: (input: HomeConnectSetSettingsInput) => Promise<unknown>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

function locked(value: unknown): boolean {
  return isSecretMarker(value) || isSecretMarkerLike(value)
}

/**
 * Persist what a connection learned at runtime — enriched IDDF entity maps and a rotated
 * access / refresh token — in ONE `setSettings` write. The tokens are named in `secretKeys`
 * so they land in the keychain, never on the plain blob. Writes nothing when a stored secret
 * cannot be read right now: the write would drop a key it cannot see or be refused. Never
 * throws and never logs a value.
 */
export function buildHomeConnectConnectionPersister(
  deps: HomeConnectConnectionPersistDeps,
): (integrationId: string, connection: HomeConnectConfig) => Promise<void> {
  return async (integrationId, connection) => {
    if (!connection.appliances || connection.appliances.length === 0) return
    try {
      const settings = await deps.getSettings(integrationId)
      const stored = readApplianceSecrets(settings[APPLIANCE_SECRETS_KEY])
      const lockedTokens = ['token', 'refresh'].filter((key) => locked(settings[key]))
      if (stored.kind === 'unresolved' || stored.kind === 'invalid' || lockedTokens.length > 0) {
        deps.logger.warn(
          'Home Connect not persisting the connection — stored secrets are locked or unreadable',
          {
            tags: { integrationId },
            meta: { applianceSecrets: stored.kind, lockedTokens },
          },
        )
        return
      }
      const refresh = connection.refresh ?? ''
      const merged = homeConnectSettingsForPersist({
        ...settings,
        token: connection.token,
        ...(refresh.length > 0 ? { refresh } : {}),
        appliances: mergeAppliancesForPersist(settings['appliances'], connection.appliances),
      })
      await deps.setSettings({
        id: integrationId,
        settings: merged,
        secretKeys: [...HOME_CONNECT_SECRET_KEYS],
      })
    } catch (err) {
      deps.logger.warn('Home Connect failed to persist the connection', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }
}
