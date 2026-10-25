/**
 * Auth-schema — typed SQL schemas for local-auth's collections.
 *
 * Mirrors the pattern used by pipeline-analytics (`event-store.ts`,
 * `track-store.ts`): each addon owns its own schema, declared once
 * in `onInitialize` via `store.declareCollection.mutate(...)`.
 *
 * Collection names (no namespace — these are global, single-tenant
 * tables backing the auth layer):
 *   - users
 *   - scoped_tokens
 *   (OAuth sessions are the `oauth-sessions` records kind only, D902.)
 *   - login_sessions, login_session_cutoffs (`login-session-manager.ts`)
 *   - admin_tokens (`legacy-token-tables.ts`, read by nothing since D895), auth_audit (`auth-audit-log.ts`)
 *
 * Schema migration: when the backend receives `declareCollection` for
 * a name that already exists with a legacy `(id, data)` KV shape, the
 * `ensureTable` helper drops the old table and recreates it. Existing
 * data is wiped — `ensureAdminExists` re-seeds the admin from
 * CAMSTACK_ADMIN_USER / CAMSTACK_ADMIN_PASS on the next boot (an empty
 * table is a first boot).
 */
import type { SettingsStoreClient } from '@camstack/types'
import { ADMIN_TOKENS_COLLECTION, ADMIN_TOKENS_COLUMNS } from '../../auth/legacy-token-tables.js'
import {
  DEVICE_CREDENTIALS_COLLECTION,
  DEVICE_CREDENTIALS_COLUMNS,
} from '../../auth/device-credential-manager.js'
import { AUTH_AUDIT_COLLECTION, AUTH_AUDIT_COLUMNS } from '../../auth/auth-audit-log.js'
import {
  LOGIN_SESSION_CUTOFFS_COLLECTION,
  LOGIN_SESSION_CUTOFFS_COLUMNS,
  LOGIN_SESSIONS_COLLECTION,
  LOGIN_SESSIONS_COLUMNS,
} from '../../auth/login-session-manager.js'

/**
 * @durable class=config owner=local-auth
 *   write="an operator creates a user, or `ensureAdminExists` seeds the configured
 *     admin on first boot (or resets its password on the operator's one-shot
 *     RESET_ADMIN_PASSWORD trigger); updated on scope, isAdmin and password edits"
 *   retention="none — a row goes only when an operator deletes the user. A
 *     `declareCollection` that adds a PK/UNIQUE/NOT-NULL-without-default column
 *     REBUILDS the table: every account is wiped and only the configured admin
 *     comes back on the next boot."
 */
export const USERS_COLLECTION = 'users'
/**
 * @durable class=config owner=local-auth
 *   write="an operator mints an API key; `validateToken` rewrites `lastUsedAt` on
 *     every request the key authorises"
 *   retention="none — an explicit `revoke` is the only delete. API keys have no
 *     expiry column and no sweep, so a key lives until someone removes it (or the
 *     destructive `declareCollection` rebuild takes the table)."
 */
/**
 * @durable class=config owner=local-auth
 *   write="none since D895 — the pre-D892 scoped-token rows are kept on disk,
 *     read by nothing (a scoped token is a `credential-tokens` row)"
 *   retention="the operator drops the table by hand"
 */
export const SCOPED_TOKENS_COLLECTION = 'scoped_tokens'
/**
 * TOTP enrollment table — split off from `users` to avoid the
 * destructive drop-+-recreate migration `ensureTable` performs when a
 * new column is added to a typed schema (see `sqlite-settings-backend.ts`).
 *
 * Lifecycle:
 *   - Setup: row inserted with `confirmedAt = null` and a fresh secret.
 *   - Confirm: a valid code from the secret flips `confirmedAt` to now().
 *   - Disable: the row is deleted (next setup starts fresh).
 *
 * "Enabled" means `confirmedAt != null`. A half-enrolled row (`confirmedAt
 * = null`) is INACTIVE — `verifyTotp` returns false until confirmation.
 *
 * @durable class=config owner=local-auth
 *   write="`setup` inserts a keychain marker for the user's seed (D878; deleting any pending row
 *     first); `confirm` flips `confirmedAt` once a valid code proves possession"
 *   retention="`disable` deletes the row, and `setup` deletes before re-inserting.
 *     Nothing else prunes — deleting a USER does not cascade here, so their
 *     enrollment row outlives the account."
 */
export const USER_TOTP_COLLECTION = 'user_totp'

/**
 * External sign-in identities linked to local users (D782): one row per
 * `(provider, subject)` — the row id IS the identity, so one identity maps to
 * one user by primary key. Written only by the identity's owner completing a
 * "Link" flow from their profile (bound to their session).
 *
 * @durable class=config owner=local-auth
 *   write="`ExternalIdentityManager.link` when a signed-in user completes a
 *     link flow; `unlink` from the profile or the Users page"
 *   retention="`unlink` deletes one row; deleting the user deletes all of its
 *     rows (`deleteUser` → `removeAllForUser`). A row whose provider instance
 *     was renamed or removed stays, inert, until someone unlinks it."
 */
export const USER_EXTERNAL_IDENTITIES_COLLECTION = 'user_external_identities'

const USERS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'username', type: 'TEXT' as const, notNull: true, unique: true },
  { name: 'passwordHash', type: 'TEXT' as const, notNull: true },
  // v2 auth (2026-05-12) — `role` enum collapsed to an `isAdmin`
  // boolean bypass flag. The settings-store `BOOLEAN` column type
  // round-trips JS bool ↔ INTEGER 0/1 transparently so consumers can
  // keep `z.boolean()` on UserRecordSchema.
  { name: 'isAdmin', type: 'BOOLEAN' as const, notNull: true },
  { name: 'allowedProviders', type: 'JSON' as const },
  { name: 'allowedDevices', type: 'JSON' as const },
  // Caps-only auth: each user carries an opaque list of TokenScope
  // grants. Admins ignore it (bypass); non-admins are locked out until
  // an admin grants something via `setUserScopes`.
  { name: 'scopes', type: 'JSON' as const },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
]

const USER_TOTP_COLUMNS = [
  { name: 'userId', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'secret', type: 'TEXT' as const, notNull: true },
  // null = setup begun but not yet confirmed; a number (unix-ms) means
  // the user proved possession of the authenticator by submitting a
  // valid 6-digit code.
  { name: 'confirmedAt', type: 'INTEGER' as const },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
]

const USER_EXTERNAL_IDENTITIES_COLUMNS = [
  // `JSON.stringify([provider, subject])` — the identity is the key.
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'provider', type: 'TEXT' as const, notNull: true },
  { name: 'subject', type: 'TEXT' as const, notNull: true },
  { name: 'issuer', type: 'TEXT' as const, notNull: true },
  { name: 'userId', type: 'TEXT' as const, notNull: true },
  { name: 'label', type: 'TEXT' as const },
  { name: 'linkedAt', type: 'INTEGER' as const, notNull: true },
]

const SCOPED_TOKENS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'userId', type: 'TEXT' as const, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'tokenHash', type: 'TEXT' as const, notNull: true, unique: true },
  { name: 'tokenPrefix', type: 'TEXT' as const, notNull: true },
  { name: 'scopes', type: 'JSON' as const },
  { name: 'expiresAt', type: 'INTEGER' as const },
  { name: 'lastUsedAt', type: 'INTEGER' as const },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
]

/**
 * Declare every auth collection with the typed schema. Called by
 * `LocalAuthAddon.onInitialize` before constructing the per-collection
 * managers. Idempotent — `declareCollection` is a no-op when the
 * collection has already been declared (same shape).
 */
export async function declareAuthSchema(
  store: Pick<SettingsStoreClient, 'declareCollection'>,
  options?: { readonly skipCollections?: readonly string[] },
): Promise<void> {
  const skip = new Set(options?.skipCollections ?? [])
  if (!skip.has(USERS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: USERS_COLLECTION,
      columns: USERS_COLUMNS,
    })
  }
  if (!skip.has(SCOPED_TOKENS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: SCOPED_TOKENS_COLLECTION,
      columns: SCOPED_TOKENS_COLUMNS,
      indexes: [{ name: 'idx_scoped_tokens_user_id', columns: ['userId'] }],
    })
  }
  if (!skip.has(USER_TOTP_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: USER_TOTP_COLLECTION,
      columns: USER_TOTP_COLUMNS,
    })
  }
  if (!skip.has(USER_EXTERNAL_IDENTITIES_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: USER_EXTERNAL_IDENTITIES_COLLECTION,
      columns: USER_EXTERNAL_IDENTITIES_COLUMNS,
      indexes: [{ name: 'idx_user_external_identities_user_id', columns: ['userId'] }],
    })
  }
  if (!skip.has(LOGIN_SESSIONS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: LOGIN_SESSIONS_COLLECTION,
      columns: LOGIN_SESSIONS_COLUMNS,
      indexes: [{ name: 'idx_login_sessions_user_id', columns: ['userId'] }],
    })
  }
  if (!skip.has(LOGIN_SESSION_CUTOFFS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: LOGIN_SESSION_CUTOFFS_COLLECTION,
      columns: LOGIN_SESSION_CUTOFFS_COLUMNS,
    })
  }
  if (!skip.has(ADMIN_TOKENS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: ADMIN_TOKENS_COLLECTION,
      columns: ADMIN_TOKENS_COLUMNS,
      indexes: [{ name: 'idx_admin_tokens_created_by', columns: ['createdBy'] }],
    })
  }
  if (!skip.has(DEVICE_CREDENTIALS_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: DEVICE_CREDENTIALS_COLLECTION,
      columns: DEVICE_CREDENTIALS_COLUMNS,
      indexes: [{ name: 'idx_device_credentials_user_id', columns: ['userId'] }],
    })
  }
  if (!skip.has(AUTH_AUDIT_COLLECTION)) {
    await store.declareCollection.mutate({
      collection: AUTH_AUDIT_COLLECTION,
      columns: AUTH_AUDIT_COLUMNS,
      indexes: [{ name: 'idx_auth_audit_user_id', columns: ['userId'] }],
    })
  }
}
