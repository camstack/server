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
  signOut: customAction(
    z.object({}),
    z.object({ signedOut: z.literal(true), summary: z.string() }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type HomeConnectActions = typeof homeConnectActions
