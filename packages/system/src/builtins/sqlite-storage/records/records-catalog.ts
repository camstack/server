/**
 * The engine's catalog of record kinds (`_record_kinds`) and the reconciler
 * that creates a kind's indexes (D881).
 *
 * This is the only code that runs DDL for `records`, and it runs when an owner
 * DECLARES its kinds - never on a write. Changes are additive: a changed index
 * is a new name, and the old one stays until the orphan job drops it. Anything
 * else is refused (D853: the engine never migrates).
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  assertValidDeclaration,
  DeclarationRefusedError,
  type DeclareKindResult,
  type RecordKindDeclaration,
  StoredRecordKindDeclarationSchema,
} from '@camstack/types'
import { indexDdl, indexName, RECORDS_SCHEMA_SQL } from './records-sql.js'

/** One kind as the engine holds it. */
export interface KindRow {
  readonly kindId: number
  readonly owner: string
  readonly kind: string
  readonly database: 'settings' | 'events'
  readonly hash: string
  readonly state: 'declared' | 'orphaned' | 'dropped'
  readonly declaration: RecordKindDeclaration
}

interface CatalogDbRow {
  readonly kind_id: number
  readonly owner: string
  readonly kind: string
  readonly database: string
  readonly manifest_hash: string
  readonly declaration: string
  readonly state: string
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The hash a declaration is known by; two spellings of the same declaration agree. */
export function declarationHash(decl: RecordKindDeclaration): string {
  return createHash('sha256').update(stableJson(decl)).digest('hex')
}

function asDatabase(value: string): 'settings' | 'events' {
  if (value === 'settings' || value === 'events') return value
  throw new Error(`records catalog: unknown database "${value}"`)
}

function asState(value: string): KindRow['state'] {
  if (value === 'declared' || value === 'orphaned' || value === 'dropped') return value
  throw new Error(`records catalog: unknown state "${value}"`)
}

function toKindRow(row: CatalogDbRow): KindRow {
  return {
    kindId: row.kind_id,
    owner: row.owner,
    kind: row.kind,
    database: asDatabase(row.database),
    hash: row.manifest_hash,
    state: asState(row.state),
    declaration: StoredRecordKindDeclarationSchema.parse(JSON.parse(row.declaration)),
  }
}

/** Create the shared tables of a file. Idempotent. */
export function ensureRecordsSchema(db: Database.Database): void {
  db.exec(RECORDS_SCHEMA_SQL)
}

/** Every kind this file's catalog holds. */
export function loadKinds(db: Database.Database): readonly KindRow[] {
  return db
    .prepare<[], CatalogDbRow>(
      'SELECT kind_id, owner, kind, database, manifest_hash, declaration, state FROM _record_kinds ORDER BY kind_id',
    )
    .all()
    .map(toKindRow)
}

interface IndexSqlRow {
  readonly name: string
  readonly sql: string | null
}

function physicalIndexSql(db: Database.Database, kindId: number, name: string): string | null {
  const row = db
    .prepare<[string], IndexSqlRow>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
    .get(indexName(kindId, name))
  return row?.sql ?? null
}

/** What a re-declaration may and may not change. Throws {@link DeclarationRefusedError}. */
function assertAdditive(prior: KindRow, next: RecordKindDeclaration): void {
  const refuse = (why: string): never => {
    throw new DeclarationRefusedError(
      `kind "${prior.kind}" of "${prior.owner}": ${why} - the engine never migrates data; a changed index is a new name`,
    )
  }
  const before = prior.declaration
  if (before.database !== next.database) refuse('the database cannot change')
  if (before.device !== next.device) refuse('"device" cannot change')
  if (before.at !== next.at) refuse('"at" cannot change')
  for (const old of before.indexes) {
    const same = next.indexes.find((i) => i.name === old.name)
    if (same === undefined) continue
    if (same.unique !== old.unique || same.fields.join(',') !== old.fields.join(',')) {
      refuse(`index "${old.name}" was declared differently before`)
    }
  }
  for (const path of before.secretPaths) {
    if (!next.secretPaths.includes(path)) refuse(`secret path "${path}" cannot stop being secret`)
  }
}

export interface DeclareOutcome {
  readonly row: KindRow
  readonly result: DeclareKindResult
}

/**
 * Reconcile one kind: insert its catalog row and create the declared indexes,
 * or confirm it is unchanged, or apply an additive change. One transaction.
 */
export function declareKind(
  db: Database.Database,
  owner: string,
  kind: string,
  declaration: RecordKindDeclaration,
  prior: KindRow | undefined,
): DeclareOutcome {
  assertValidDeclaration(kind, declaration)
  if (prior !== undefined) assertAdditive(prior, declaration)
  const hash = declarationHash(declaration)

  const run = db.transaction((): DeclareOutcome => {
    let kindId: number
    let state: DeclareKindResult['state']
    if (prior === undefined) {
      const inserted = db
        .prepare(
          "INSERT INTO _record_kinds(owner, kind, database, manifest_hash, declaration, state) VALUES (?, ?, ?, ?, ?, 'declared')",
        )
        .run(owner, kind, declaration.database, hash, JSON.stringify(declaration))
      kindId = Number(inserted.lastInsertRowid)
      state = 'created'
    } else {
      kindId = prior.kindId
      if (prior.hash === hash) {
        // The hash vouches for the declaration, not for the stored text: a row an
        // older engine wrote may carry more than was declared. The catalog holds
        // what was declared, so a differing text is rewritten, state unchanged.
        db.prepare(
          'UPDATE _record_kinds SET declaration = ? WHERE kind_id = ? AND declaration <> ?',
        ).run(JSON.stringify(declaration), kindId, JSON.stringify(declaration))
        // A declaration is proof the owner uses the kind: a kind the stale-data
        // audit flagged (or an operator dropped) is live again.
        db.prepare(
          "UPDATE _record_kinds SET state = 'declared', orphaned_at = NULL WHERE kind_id = ? AND state <> 'declared'",
        ).run(kindId)
        state = 'unchanged'
      } else {
        db.prepare(
          "UPDATE _record_kinds SET manifest_hash = ?, declaration = ?, state = 'declared', orphaned_at = NULL WHERE kind_id = ?",
        ).run(hash, JSON.stringify(declaration), kindId)
        state = 'updated'
      }
    }
    const created: string[] = []
    for (const index of declaration.indexes) {
      const ddl = indexDdl(kindId, index)
      const present = physicalIndexSql(db, kindId, index.name)
      if (present === null) {
        db.exec(ddl)
        created.push(index.name)
      } else if (present !== ddl) {
        throw new DeclarationRefusedError(
          `kind "${kind}" of "${owner}": index "${index.name}" exists with another definition - a changed index is a new name`,
        )
      }
    }
    const row: KindRow = {
      kindId,
      owner,
      kind,
      database: declaration.database,
      hash,
      state: 'declared',
      declaration,
    }
    return {
      row,
      result: { kindId, state, createdIndexes: created },
    }
  })
  return run()
}
