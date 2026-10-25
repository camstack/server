import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { connectionFromSettings } from './config.js'
import { fetchHomeConnectAccount, type LoginFetch } from './home-connect-login.js'

export class HomeConnectAuthError extends Error {
  readonly name = 'HomeConnectAuthError'
}

export interface HomeConnectConnectionTestDeps {
  readonly fetchImpl?: LoginFetch
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Checks the Home Connect account token and lists appliances'

export function buildHomeConnectConnectionTestProvider(
  deps: HomeConnectConnectionTestDeps,
): IConnectionTestProvider {
  const { logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const parsed = connectionFromSettings(
        typeof settings === 'object' && settings !== null
          ? Object.fromEntries(Object.entries(settings))
          : {},
      )
      if (parsed === null) {
        return {
          outcome: 'rejected',
          error: 'Home Connect settings incomplete: sign in to read the account token.',
        }
      }

      const saved = parsed.appliances ?? []
      if (saved.length > 0) {
        const names = saved.map((app) => app.name).join(', ')
        return {
          outcome: 'validated',
          latencyMs: 0,
          detail: names.length > 0 ? names : `${String(saved.length)} appliance(s) on this account`,
        }
      }

      const startedAt = Date.now()
      try {
        const account = await fetchHomeConnectAccount(parsed, deps.fetchImpl)
        return {
          outcome: 'validated',
          latencyMs: Date.now() - startedAt,
          detail: account.summary,
        }
      } catch (err: unknown) {
        const message = errMsg(err)
        if (message.includes('rejected')) {
          return {
            outcome: 'rejected',
            error: 'Home Connect refused this account token. Sign in again.',
          }
        }
        logger.warn('Home Connect account test inconclusive', {
          meta: { error: message },
        })
        return {
          outcome: 'inconclusive',
          error: 'Could not reach Home Connect to read this account.',
        }
      }
    },
  }
}
