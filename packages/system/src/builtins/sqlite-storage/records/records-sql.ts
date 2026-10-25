/**
 * The SQL of `records` (D881): the schema, and the ONE function that renders a
 * record field as an expression.
 *
 * ## One renderer for the index and the predicate
 *
 * SQLite uses an expression index only when the query's expression matches the
 * indexed one CHARACTER FOR CHARACTER; a mismatch is silently a full scan. The
 * backend's own comment on `share_view_tokens` records that failure once. So
 * the partial indexes, the `where` predicates, the ordering and the aggregates
 * are ALL rendered by {@link recordFieldExpr}, which calls the engine's
 * existing `fieldExprFor` (the same function the KV collections use). There is
 * no second spelling to drift.
 *
 * ## `kind_id` is a LITERAL
 *
 * A partial index `... WHERE kind_id = 17` is usable only when the planner can
 * PROVE the query's `kind_id` equals 17, so every statement carries
 * `kind_id = <integer>` as text, never as a bound parameter. The integer comes
 * from the engine's own catalog and is re-checked here, so this is not an
 * injection surface. {@link kindClause} is the only place it is spelled.
 */
import { fieldExprFor } from '../filter-compiler.js'

/**
 * @durable class=ledger owner=records
 *   write="every ctx.records write of an owning addon: one row per record of any declared kind, keyed (kind_id, id)"
 *   retention="per kind, declared with the kind: an engine ttl, a row bound, the owner's own sweep, or none - the reason is shown in System -> Data"
 */
export const RECORDS_TABLE = 'records'

/**
 * @durable class=config owner=records
 *   write="an owner declares its kinds when its addon boots (declareKinds): one row per (owner, kind)"
 *   retention="none - a kind row is never removed by this release; a kind no installed package declares is only marked orphaned"
 */
export const RECORD_KINDS_TABLE = '_record_kinds'

/**
 * @durable class=config owner=records
 *   write="allocateId on a kind: one counter row per kind"
 *   retention="none - the counter must never go back, so it is never pruned"
 */
export const RECORD_SEQUENCES_TABLE = '_record_sequences'

/** The statements that create the shared tables. Idempotent. */
export const RECORDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  rid        INTEGER PRIMARY KEY,
  kind_id    INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  device_id  INTEGER,
  at         INTEGER,
  expires_at INTEGER,
  rev        INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  data       BLOB    NOT NULL,
  UNIQUE (kind_id, id)
);
CREATE INDEX IF NOT EXISTS records_kind_device_at ON records(kind_id, device_id, at);
CREATE INDEX IF NOT EXISTS records_kind_at ON records(kind_id, at);
CREATE INDEX IF NOT EXISTS records_expires ON records(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS _record_kinds (
  kind_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  database      TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  declaration   TEXT NOT NULL,
  state         TEXT NOT NULL,
  orphaned_at   INTEGER,
  -- RETIRED (D900): the records-migration boot guard's flag. Nothing reads it;
  -- the column stays so an older build can still open a file this one created.
  adopted_at    INTEGER,
  UNIQUE (owner, kind)
);
CREATE TABLE IF NOT EXISTS _record_sequences (
  kind_id INTEGER PRIMARY KEY,
  next    INTEGER NOT NULL
);
`

/** The built-in indexes. */
export const INDEX_KIND_DEVICE_AT = 'records_kind_device_at'
export const INDEX_KIND_AT = 'records_kind_at'
export const INDEX_EXPIRES = 'records_expires'

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/

/** What `fieldExprFor` resolves a record field against: the `data` blob and nothing else. */
const RECORD_SHAPE = {
  primaryKey: 'id',
  columns: new Set<string>(),
  kvBlobColumn: 'data',
} as const

/**
 * The expression of a record field: `json_extract("data", '$.a.b')`. THE one
 * renderer. Throws on a path outside the safe charset (it lands in DDL).
 */
export function recordFieldExpr(field: string): string {
  if (!FIELD_PATH.test(field)) throw new Error(`records: "${field}" is not a field path`)
  const expr = fieldExprFor(field, RECORD_SHAPE)
  if (expr === null) throw new Error(`records: "${field}" cannot be expressed`)
  return expr
}

/** `kind_id = 17` as text; the argument must be a safe integer from the catalog. */
export function kindClause(kindId: number): string {
  if (!Number.isSafeInteger(kindId) || kindId < 1) {
    throw new Error(`records: ${String(kindId)} is not a kind id`)
  }
  return `kind_id = ${kindId}`
}

/** The physical name of a declared index. */
export function indexName(kindId: number, name: string): string {
  return `rx_${kindId}_${name}`
}

/** The exact DDL of one declared index. Compared character for character when it already exists. */
export function indexDdl(
  kindId: number,
  index: {
    readonly name: string
    readonly fields: readonly string[]
    readonly unique?: boolean | undefined
  },
): string {
  const unique = index.unique === true ? 'UNIQUE ' : ''
  const exprs = index.fields.map(recordFieldExpr).join(', ')
  return `CREATE ${unique}INDEX "${indexName(kindId, index.name)}" ON records(${exprs}) WHERE ${kindClause(kindId)}`
}
