import { WyzeCloud } from '@apocaliss92/wyze-bridge-js'
import type { WyzeCamera } from '@apocaliss92/wyze-bridge-js'
import { errMsg, type IConnectionTestProvider, type IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import type { WyzeCredentials } from './cloud-client.js'
import { classifyCloudError } from './error-classifier.js'

/**
 * `connection-test` cap provider for Wyze — validates account credentials
 * BEFORE the integration exists.
 *
 * Wyze auth requires email + password + API Key + Key ID. The real cloud
 * `ensureSession` path can throw three distinct error shapes:
 *
 *  - `{ needsMfa: true }` — MFA account: the bridge has no completion flow;
 *    the operator must use a sub-account or disable MFA → `rejected`.
 *  - Credential / login errors (HTTP-level rejections) → `rejected`.
 *  - Rate-limit (429) or network failures → `inconclusive` (says nothing
 *    about credential correctness; saying "wrong password" would lie).
 *
 * The session opened here is a THROWAWAY: the factory injects no-op
 * load/save/clear callbacks so no `wyze-session.json` is written or read.
 * This runs while the operator is still on the create form, so it must
 * leave no trace whether it passes or fails.
 */

// ---------------------------------------------------------------------------
// Minimal cloud facade — allows test injection without touching the real disk
// ---------------------------------------------------------------------------

export interface WyzeCloudFacade {
  ensureSession(email: string, password: string): Promise<void>
  getCameraList(): Promise<readonly WyzeCamera[]>
}

export type WyzeCloudFacadeFactory = (credentials: WyzeCredentials) => WyzeCloudFacade

/**
 * Production default: creates a `WyzeCloud` with no-op session hooks so
 * `testSettings` never writes or reads `wyze-session.json`.
 */
export function defaultWyzeCloudFacadeFactory(credentials: WyzeCredentials): WyzeCloudFacade {
  const cloud = new WyzeCloud({
    apiKey: credentials.apiKey,
    apiId: credentials.apiId,
    loadSession: () => null,
    saveSession: () => undefined,
    clearSession: () => undefined,
  })
  return {
    ensureSession: (email, password) => cloud.ensureSession(email, password),
    getCameraList: () => cloud.getCameraList(),
  }
}

// ---------------------------------------------------------------------------
// Settings validation schema (Wyze credentials)
// ---------------------------------------------------------------------------

export const wyzeCredentialsSchema = z.object({
  email: z.string().min(1).describe('Wyze account email'),
  password: z.string().min(1).describe('Wyze account password').meta({ secret: true }),
  apiKey: z.string().min(1).describe('Wyze developer API key').meta({ secret: true }),
  apiId: z.string().min(1).describe('Wyze developer Key ID'),
})

export type WyzeCredentialsFromSchema = z.infer<typeof wyzeCredentialsSchema>

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface WyzeConnectionTestDeps {
  /** Factory seam — the real one builds a no-op-session WyzeCloud; tests inject a fake. */
  readonly makeCloud: WyzeCloudFacadeFactory
  readonly logger: IScopedLogger
}

const TEST_LABEL = 'Signs in to the Wyze cloud with these account credentials'

export function buildWyzeConnectionTestProvider(
  deps: WyzeConnectionTestDeps,
): IConnectionTestProvider {
  const { makeCloud, logger } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      // A malformed form is a local rejection — no round trip will fix a
      // missing required field.
      const parsed = wyzeCredentialsSchema.safeParse(settings)
      if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')
        logger.warn('Wyze connection test: settings incomplete', { meta: { missing } })
        return {
          outcome: 'rejected',
          error: `Wyze account settings are incomplete or invalid: ${missing}`,
        }
      }

      const { email, password, apiKey, apiId } = parsed.data
      const startedAt = Date.now()
      const cloud = makeCloud({ email, password, apiKey, apiId })

      try {
        await cloud.ensureSession(email, password)

        // Attempt to list cameras for a richer "validated" detail; a failure
        // here should not override the validated outcome — auth succeeded.
        let cameraCount: number | null = null
        try {
          const cams = await cloud.getCameraList()
          cameraCount = cams.length
        } catch {
          // getCameraList failure is non-fatal during the credential check
        }

        return {
          outcome: 'validated',
          latencyMs: Date.now() - startedAt,
          ...(cameraCount !== null
            ? {
                detail: `Found ${cameraCount} camera${cameraCount === 1 ? '' : 's'} on this account`,
              }
            : {}),
        }
      } catch (err: unknown) {
        const classified = classifyCloudError(err)

        if (classified.kind === 'mfa') {
          logger.warn('Wyze connection test: MFA required', { meta: { email } })
          return {
            outcome: 'rejected',
            error: classified.message,
          }
        }

        if (classified.kind === 'credentials') {
          logger.warn('Wyze connection test: credentials refused', { meta: { email } })
          return {
            outcome: 'rejected',
            error:
              'Wyze refused these credentials — check the email, password, API Key and Key ID. ' +
              classified.message,
          }
        }

        // rate-limited, p2p, or unknown transport: the cloud may be down or
        // we hit the rate window. Saying "wrong password" here would be a lie.
        logger.warn('Wyze connection test: could not complete', {
          meta: { email, kind: classified.kind, error: errMsg(err) },
        })
        return {
          outcome: 'inconclusive',
          error:
            classified.kind === 'rate-limited'
              ? `Could not verify credentials — rate-limited by the Wyze cloud. Retry in ~30 s. ${classified.message}`
              : `Could not reach the Wyze cloud to verify these credentials: ${errMsg(err)}`,
        }
      }
    },
  }
}
