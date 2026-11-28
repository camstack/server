import { createHash } from 'node:crypto'
import { errMsg, type IConnectionProbe, type IScopedLogger } from '@dominevo/types'
import { kiaConfigSchema } from './config.js'
import { KiaBridgeError } from './kia-bridge.js'
import type { KiaBridgeFactory } from './kia-integration-manager.js'

/**
 * The credential probe of Kia (`IConnectionProbe`, answered by `testInstance`) — validates
 * account credentials BEFORE the integration exists. It costs one sign-in of the day's quota.
 *
 * The worker's `login` performs the cloud sign-in and answers the code `auth` specifically
 * when the username/password/PIN/region combination is refused, as opposed to `unreachable` (or
 * a worker that could not run) when the round trip itself failed. That distinction is what
 * lets this provider answer `rejected` and `inconclusive` honestly instead of collapsing
 * both into "failed".
 *
 * The session opened here is a THROWAWAY: its own worker process, nothing persisted, and the
 * worker is closed on every path. The sign-in also lists the vehicles; they go away with the worker.
 */

export interface KiaConnectionTestDeps {
  /** Factory seam — the real one spawns the Python worker; tests inject a fake. */
  readonly makeBridge: KiaBridgeFactory
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/** The least time between two test sign-ins of one account: each is a login the cloud counts. */
export const KIA_TEST_MIN_GAP_MS = 60_000

function fingerprint(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\u0000')).digest('hex')
}

/** Human description of what pressing Test actually does. */
export function buildKiaConnectionTestProvider(deps: KiaConnectionTestDeps): IConnectionProbe {
  const { makeBridge, logger } = deps
  const now = deps.now ?? Date.now
  // Kept in memory only, as digests: the last test of each account, and the credential sets the
  // cloud refused. A wrong password tried again is how an account gets locked.
  const lastTestAt = new Map<string, number>()
  const refused = new Set<string>()

  return {
    testSettings: async ({ settings }) => {
      // A malformed form is a REJECTION we can observe locally — the operator
      // left a required field empty, and no round trip is going to fix that.
      const parsed = kiaConfigSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Kia connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `Kia account settings are incomplete or invalid: ${missing}`,
        }
      }

      const { username, password, pin, region, brand } = parsed.data
      const account = fingerprint([username, region, brand])
      const credentials = fingerprint([username, password, pin, region, brand])
      if (refused.has(credentials)) {
        return {
          outcome: 'rejected',
          error:
            'Kia already refused exactly these credentials; change the username, password, PIN or region before testing again.',
        }
      }
      const last = lastTestAt.get(account)
      if (last !== undefined && now() - last < KIA_TEST_MIN_GAP_MS) {
        const waitS = Math.ceil((KIA_TEST_MIN_GAP_MS - (now() - last)) / 1000)
        return {
          outcome: 'inconclusive',
          error: `This account was tested moments ago; each test is a cloud sign-in. Try again in ${waitS} s.`,
        }
      }
      lastTestAt.set(account, now())
      const startedAt = Date.now()
      let bridge: ReturnType<KiaBridgeFactory> | null = null
      try {
        bridge = makeBridge()
        await bridge.login(parsed.data)
        return { outcome: 'validated', latencyMs: Date.now() - startedAt }
      } catch (err: unknown) {
        if (err instanceof KiaBridgeError && err.code === 'otp-required') {
          return {
            outcome: 'rejected',
            error:
              'This account asks for a one-time code at sign-in, which this integration cannot answer.',
          }
        }
        if (err instanceof KiaBridgeError && err.code === 'auth') {
          refused.add(credentials)
          // OBSERVED refusal. Never echo the password back, and name the region
          // — a correct password against the wrong region fails exactly here.
          logger.warn('Kia connection test: credentials refused', {
            meta: { region: parsed.data.region, brand: parsed.data.brand },
          })
          return {
            outcome: 'rejected',
            error:
              'Kia refused these credentials — check the username, the password, the PIN, ' +
              `and that the account belongs to the '${parsed.data.region}' region.`,
          }
        }
        // NOT observed. The cloud may be down, DNS may have failed, the hub may
        // be offline. Saying "wrong password" here would be a lie that blocks a
        // perfectly good integration.
        logger.warn('Kia connection test: could not complete', {
          meta: { region: parsed.data.region, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error: `Could not reach the Kia cloud to check these credentials: ${errMsg(err)}`,
        }
      } finally {
        try {
          bridge?.close()
        } catch (closeErr: unknown) {
          logger.warn('Kia connection test: bridge close failed', {
            meta: { error: errMsg(closeErr) },
          })
        }
      }
    },
  }
}
