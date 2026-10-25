import { errMsg, isSecretMarker, isSecretMarkerLike, type IScopedLogger } from '@camstack/types'
import { HOMECOM_SECRET_KEYS } from './config.js'
import type { HomeComTokens } from './homecom-api-client.js'

export interface HomeComTokenPersisterDeps {
  readonly getSettings: (integrationId: string) => Promise<Record<string, unknown>>
  /** `integrations.setSettings`, called as the integration's own addon. */
  readonly setSettings: (input: {
    readonly id: string
    readonly settings: Record<string, unknown>
    readonly secretKeys: string[]
  }) => Promise<unknown>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

export interface HomeComSettingsPatchDeps extends HomeComTokenPersisterDeps {
  readonly what: string
}

function unreadable(value: unknown): boolean {
  return isSecretMarker(value) || isSecretMarkerLike(value)
}

/**
 * Merge `patch` into the integration's stored settings in ONE `setSettings` write, one at a
 * time per integration. Refuses (and says so, without values) when a secret the write
 * touches cannot be read back from the keychain: the hub refuses an overwrite of a secret the
 * addon could not read, so the write would only fail.
 */
function buildSerialPatcher(deps: HomeComSettingsPatchDeps) {
  const tails = new Map<string, Promise<void>>()
  return (integrationId: string, patch: Record<string, unknown>): Promise<void> => {
    const run = async (): Promise<void> => {
      try {
        const stored = await deps.getSettings(integrationId)
        const locked = HOMECOM_SECRET_KEYS.filter((key) => unreadable(stored[key]))
        if (locked.length > 0) {
          deps.logger.warn(`HomeCom not persisting ${deps.what} — stored secrets are locked`, {
            tags: { integrationId },
            meta: { locked },
          })
          return
        }
        await deps.setSettings({
          id: integrationId,
          settings: { ...stored, ...patch },
          secretKeys: [...HOMECOM_SECRET_KEYS],
        })
      } catch (err) {
        deps.logger.warn(`HomeCom failed to persist ${deps.what}`, {
          tags: { integrationId },
          meta: { error: errMsg(err) },
        })
      }
    }
    const next = (tails.get(integrationId) ?? Promise.resolve()).then(run)
    tails.set(integrationId, next)
    return next
  }
}

/** Persist a rotated token pair; never throws, never logs a value. */
export function buildHomeComTokenPersister(
  deps: HomeComTokenPersisterDeps,
): (integrationId: string, tokens: HomeComTokens) => Promise<void> {
  const patch = buildSerialPatcher({ ...deps, what: 'rotated tokens' })
  return (integrationId, tokens) =>
    patch(integrationId, { token: tokens.token, refresh: tokens.refresh })
}

/** Persist the gateway this integration settled on. */
export function buildHomeComGatewayPersister(
  deps: HomeComTokenPersisterDeps,
): (integrationId: string, gatewayId: string) => Promise<void> {
  const patch = buildSerialPatcher({ ...deps, what: 'chosen gateway' })
  return (integrationId, gatewayId) => patch(integrationId, { gatewayId })
}
