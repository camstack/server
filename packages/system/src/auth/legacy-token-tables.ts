/**
 * The pre-D892 admin-token table — its LAYOUT only (D895).
 *
 * Nothing mints, reads or validates an admin token of the old format any more:
 * an admin token is a `core-auth` `credential-tokens` row whose scopes hold
 * `'*'`. The table stays declared so the storage layout is unchanged; its rows
 * stay on disk until the operator drops them by hand.
 */
import type { CollectionColumn } from '@camstack/types'

/**
 * @durable class=config owner=local-auth
 *   write="none since D895 — the pre-D892 rows are kept on disk, read by nothing"
 *   retention="the operator drops the table by hand"
 */
export const ADMIN_TOKENS_COLLECTION = 'admin_tokens'

export const ADMIN_TOKENS_COLUMNS: readonly CollectionColumn[] = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'createdBy', type: 'TEXT' as const, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'tokenHash', type: 'TEXT' as const, notNull: true, unique: true },
  { name: 'tokenPrefix', type: 'TEXT' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'expiresAt', type: 'INTEGER' as const, notNull: true },
  { name: 'lastUsedAt', type: 'INTEGER' as const },
  { name: 'revokedAt', type: 'INTEGER' as const },
]
