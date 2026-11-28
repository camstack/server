import { errMsg, type IConnectionProbe, type IScopedLogger } from '@dominevo/types'
import { dreoConfigSchema } from './config.js'
import { DreoBridgeError } from './dreo-bridge.js'
import type { DreoBridgeFactory } from './dreo-integration-manager.js'

/**
 * The credential probe of Dreo (`IConnectionProbe`, answered by `testInstance`) — validates
 * account credentials BEFORE the integration exists.
 *
 * The worker's `login` performs the cloud sign-in and answers the code `auth` specifically
 * when the account/password/region combination is refused, as opposed to `unreachable` (or
 * a worker that could not run) when the round trip itself failed. That distinction is what
 * lets this provider answer `rejected` and `inconclusive` honestly instead of collapsing
 * both into "failed".
 *
 * The session opened here is a THROWAWAY: its own worker process, nothing persisted, and the
 * worker is closed on every path. The sign-in also opens the account's push channel and reads
 * the device list; both go away with the worker.
 */

export interface DreoConnectionTestDeps {
  /** Factory seam — the real one spawns the Python worker; tests inject a fake. */
  readonly makeBridge: DreoBridgeFactory
  readonly logger: IScopedLogger
}

/** Human description of what pressing Test actually does. */
export function buildDreoConnectionTestProvider(deps: DreoConnectionTestDeps): IConnectionProbe {
  const { makeBridge, logger } = deps

  return {
    testSettings: async ({ settings }) => {
      // A malformed form is a REJECTION we can observe locally — the operator
      // left a required field empty, and no round trip is going to fix that.
      const parsed = dreoConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Dreo connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `Dreo account settings are incomplete or invalid: ${missing}`,
        }
      }

      const startedAt = Date.now()
      let bridge: ReturnType<DreoBridgeFactory> | null = null
      try {
        bridge = makeBridge()
        await bridge.login(parsed.data)
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        if (err instanceof DreoBridgeError && err.code === 'auth') {
          // OBSERVED refusal. Never echo the password back, and name the region
          // — a correct password against the wrong region fails exactly here.
          logger.warn('Dreo connection test: credentials refused', {
            meta: { region: parsed.data.region, email: parsed.data.email },
          })
          return {
            outcome: 'rejected',
            error:
              'Dreo refused these credentials — check the email, the password, ' +
              `and that the account belongs to the '${parsed.data.region}' region.`,
          }
        }
        // NOT observed. The cloud may be down, DNS may have failed, the hub may
        // be offline. Saying "wrong password" here would be a lie that blocks a
        // perfectly good integration.
        logger.warn('Dreo connection test: could not complete', {
          meta: { region: parsed.data.region, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `Could not reach the Dreo cloud to check these credentials: ${errMsg(err)}`,
        }
      } finally {
        try {
          bridge?.close()
        } catch (closeErr: unknown) {
          logger.warn('Dreo connection test: bridge close failed', {
            meta: { error: errMsg(closeErr) },
          })
        }
      }
    },
  }
}
