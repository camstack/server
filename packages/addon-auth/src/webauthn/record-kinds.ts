/**
 * Record kinds owned by `auth-webauthn` (records plan phase 6 / §2.8). The
 * legacy `auth-webauthn:*` collections they replaced are gone (D900).
 */
import { defineRecordKinds } from '@camstack/types'
import { z } from 'zod'

export const PasskeyBodySchema = z.object({
  credentialId: z.string(),
  userId: z.string(),
  publicKey: z.string(),
  counter: z.number(),
  transports: z.array(z.string()).readonly(),
  label: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullish(),
})

export type PasskeyBody = z.infer<typeof PasskeyBodySchema>

export const PasskeyPrefBodySchema = z.object({
  secondFactorEnabled: z.boolean(),
  updatedAt: z.number(),
})

export type PasskeyPrefBody = z.infer<typeof PasskeyPrefBodySchema>

export const authWebauthnRecordKinds = defineRecordKinds({
  passkeys: {
    schema: PasskeyBodySchema,
    class: 'config',
    writeTrigger:
      'finishRegistration persists one credential; updateCounter on every successful assertion',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'credential', fields: ['credentialId'], unique: true },
      { name: 'user', fields: ['userId'] },
    ],
    retention: {
      none: 'removePasskey only — no sweep; user delete does not cascade',
    },
  },
  'passkey-prefs': {
    schema: PasskeyPrefBodySchema,
    class: 'config',
    writeTrigger: 'setSecondFactorPreference upserts one row per user',
    device: 'none',
    at: 'none',
    retention: { none: 'missing row reads as second factor OFF' },
  },
})
