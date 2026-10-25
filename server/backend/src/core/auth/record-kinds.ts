/**
 * Record kinds owned by `core-auth` (hub-resident, phase 6 / §2.8).
 */
import { CredentialScopeSchema, defineRecordKinds, SHARE_VIEW_KINDS } from '@camstack/types'
import { z } from 'zod'

const ShareTokenScopeSchema = z.object({
  kind: z.enum(SHARE_VIEW_KINDS),
  deviceIds: z.array(z.number().int().nonnegative()).min(1).max(64),
  talk: z.boolean().optional(),
})

export const SHARE_VIEW_TOKENS_LEGACY = 'share_view_tokens'

/**
 * The pre-D892 share-link rows. Nothing writes or reads them since D895 (a
 * share link is a `credential-tokens` row); the kind stays declared so the
 * storage layout is unchanged and the operator drops the rows by hand.
 */
const ShareViewTokenBodySchema = z.object({
  userId: z.string(),
  tokenHash: z.string(),
  tokenPrefix: z.string(),
  scope: ShareTokenScopeSchema,
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullish(),
})

export type ShareViewTokenBody = z.infer<typeof ShareViewTokenBodySchema>

/**
 * The unified token (D892): one row per token `auth.mintToken` issued — the
 * hashed `jti` the verifier looks up for revocation, the label, the scopes,
 * the ONE expiry (`null` only for a never-expiring share link), last use.
 */
const CredentialTokenBodySchema = z.object({
  subjectId: z.string(),
  createdBy: z.string(),
  label: z.string(),
  jtiHash: z.string(),
  scopes: z.array(CredentialScopeSchema).min(1),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullish(),
  revokedAt: z.number().nullish(),
})

export type CredentialTokenBody = z.infer<typeof CredentialTokenBodySchema>

export const coreAuthRecordKinds = defineRecordKinds({
  'share-view-tokens': {
    schema: ShareViewTokenBodySchema,
    class: 'config',
    writeTrigger: 'none since D895 — legacy rows kept on disk for the operator to drop',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'hash', fields: ['tokenHash'], unique: true },
      { name: 'user', fields: ['userId'] },
    ],
    retention: { none: 'operator drops the legacy rows by hand (D895)' },
  },
  'credential-tokens': {
    schema: CredentialTokenBodySchema,
    class: 'config',
    writeTrigger:
      'a user mints a token (auth.mintToken or a wrapper); validate touches lastUsedAt at most once a minute; revoke stamps revokedAt',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'jti', fields: ['jtiHash'], unique: true },
      { name: 'subject', fields: ['subjectId'] },
    ],
    retention: {
      owner: 'core-auth',
      reason: 'the daily reap deletes rows expired or revoked more than 30 days ago',
    },
  },
})
