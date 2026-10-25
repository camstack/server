#!/usr/bin/env tsx
/**
 * Physical-table ratchet — **the set of SQLite tables the code can create is
 * a committed list, and it only shrinks** (D901).
 *
 * ## Why
 *
 * The records migration (D881 → D900) moved every addon's facts and documents
 * into `ctx.records`: one engine-owned table family per file, indexes and
 * retention declared per kind, a secret field a feature of the kind. What is
 * left as a PHYSICAL table is either engine internals, a store that stays
 * physical by decision (the keychain, the backup encryption keys), or a
 * system table queued to move. A new `declareCollection`, a new canonical KV
 * collection or a new raw `CREATE TABLE` is the shape the migration spent two
 * months undoing — and nothing stopped one from landing: the storage map
 * (`docs/reference/storage.md`) DESCRIBES a new table, it never refuses one.
 *
 * ## What it checks
 *
 * The workspace is read with the storage-map parser (`scripts/lib/parse-storage.ts`,
 * the same one `docs-generate` uses): the canonical KV list, every
 * `declareCollection` and every raw `CREATE TABLE` under `packages/` and
 * `server/`. The result is compared with two committed lists:
 *
 * - {@link ALLOWED_TABLES} — every table name the parser resolves;
 * - {@link ALLOWED_UNRESOLVED_SITES} — every call site whose table name the
 *   parser cannot resolve statically (`<file> :: <expression>`), so a new
 *   table cannot slip past through a computed name.
 *
 * It fails on a name or site NOT in a list (new state goes to `ctx.records`; a
 * new physical table needs an ADR that says why it cannot be a record kind,
 * and the list entry lands with it) and on a listed name or site that no
 * longer exists (shrink-only: delete the line in the same change that removed
 * the table — the operator drops the table offline, there is no boot purge).
 *
 * Usage: npx tsx scripts/check-physical-tables-ratchet.ts
 *        npx tsx scripts/check-physical-tables-ratchet.ts --print   # what the parser sees now
 */
import * as path from 'node:path'
import { buildStorageMap, type StorageMap } from './lib/parse-storage.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BACKEND = 'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts'

/** Every physical table name the code may create today. Shrink-only. */
export const ALLOWED_TABLES: readonly string[] = [
  '_record_kinds',
  '_record_sequences',
  'addon-device-settings',
  'addon-settings',
  'backup_encryption_keys',
  'device-manager:devices',
  'device-runtime-state',
  'keychain:audit',
  'keychain:keys',
  'keychain:resets',
  'keychain:secrets',
  'pipeline-analytics:media',
  'pipeline-analytics:object-events',
  'pipeline-analytics:tracks',
  'records',
  'scoped_tokens',
  'storage_drain_state',
  'storage_locations',
  'system-settings',
  'user_external_identities',
  'user_totp',
  'users',
]

/**
 * Call sites whose table name the parser cannot resolve, as `<file> :: <expression>`.
 * Repeated entries are repeated call sites in one file. Shrink-only.
 */
export const ALLOWED_UNRESOLVED_SITES: readonly string[] = [
  'packages/addon-pipeline-orchestrator/src/durable/durable-legacy-kind-handle.ts :: spec.collection',
  'packages/addon-pipeline/src/durable/durable-legacy-kind-handle.ts :: spec.collection',
  'packages/addon-pipeline/src/durable/row-map-store.ts :: spec.collection',
  'packages/system/src/builtins/keychain/keychain-store.ts :: archive',
  'packages/system/src/builtins/keychain/keychain-store.ts :: archive',
  'packages/system/src/builtins/local-auth/auth-schema.ts :: ADMIN_TOKENS_COLLECTION',
  'packages/system/src/builtins/local-auth/auth-schema.ts :: AUTH_AUDIT_COLLECTION',
  'packages/system/src/builtins/local-auth/auth-schema.ts :: DEVICE_CREDENTIALS_COLLECTION',
  'packages/system/src/builtins/local-auth/auth-schema.ts :: LOGIN_SESSIONS_COLLECTION',
  'packages/system/src/builtins/local-auth/auth-schema.ts :: LOGIN_SESSION_CUTOFFS_COLLECTION',
  'packages/system/src/builtins/sqlite-storage/integration-registry.ts :: INTEGRATIONS',
  'packages/system/src/builtins/sqlite-storage/integration-registry.ts :: INTEGRATION_SETTINGS',
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts :: ${SqliteSettingsBackend.DECLARATIONS_TABLE}',
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts :: ${scoped}',
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts :: ${table}',
  'packages/system/src/builtins/sqlite-storage/vector-index-vec.ts :: ${registryTable}',
  'packages/system/src/builtins/sqlite-storage/vector-index-vec.ts :: ${registryTable}',
  'packages/system/src/builtins/system-config/system-config.addon.ts :: AGENT_HTTPS_NAMES_COLLECTION',
  'packages/system/src/builtins/system-config/system-config.addon.ts :: MESH_NODE_CERTIFICATES_COLLECTION',
]

/** What the parser found, in the lists' shape. */
export interface PhysicalTableCensus {
  readonly tables: readonly string[]
  readonly unresolvedSites: readonly string[]
}

export function censusOf(map: StorageMap): PhysicalTableCensus {
  const tables = [...new Set([...map.canonical, ...map.declared.map((d) => d.name)])].toSorted()
  const unresolvedSites = map.unresolved.map((d) => `${d.file} :: ${d.name}`).toSorted()
  return { tables, unresolvedSites }
}

/** Entries of `found` beyond `allowed` (multiset: a repeated site counts each time). */
function surplus(found: readonly string[], allowed: readonly string[]): string[] {
  const budget = new Map<string, number>()
  for (const a of allowed) budget.set(a, (budget.get(a) ?? 0) + 1)
  const out: string[] = []
  for (const f of found) {
    const left = budget.get(f) ?? 0
    if (left > 0) budget.set(f, left - 1)
    else out.push(f)
  }
  return out
}

export interface RatchetAllowance {
  readonly tables: readonly string[]
  readonly unresolvedSites: readonly string[]
}

/** The failures, one message each; empty when the census matches the lists exactly. */
export function ratchetFailures(
  census: PhysicalTableCensus,
  allowed: RatchetAllowance = {
    tables: ALLOWED_TABLES,
    unresolvedSites: ALLOWED_UNRESOLVED_SITES,
  },
): string[] {
  const failures: string[] = []
  for (const name of surplus(census.tables, allowed.tables)) {
    failures.push(
      `new physical table "${name}".\n` +
        '      → new state goes to ctx.records (a record kind). A new physical table needs an ADR\n' +
        '        saying why it cannot be a record kind; add it to ALLOWED_TABLES in that change.',
    )
  }
  for (const site of surplus(census.unresolvedSites, allowed.unresolvedSites)) {
    failures.push(
      `new table call site with a computed name: ${site}.\n` +
        '      → new state goes to ctx.records. If this is an existing table reached from a new\n' +
        '        site, name it with a literal or a same-file constant so the parser resolves it.',
    )
  }
  for (const name of surplus(allowed.tables, census.tables)) {
    failures.push(
      `"${name}" is in ALLOWED_TABLES but the code no longer creates it — delete the line\n` +
        '      (shrink-only; the table itself is dropped offline by the operator).',
    )
  }
  for (const site of surplus(allowed.unresolvedSites, census.unresolvedSites)) {
    failures.push(
      `"${site}" is in ALLOWED_UNRESOLVED_SITES but no longer exists — delete the line (shrink-only).`,
    )
  }
  return failures
}

function main(): void {
  const census = censusOf(buildStorageMap(ROOT, path.join(ROOT, BACKEND)))
  if (process.argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`)
    return
  }
  const failures = ratchetFailures(census)
  if (failures.length > 0) {
    process.stderr.write(`✖ physical-table ratchet (D901): ${failures.length} failure(s)\n`)
    for (const f of failures) process.stderr.write(`  - ${f}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `  ✔ physical tables: ${census.tables.length} allowed table(s), ${census.unresolvedSites.length} unresolved site(s), shrink-only\n`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
