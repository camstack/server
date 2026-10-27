import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

export const homeConnectActions = defineCustomActions({
  beginSignIn: customAction(
    z.object({}),
    z.object({
      attemptId: z.string().min(1),
      authorizeUrl: z.string().min(1),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  finishSignIn: customAction(
    z.object({
      attemptId: z.string().min(1),
      callback: z.string().min(1),
    }),
    z.object({
      token: z.string().min(1).meta({ secret: true }),
      refresh: z.string().optional().meta({ secret: true }),
      accountLabel: z.string(),
      /** JSON of the paired appliances — no credential on it. */
      appliances: z.string().min(1),
      /** JSON of `haId -> { psk, iv64? }`; stored in the keychain, never in `appliances`. */
      applianceSecrets: z.string().min(1).meta({ secret: true }),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  /**
   * The form asks while the proxied login page is open: `pending` until the hub captured the
   * app-scheme redirect and finished the exchange, then the same fields `finishSignIn` returns.
   * Claimed once. A failed exchange answers with its operator-facing message as an error.
   */
  claimSignIn: customAction(
    z.object({ attemptId: z.string().min(1) }),
    z.object({
      pending: z.boolean(),
      token: z.string().optional().meta({ secret: true }),
      refresh: z.string().optional().meta({ secret: true }),
      accountLabel: z.string().optional(),
      appliances: z.string().optional(),
      applianceSecrets: z.string().optional().meta({ secret: true }),
      summary: z.string().optional(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
  signOut: customAction(
    z.object({}),
    z.object({ signedOut: z.literal(true), summary: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type HomeConnectActions = typeof homeConnectActions
