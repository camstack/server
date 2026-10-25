#!/usr/bin/env tsx
/**
 * One-shot data migration for the caps-only auth refactor (2026-05-12)
 * + auth v2 isAdmin flag (2026-05-12).
 *
 * Run BEFORE deploying the build that ships the v2 auth model.
 *
 * What it does, idempotently:
 *   1. `ALTER TABLE users ADD COLUMN scopes JSON` — without this, the
 *      runtime `ensureTable` would see a missing declared column and
 *      DROP+RECREATE the users table on first boot (wiping the admin
 *      account). With it, `ensureTable` finds every declared column
 *      present and leaves the data alone.
 *   2. `ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0` —
 *      v2 collapses the `role` enum onto a boolean bypass flag. Same
 *      reasoning as (1): without the explicit column the auto-rebuild
 *      would wipe data.
 *   3. Backfill `users.scopes` with `[]` on rows that pre-date the field.
 *   4. Backfill `users.isAdmin = 1` for any pre-existing row whose legacy
 *      `role` column was `admin` (or the retired `super_admin`).
 *   5. `ALTER TABLE api_keys ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0`
 *      and the same backfill for legacy admin keys.
 *   6. Drop scoped tokens carrying the retired `route-prefix` scope.
 *
 * Re-runs are safe: every step checks state first and skips when no
 * work remains.
 */

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

interface PragmaRow {
  readonly name: string
}

const DEFAULT_DB = 'server/backend/camstack-data/addons-data/sqlite-settings/camstack.db'

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as PragmaRow[]
  return rows.some((r) => r.name === column)
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table) as { name?: string } | undefined
  return row?.name !== undefined
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  type: string,
): boolean {
  if (!tableExists(db, table)) {
    console.log(`  skip — table "${table}" does not exist (fresh install)`)
    return false
  }
  if (tableHasColumn(db, table, column)) {
    console.log(`  skip — column "${table}.${column}" already present`)
    return false
  }
  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`)
  console.log(`  added column "${table}.${column}" (${type})`)
  return true
}

function backfillJsonColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  value: string,
): number {
  if (!tableExists(db, table) || !tableHasColumn(db, table, column)) return 0
  const stmt = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" IS NULL`)
  const info = stmt.run(value)
  const changes = Number(info.changes)
  if (changes > 0)
    console.log(`  backfilled "${table}.${column}" = '${value}' on ${changes} row(s)`)
  return changes
}

/**
 * Backfill `isAdmin = 1` from any pre-existing `role` column whose value
 * is in `adminRoles`. Idempotent — only updates rows where `isAdmin` is
 * still 0/NULL so re-running won't promote a row that was downgraded
 * since the previous run.
 */
function backfillIsAdminFromRole(
  db: DatabaseSync,
  table: string,
  adminRoles: readonly string[],
): number {
  if (!tableExists(db, table)) return 0
  if (!tableHasColumn(db, table, 'isAdmin')) return 0
  if (!tableHasColumn(db, table, 'role')) {
    // Brand-new install — no role column ever existed, nothing to backfill.
    return 0
  }
  const placeholders = adminRoles.map(() => '?').join(',')
  const stmt = db.prepare(
    `UPDATE "${table}" SET "isAdmin" = 1 WHERE ("isAdmin" IS NULL OR "isAdmin" = 0) AND "role" IN (${placeholders})`,
  )
  const info = stmt.run(...adminRoles)
  const changes = Number(info.changes)
  if (changes > 0)
    console.log(
      `  promoted ${changes} row(s) in "${table}" to isAdmin=1 (role in [${adminRoles.join(', ')}])`,
    )
  return changes
}

function dropOrphanScopedTokens(db: DatabaseSync): number {
  if (!tableExists(db, 'scoped_tokens')) return 0
  // Pre-caps-only tokens may carry `route-prefix` scope objects. New
  // Zod schema rejects those — the token becomes unparseable and
  // gets cleaned up by `cleanupOrphans` anyway, but doing it here
  // gives a deterministic count + early warning.
  const rows = db.prepare(`SELECT id, scopes FROM "scoped_tokens"`).all() as {
    id: string
    scopes: string
  }[]
  let dropped = 0
  const drop = db.prepare(`DELETE FROM "scoped_tokens" WHERE id = ?`)
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.scopes) as Array<{ type?: string }>
      const hasLegacy = parsed.some((s) => s.type === 'route-prefix')
      if (hasLegacy) {
        drop.run(row.id)
        dropped++
      }
    } catch {
      // Malformed JSON → drop too; it would fail to parse at runtime anyway.
      drop.run(row.id)
      dropped++
    }
  }
  if (dropped > 0)
    console.log(`  dropped ${dropped} scoped token(s) with legacy route-prefix scopes`)
  return dropped
}

function summary(label: string, count: number): void {
  if (count === 0) console.log(`  ${label}: 0 (already current)`)
  else console.log(`  ${label}: ${count}`)
}

function main(): void {
  const args = parseArgs({
    options: {
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (args.values.help) {
    console.log(
      [
        'Caps-only auth migration — one-shot.',
        '',
        'Usage: tsx scripts/migrate-auth-caps-only.ts [--db <path>]',
        '',
        `  --db <path>    SQLite database path (default: ${DEFAULT_DB})`,
        '',
        'Safe to re-run; every step is idempotent.',
      ].join('\n'),
    )
    return
  }

  const dbPath = path.resolve(args.values.db ?? DEFAULT_DB)
  if (!fs.existsSync(dbPath)) {
    console.error(`error: database not found at ${dbPath}`)
    process.exit(1)
  }

  console.log(`[migrate-auth-caps-only] ${dbPath}`)
  const db = new DatabaseSync(dbPath)

  // Pre-v2 admin tier names. `super_admin` was retired in the
  // caps-only refactor; `admin` is the single legacy admin role. Both
  // map to `isAdmin = 1` in the v2 model.
  const LEGACY_ADMIN_ROLES = ['admin', 'super_admin'] as const

  try {
    db.exec('BEGIN TRANSACTION')

    console.log('1. Schema additions')
    addColumnIfMissing(db, 'users', 'scopes', 'JSON')
    addColumnIfMissing(db, 'users', 'isAdmin', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(db, 'api_keys', 'isAdmin', 'INTEGER NOT NULL DEFAULT 0')

    console.log('2. Backfill missing scopes with []')
    const backfilled = backfillJsonColumn(db, 'users', 'scopes', '[]')

    console.log('3. Backfill isAdmin from legacy role column')
    const usersPromoted = backfillIsAdminFromRole(db, 'users', LEGACY_ADMIN_ROLES)
    const keysPromoted = backfillIsAdminFromRole(db, 'api_keys', LEGACY_ADMIN_ROLES)

    console.log('4. Drop scoped tokens with legacy route-prefix scopes')
    const tokensDropped = dropOrphanScopedTokens(db)

    db.exec('COMMIT')

    console.log('')
    console.log('Summary:')
    summary('users.scopes backfilled', backfilled)
    summary('users.isAdmin promotions', usersPromoted)
    summary('api_keys.isAdmin promotions', keysPromoted)
    summary('legacy scoped tokens dropped', tokensDropped)
    console.log('')
    console.log('Migration complete. Safe to start the server with the v2 auth build.')
  } catch (err) {
    db.exec('ROLLBACK')
    console.error('Migration aborted, transaction rolled back. Underlying error:')
    console.error(err)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()
