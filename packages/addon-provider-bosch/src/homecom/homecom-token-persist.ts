import { errMsg, type IScopedLogger } from '@camstack/types'
import type { HomeComTokens } from './homecom-api-client.js'
import type { HomeComStored } from './homecom-instances.js'

export interface HomeComTokenPersisterDeps {
  /** The integration's record as a settings map; `locked` when its secrets cannot be read. */
  readonly read: (integrationId: string) => Promise<HomeComStored | null>
  /** Merge a patch into the record (a secret key goes to the keychain). */
  readonly patch: (integrationId: string, patch: Record<string, unknown>) => Promise<unknown>
  readonly logger: Pick<IScopedLogger, 'warn'>
}

export interface HomeComSettingsPatchDeps extends HomeComTokenPersisterDeps {
  readonly what: string
}

/**
 * Patch the integration's record, one write at a time per integration. Refuses (and says so,
 * without values) when the record's secrets cannot be read right now: the write would replace a
 * secret the addon cannot see.
 */
function buildSerialPatcher(deps: HomeComSettingsPatchDeps) {
  const tails = new Map<string, Promise<void>>()
  return (integrationId: string, patch: Record<string, unknown>): Promise<void> => {
    const run = async (): Promise<void> => {
      try {
        const stored = await deps.read(integrationId)
        if (stored === null) return
        if (stored.locked) {
          deps.logger.warn(`HomeCom not persisting ${deps.what} — stored secrets are locked`, {
            tags: { integrationId },
          })
          return
        }
        await deps.patch(integrationId, patch)
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
