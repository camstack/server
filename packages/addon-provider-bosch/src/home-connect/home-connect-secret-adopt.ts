import { errMsg, type IScopedLogger } from '@camstack/types'
import { HOME_CONNECT_SECRET_KEYS, legacyApplianceSecretPatch } from './config.js'

export interface SecretAdoptDeps {
  /** `integrations.setSettings`, called as the integration's own addon. */
  readonly setSettings: (input: {
    readonly id: string
    readonly settings: Record<string, unknown>
    readonly secretKeys: string[]
  }) => Promise<unknown>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/** The move of one integration's pairing keys into the keychain. */
export interface SecretAdoptPlan {
  /** The settings as they are once the move is done — what this boot connects with. */
  readonly settings: Record<string, unknown>
  /**
   * Write the move. Never throws: a failure is logged and the move is tried again at the
   * next boot (this boot already has the keys in memory). The hub restarts the addon after
   * any `setSettings`, so the caller fires it once initialisation is done and does not wait.
   */
  persist(): Promise<void>
}

/**
 * One-time adopt: an integration saved before the keychain move carries each appliance's
 * pairing key (`psk`, `iv64`) on its row, in clear text. Plan the move into `applianceSecrets`
 * (keychain), with the rows stripped.
 *
 * `null` when there is nothing to move — settings already migrated, or the stored keys are
 * locked (the move could not see what it would replace). Idempotent.
 */
export function planLegacyApplianceSecretAdopt(
  deps: SecretAdoptDeps,
  integrationId: string,
  settings: Record<string, unknown>,
): SecretAdoptPlan | null {
  const patch = legacyApplianceSecretPatch(settings)
  if (patch === null) return null
  const next = { ...settings, ...patch }
  return {
    settings: next,
    persist: async () => {
      try {
        await deps.setSettings({
          id: integrationId,
          settings: next,
          secretKeys: [...HOME_CONNECT_SECRET_KEYS],
        })
        deps.logger.info('Home Connect moved the appliance pairing keys into the keychain', {
          tags: { integrationId },
          meta: { appliances: patch.appliances.length },
        })
      } catch (err: unknown) {
        deps.logger.warn(
          'Home Connect could not move the appliance pairing keys into the keychain',
          { tags: { integrationId }, meta: { error: errMsg(err) } },
        )
      }
    },
  }
}
