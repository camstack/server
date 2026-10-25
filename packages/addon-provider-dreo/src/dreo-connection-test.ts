import { DreoAuthError } from '@apocaliss92/nodedreo'
import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { dreoConfigSchema } from './config.js'
import type { DreoFacadeFactory } from './dreo-integration-manager.js'

/**
 * `connection-test` cap provider for Dreo — validates account credentials
 * BEFORE the integration exists.
 *
 * The Dreo library already carries the credential check we need: `login()`
 * performs the cloud REST auth and throws `DreoAuthError` specifically when the
 * account/password/region combination is refused, as opposed to the transport
 * errors (`DreoTransportError`, `DreoApiError`) it throws when the round trip
 * itself failed. That distinction is what lets this provider answer `rejected`
 * and `inconclusive` honestly instead of collapsing both into "failed".
 *
 * The session opened here is a THROWAWAY: no WebSocket is connected, no device
 * is instantiated, nothing is persisted, and the facade is closed on every
 * path. This runs while the operator is still looking at the create form, so it
 * must leave no trace whether it passes or fails.
 */

export interface DreoConnectionTestDeps {
  /** Factory seam — the real one builds a `Nodedreo`; tests inject a fake. */
  readonly makeFacade: DreoFacadeFactory
  readonly logger: IScopedLogger
}

/** Human description of what pressing Test actually does. */
const TEST_LABEL = 'Signs in to the Dreo cloud with these account credentials'

export function buildDreoConnectionTestProvider(
  deps: DreoConnectionTestDeps,
): IConnectionTestProvider {
  const { makeFacade, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      // A malformed form is a REJECTION we can observe locally — the operator
      // left a required field empty, and no round trip is going to fix that.
      const parsed = dreoConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Dreo connection test: settings incomplete', {
          meta: { missing },
        })
        return {
          outcome: 'rejected',
          error: `Dreo account settings are incomplete or invalid: ${missing}`,
        }
      }

      const startedAt = Date.now()
      const facade = makeFacade(parsed.data)
      try {
        await facade.login()
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        if (err instanceof DreoAuthError) {
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
          facade.close()
        } catch (closeErr: unknown) {
          logger.warn('Dreo connection test: facade close failed', {
            meta: { error: errMsg(closeErr) },
          })
        }
      }
    },
  }
}
