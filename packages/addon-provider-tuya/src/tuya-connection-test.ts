import { TuyaCloudError } from '@apocaliss92/nodetuya'
import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { tuyaConfigSchema } from './config.js'
import type { TuyaCloudFactory } from './tuya-integration-manager.js'

/**
 * `connection-test` cap provider for Tuya — validates IoT-cloud credentials
 * BEFORE the integration exists.
 *
 * Tuya has no standalone `login()`: the SDK signs each request, so the cheapest
 * complete check is the same `getDevices()` call the integration makes at boot.
 * It is read-only and it exercises exactly what a wrong access-id / secret /
 * region breaks — a probe that authenticated some other way would validate a
 * different thing from the one that then fails.
 *
 * `TuyaCloudError` marks an OBSERVED refusal from the cloud; a transport fault
 * observed nothing about the credentials and stays `inconclusive`.
 */

export interface TuyaConnectionTestDeps {
  readonly makeCloud: TuyaCloudFactory
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Calls the Tuya IoT cloud with this access id, secret and region'

export function buildTuyaConnectionTestProvider(
  deps: TuyaConnectionTestDeps,
): IConnectionTestProvider {
  const { makeCloud, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const parsed = tuyaConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Tuya connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `Tuya account settings are incomplete or invalid: ${missing}`,
        }
      }

      const startedAt = Date.now()
      try {
        const devices = await makeCloud(parsed.data).getDevices()
        return {
          outcome: 'validated',
          latencyMs: Date.now() - startedAt,
          detail: `${devices.length} device(s) visible on this Tuya project`,
        }
      } catch (err: unknown) {
        if (err instanceof TuyaCloudError) {
          logger.warn('Tuya connection test: cloud refused the credentials', {
            meta: { region: parsed.data.region, error: errMsg(err) },
          })
          return {
            outcome: 'rejected',
            error:
              'The Tuya cloud refused these credentials — check the access id, the ' +
              `access secret, and that the project lives in the '${parsed.data.region}' ` +
              `data centre. (${errMsg(err)})`,
          }
        }
        logger.warn('Tuya connection test: could not complete', {
          meta: { region: parsed.data.region, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `Could not reach the Tuya cloud to check these credentials: ${errMsg(err)}`,
        }
      }
    },
  }
}
