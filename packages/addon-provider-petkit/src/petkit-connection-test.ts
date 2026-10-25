import { PetkitAuthError } from '@apocaliss92/nodepetkit'
import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { petkitConfigSchema } from './config.js'
import type { PetkitFacadeFactory } from './petkit-integration-manager.js'

/**
 * `connection-test` cap provider for PetKit — validates account credentials
 * BEFORE the integration exists.
 *
 * PetKit is a pure cloud REST client with no sockets, so `login()` is both the
 * cheapest and the most complete credential check available, and there is
 * nothing to close afterwards. `PetkitAuthError` marks an OBSERVED refusal;
 * everything else observed nothing and must stay `inconclusive`.
 */

export interface PetkitConnectionTestDeps {
  readonly makeFacade: PetkitFacadeFactory
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Signs in to the PetKit cloud with these account credentials'

export function buildPetkitConnectionTestProvider(
  deps: PetkitConnectionTestDeps,
): IConnectionTestProvider {
  const { makeFacade, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const parsed = petkitConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('PetKit connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `PetKit account settings are incomplete or invalid: ${missing}`,
        }
      }

      const startedAt = Date.now()
      try {
        await makeFacade(parsed.data).login()
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        if (err instanceof PetkitAuthError) {
          logger.warn('PetKit connection test: credentials refused', {
            meta: { region: parsed.data.region },
          })
          return {
            outcome: 'rejected',
            error:
              'PetKit refused these credentials — check the email, the password, ' +
              `and that the account belongs to the '${parsed.data.region}' region.`,
          }
        }
        logger.warn('PetKit connection test: could not complete', {
          meta: { region: parsed.data.region, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `Could not reach the PetKit cloud to check these credentials: ${errMsg(err)}`,
        }
      }
    },
  }
}
