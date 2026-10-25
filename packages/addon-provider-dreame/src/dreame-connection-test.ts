import { DreameAuthError } from '@apocaliss92/nodedreame'
import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { dreameConfigSchema } from './config.js'
import type { DreameFacadeFactory } from './dreame-integration-manager.js'

/**
 * `connection-test` cap provider for Dreame — validates account credentials
 * BEFORE the integration exists.
 *
 * Same contract as the Dreo one: the library's `login()` is the credential
 * check, and `DreameAuthError` is what distinguishes an OBSERVED refusal from a
 * transport fault that observed nothing. Only the former may block a create.
 *
 * The session is a throwaway — login only, no MQTT, no device instantiation,
 * nothing persisted — and it is closed on every path.
 */

export interface DreameConnectionTestDeps {
  readonly makeFacade: DreameFacadeFactory
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Signs in to the Dreame cloud with these account credentials'

export function buildDreameConnectionTestProvider(
  deps: DreameConnectionTestDeps,
): IConnectionTestProvider {
  const { makeFacade, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const parsed = dreameConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Dreame connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `Dreame account settings are incomplete or invalid: ${missing}`,
        }
      }

      const startedAt = Date.now()
      const facade = makeFacade(parsed.data)
      try {
        await facade.login()
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        if (err instanceof DreameAuthError) {
          logger.warn('Dreame connection test: credentials refused', {
            meta: { region: parsed.data.region },
          })
          return {
            outcome: 'rejected',
            error:
              'Dreame refused these credentials — check the email, the password, ' +
              `and that the account belongs to the '${parsed.data.region}' region.`,
          }
        }
        logger.warn('Dreame connection test: could not complete', {
          meta: { region: parsed.data.region, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `Could not reach the Dreame cloud to check these credentials: ${errMsg(err)}`,
        }
      } finally {
        try {
          await facade.close()
        } catch (closeErr: unknown) {
          logger.warn('Dreame connection test: facade close failed', {
            meta: { error: errMsg(closeErr) },
          })
        }
      }
    },
  }
}
