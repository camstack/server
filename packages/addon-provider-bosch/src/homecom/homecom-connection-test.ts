import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { homeComConfigSchema, type HomeComConfig } from './config.js'
import {
  createHomeComApiClient,
  HomeComAuthError,
  HomeComGatewayListError,
  type HomeComApiClient,
} from './homecom-api-client.js'

export interface HomeComConnectionTestDeps {
  readonly logger: IScopedLogger
  readonly makeClient?: (config: HomeComConfig, gatewayId: string) => HomeComApiClient
}

const TEST_LABEL = 'Lists the account gateways and reads the heat-pump system snapshot'
const NO_GATEWAY = 'This Bosch account has no HomeCom gateway.'

function signInIncomplete(paths: readonly string[]): string {
  if (paths.includes('token') || paths.includes('refresh')) {
    return 'Sign in first. Bosch has not issued an access token yet.'
  }
  return `HomeCom could not use the saved sign-in (${paths.join(', ')}).`
}

function listFailureMessage(err: unknown): string | null {
  if (err instanceof HomeComGatewayListError) return err.message
  if (err instanceof Error && err.message.startsWith('The gateway list failed')) return err.message
  return null
}

export function buildHomeComConnectionTestProvider(
  deps: HomeComConnectionTestDeps,
): IConnectionTestProvider {
  const { logger } = deps
  const makeClient =
    deps.makeClient ?? ((config, gatewayId) => createHomeComApiClient(config, gatewayId))

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const parsed = homeComConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')
        return {
          outcome: 'rejected',
          error: signInIncomplete(missing),
        }
      }

      const startedAt = Date.now()

      try {
        // No token refresh here: a refresh rotates the stored refresh token and a test has
        // nowhere to store the new one, which would lock the operator out.
        const gateways = await makeClient(parsed.data, '').listGateways()
        const gatewayId = parsed.data.gatewayId ?? gateways[0]?.gatewayId
        if (gatewayId === undefined) {
          return {
            outcome: 'rejected',
            error: NO_GATEWAY,
          }
        }
        if (!gateways.some((g) => g.gatewayId === gatewayId)) {
          return {
            outcome: 'rejected',
            error: `Gateway ${gatewayId} is not on this account.`,
          }
        }
        await makeClient(parsed.data, gatewayId).fetchSystem()
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        const listed = listFailureMessage(err)
        if (listed !== null) {
          return { outcome: 'rejected', error: listed }
        }
        if (err instanceof HomeComAuthError) {
          return {
            outcome: 'rejected',
            error: 'HomeCom refused the access token — sign in again to get a fresh one.',
          }
        }
        logger.warn('HomeCom connection test inconclusive', {
          meta: { error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: 'Could not reach the HomeCom cloud API.',
        }
      }
    },
  }
}
