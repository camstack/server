/**
 * Record kinds owned by `local-auth` (records plan phase 6 / §2.8).
 *
 * Operator-only legacy drop: auth tables are NEVER removed by the orphan job —
 * the operator drops a legacy table by hand, offline (D902; see
 * `docs/design/records-phase-6-auth-migration.md`).
 *
 * Before hub restart: mint and test an admin token (`auth.mintToken` with `'*'`); snapshot every kind.
 *
 * `scoped-tokens` and `admin-tokens` hold pre-D892 rows read by nothing since
 * D895; they stay declared so the layout is unchanged.
 */
import {
  defineRecordKinds,
  type DefinedRecordKind,
  type RecordKindHandle,
  type RecordsAccess,
  ScopedTokenSchema,
  TokenScopeSchema,
  UserRecordSchema,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'
import { AUTH_AUDIT_COLLECTION } from '../../auth/auth-audit-log.js'
import { ADMIN_TOKENS_COLLECTION } from '../../auth/legacy-token-tables.js'
import { DEVICE_CREDENTIALS_COLLECTION } from '../../auth/device-credential-manager.js'
import {
  LOGIN_SESSION_CUTOFFS_COLLECTION,
  LOGIN_SESSIONS_COLLECTION,
} from '../../auth/login-session-manager.js'
import {
  SCOPED_TOKENS_COLLECTION,
  USER_EXTERNAL_IDENTITIES_COLLECTION,
  USER_TOTP_COLLECTION,
  USERS_COLLECTION,
} from './auth-schema.js'

const DAY_MS = 86_400_000

export type UserBody = Omit<z.infer<typeof UserRecordSchema>, 'id'>
const _userBody: z.ZodType<UserBody> = UserRecordSchema.omit({ id: true })
export const UserBodySchema: z.ZodType<UserBody> = _userBody

export type ScopedTokenBody = Omit<z.infer<typeof ScopedTokenSchema>, 'id'>
const _scopedTokenBody: z.ZodType<ScopedTokenBody> = ScopedTokenSchema.omit({
  id: true,
})
export const ScopedTokenBodySchema: z.ZodType<ScopedTokenBody> = _scopedTokenBody

export type AdminTokenBody = {
  readonly createdBy: string
  readonly name: string
  readonly tokenHash: string
  readonly tokenPrefix: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastUsedAt?: number | null
  readonly revokedAt?: number | null
}
const _adminTokenBody: z.ZodType<AdminTokenBody> = z.object({
  createdBy: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  tokenPrefix: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  lastUsedAt: z.number().nullish(),
  revokedAt: z.number().nullish(),
})
export const AdminTokenBodySchema: z.ZodType<AdminTokenBody> = _adminTokenBody

export type LoginSessionBody = {
  readonly userId: string
  readonly method: string
  readonly refreshable: boolean
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number | null
  readonly revokedReason?: string | null
  readonly refreshHash?: string | null
  readonly previousRefreshHash?: string | null
  readonly rotatedAt?: number | null
  readonly client?: string | null
  readonly ip?: string | null
  readonly credentialId?: string | null
}
const _loginSessionBody: z.ZodType<LoginSessionBody> = z.object({
  userId: z.string(),
  method: z.string(),
  refreshable: z.boolean(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().nullish(),
  revokedReason: z.string().nullish(),
  refreshHash: z.string().nullish(),
  previousRefreshHash: z.string().nullish(),
  rotatedAt: z.number().nullish(),
  client: z.string().nullish(),
  ip: z.string().nullish(),
  credentialId: z.string().nullish(),
})
export const LoginSessionBodySchema: z.ZodType<LoginSessionBody> = _loginSessionBody

export type LoginSessionCutoffBody = {
  readonly notBefore: number
}
const _loginSessionCutoffBody: z.ZodType<LoginSessionCutoffBody> = z.object({
  notBefore: z.number(),
})
export const LoginSessionCutoffBodySchema: z.ZodType<LoginSessionCutoffBody> =
  _loginSessionCutoffBody

export type OauthSessionBody = {
  readonly userId: string
  readonly username: string
  readonly integrationId: string
  readonly scopes: z.infer<typeof TokenScopeSchema>[]
  readonly createdAt: number
  readonly lastUsedAt: number
  readonly revokedAt?: number | null
}
const _oauthSessionBody: z.ZodType<OauthSessionBody> = z.object({
  userId: z.string(),
  username: z.string(),
  integrationId: z.string(),
  scopes: z.array(TokenScopeSchema),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  revokedAt: z.number().nullish(),
})
export const OauthSessionBodySchema: z.ZodType<OauthSessionBody> = _oauthSessionBody

/** TOTP seed is a keychain-backed secret (D878); the row holds only a marker. */
export type UserTotpBody = {
  readonly confirmedAt?: number | null
  readonly createdAt: number
  readonly secret: string
}
const _userTotpBody: z.ZodType<UserTotpBody> = z.object({
  confirmedAt: z.number().nullish(),
  createdAt: z.number(),
  secret: z.string().meta({ secret: true }),
})
export const UserTotpBodySchema: z.ZodType<UserTotpBody> = _userTotpBody

export type ExternalIdentityBody = {
  readonly provider: string
  readonly subject: string
  readonly issuer: string
  readonly userId: string
  readonly label?: string | null
  readonly linkedAt: number
}
const _externalIdentityBody: z.ZodType<ExternalIdentityBody> = z.object({
  provider: z.string(),
  subject: z.string(),
  issuer: z.string(),
  userId: z.string(),
  label: z.string().nullish(),
  linkedAt: z.number(),
})
export const ExternalIdentityBodySchema: z.ZodType<ExternalIdentityBody> = _externalIdentityBody

export type DeviceCredentialBody = {
  readonly userId: string
  readonly deviceName: string
  readonly platform: string
  readonly enrolledVia: string
  readonly fingerprint: string
  readonly serial: string
  readonly previousFingerprint?: string | null
  readonly renewedAt?: number | null
  readonly publicKey: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly lastUsedAt?: number | null
  readonly lastUsedFrom?: string | null
  readonly revokedAt?: number | null
  readonly revokedBy?: string | null
}
const _deviceCredentialBody: z.ZodType<DeviceCredentialBody> = z.object({
  userId: z.string(),
  deviceName: z.string(),
  platform: z.string(),
  enrolledVia: z.string(),
  fingerprint: z.string(),
  serial: z.string(),
  previousFingerprint: z.string().nullish(),
  renewedAt: z.number().nullish(),
  publicKey: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  lastUsedAt: z.number().nullish(),
  lastUsedFrom: z.string().nullish(),
  revokedAt: z.number().nullish(),
  revokedBy: z.string().nullish(),
})
export const DeviceCredentialBodySchema: z.ZodType<DeviceCredentialBody> = _deviceCredentialBody

export type AuthAuditBody = {
  readonly action: string
  readonly userId?: string | null
  readonly ip?: string | null
  readonly detail?: string | null
}
const _authAuditBody: z.ZodType<AuthAuditBody> = z.object({
  action: z.string(),
  userId: z.string().nullish(),
  ip: z.string().nullish(),
  detail: z.string().nullish(),
})
export const AuthAuditBodySchema: z.ZodType<AuthAuditBody> = _authAuditBody

const _localAuthRecordKinds = defineRecordKinds({
  users: {
    schema: UserBodySchema,
    class: 'config',
    writeTrigger:
      'operator user CRUD, password reset, or `ensureAdminExists` first-boot seed (admin/changeme)',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'username', fields: ['username'], unique: true }],
    retention: {
      none: 'row goes only when an operator deletes the user; destructive declareCollection rebuild wipes all accounts',
    },
  },
  'scoped-tokens': {
    schema: ScopedTokenBodySchema,
    class: 'config',
    writeTrigger: 'none since D895 — legacy rows kept on disk for the operator to drop',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'hash', fields: ['tokenHash'], unique: true },
      { name: 'user', fields: ['userId'] },
    ],
    retention: { none: 'the operator drops the legacy rows by hand (D895)' },
  },
  'admin-tokens': {
    schema: AdminTokenBodySchema,
    class: 'config',
    writeTrigger: 'none since D895 — legacy rows kept on disk for the operator to drop',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'hash', fields: ['tokenHash'], unique: true },
      { name: 'created_by', fields: ['createdBy'] },
    ],
    retention: { none: 'the operator drops the legacy rows by hand (D895)' },
  },
  'login-sessions': {
    schema: LoginSessionBodySchema,
    class: 'ledger',
    writeTrigger: 'each login, refresh rotation, renewal, or revocation',
    device: 'none',
    at: 'required',
    indexes: [
      { name: 'refresh', fields: ['refreshHash'] },
      { name: 'user', fields: ['userId'] },
    ],
    retention: {
      owner: 'local-auth',
      reason: 'daily reap: expired >7d and revoked >30d',
    },
  },
  'login-session-cutoffs': {
    schema: LoginSessionCutoffBodySchema,
    class: 'config',
    writeTrigger: 'revoke-all-sessions for a user (password change, delete, logout everywhere)',
    device: 'none',
    at: 'none',
    retention: { none: 'one row per user who ever had all sessions revoked' },
  },
  'oauth-sessions': {
    schema: OauthSessionBodySchema,
    class: 'ledger',
    writeTrigger: 'OAuth code exchange; refresh touches lastUsedAt; revoke stamps revokedAt',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'user', fields: ['userId'] },
      // The daily reap's range: without it the sweep's `where: { revokedAt }`
      // is an unindexed filter the engine refuses (D902).
      { name: 'revoked', fields: ['revokedAt'] },
    ],
    retention: {
      owner: 'local-auth',
      reason:
        'daily reap deletes sessions revoked more than 30 days ago; an active session has no lifetime, so no engine TTL',
    },
  },
  'user-totp': {
    schema: UserTotpBodySchema,
    class: 'config',
    writeTrigger: 'setup inserts seed (keychain); confirm sets confirmedAt; disable deletes row',
    device: 'none',
    at: 'none',
    retention: {
      none: 'disable or replace on re-setup; user delete does not cascade',
    },
  },
  'user-external-identities': {
    schema: ExternalIdentityBodySchema,
    class: 'config',
    writeTrigger: 'link / unlink external identity from profile',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'user', fields: ['userId'] },
      { name: 'subject', fields: ['provider', 'subject'], unique: true },
    ],
    retention: { none: 'unlink or deleteUser removes rows' },
  },
  'device-credentials': {
    schema: DeviceCredentialBodySchema,
    class: 'config',
    writeTrigger: 'enrollment, renewal, login touch, admin revoke/rename',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'fingerprint', fields: ['fingerprint'] },
      { name: 'user', fields: ['userId'] },
    ],
    retention: {
      owner: 'local-auth',
      reason: 'daily reap removes revoked/expired rows older than 90 days',
    },
  },
  'auth-audit': {
    schema: AuthAuditBodySchema,
    class: 'audit',
    writeTrigger: 'one row per audited auth event (never blocks the action)',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'user', fields: ['userId'] }],
    retention: { ttlMs: 90 * DAY_MS, from: 'at' },
  },
}) satisfies IsolatedRecordKinds

export type LocalAuthRecordKindsMap = {
  readonly users: DefinedRecordKind<z.ZodType<UserBody>>
  readonly 'scoped-tokens': DefinedRecordKind<z.ZodType<ScopedTokenBody>>
  readonly 'admin-tokens': DefinedRecordKind<z.ZodType<AdminTokenBody>>
  readonly 'login-sessions': DefinedRecordKind<z.ZodType<LoginSessionBody>>
  readonly 'login-session-cutoffs': DefinedRecordKind<z.ZodType<LoginSessionCutoffBody>>
  readonly 'oauth-sessions': DefinedRecordKind<z.ZodType<OauthSessionBody>>
  readonly 'user-totp': DefinedRecordKind<z.ZodType<UserTotpBody>>
  readonly 'user-external-identities': DefinedRecordKind<z.ZodType<ExternalIdentityBody>>
  readonly 'device-credentials': DefinedRecordKind<z.ZodType<DeviceCredentialBody>>
  readonly 'auth-audit': DefinedRecordKind<z.ZodType<AuthAuditBody>>
}

export const localAuthRecordKinds: LocalAuthRecordKindsMap = _localAuthRecordKinds

export const localAuthUsersRecordKind: DefinedRecordKind<z.ZodType<UserBody>> =
  _localAuthRecordKinds.users

export const localAuthScopedTokensRecordKind: DefinedRecordKind<z.ZodType<ScopedTokenBody>> =
  _localAuthRecordKinds['scoped-tokens']

export const localAuthAdminTokensRecordKind: DefinedRecordKind<z.ZodType<AdminTokenBody>> =
  _localAuthRecordKinds['admin-tokens']

export const localAuthLoginSessionsRecordKind: DefinedRecordKind<z.ZodType<LoginSessionBody>> =
  _localAuthRecordKinds['login-sessions']

export const localAuthLoginSessionCutoffsRecordKind: DefinedRecordKind<
  z.ZodType<LoginSessionCutoffBody>
> = _localAuthRecordKinds['login-session-cutoffs']

export const localAuthOauthSessionsRecordKind: DefinedRecordKind<z.ZodType<OauthSessionBody>> =
  _localAuthRecordKinds['oauth-sessions']

export const localAuthUserTotpRecordKind: DefinedRecordKind<z.ZodType<UserTotpBody>> =
  _localAuthRecordKinds['user-totp']

export const localAuthUserExternalIdentitiesRecordKind: DefinedRecordKind<
  z.ZodType<ExternalIdentityBody>
> = _localAuthRecordKinds['user-external-identities']

export const localAuthDeviceCredentialsRecordKind: DefinedRecordKind<
  z.ZodType<DeviceCredentialBody>
> = _localAuthRecordKinds['device-credentials']

export const localAuthAuthAuditRecordKind: DefinedRecordKind<z.ZodType<AuthAuditBody>> =
  _localAuthRecordKinds['auth-audit']

/** Legacy collections that must not be `declareCollection` once these kinds are live. */
export const LOCAL_AUTH_RECORDS_LEGACY_COLLECTIONS: readonly string[] = [
  USERS_COLLECTION,
  SCOPED_TOKENS_COLLECTION,
  ADMIN_TOKENS_COLLECTION,
  LOGIN_SESSIONS_COLLECTION,
  LOGIN_SESSION_CUTOFFS_COLLECTION,
  USER_TOTP_COLLECTION,
  USER_EXTERNAL_IDENTITIES_COLLECTION,
  DEVICE_CREDENTIALS_COLLECTION,
  AUTH_AUDIT_COLLECTION,
]

export interface LocalAuthRecordStores {
  readonly users: RecordKindHandle<UserBody>
  readonly loginSessions: RecordKindHandle<LoginSessionBody>
  readonly loginSessionCutoffs: RecordKindHandle<LoginSessionCutoffBody>
  readonly oauthSessions: RecordKindHandle<OauthSessionBody>
  readonly userTotp: RecordKindHandle<UserTotpBody>
  readonly userExternalIdentities: RecordKindHandle<ExternalIdentityBody>
  readonly deviceCredentials: RecordKindHandle<DeviceCredentialBody>
  readonly authAudit: RecordKindHandle<AuthAuditBody>
}

export function localAuthRecordStoresOf(
  records: Pick<RecordsAccess, 'kind'>,
): LocalAuthRecordStores {
  return {
    users: records.kind(localAuthUsersRecordKind),
    loginSessions: records.kind(localAuthLoginSessionsRecordKind),
    loginSessionCutoffs: records.kind(localAuthLoginSessionCutoffsRecordKind),
    oauthSessions: records.kind(localAuthOauthSessionsRecordKind),
    userTotp: records.kind(localAuthUserTotpRecordKind),
    userExternalIdentities: records.kind(localAuthUserExternalIdentitiesRecordKind),
    deviceCredentials: records.kind(localAuthDeviceCredentialsRecordKind),
    authAudit: records.kind(localAuthAuthAuditRecordKind),
  }
}
