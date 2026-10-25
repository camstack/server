/**
 * Which collection IS the database.
 *
 * ## Why this exists
 *
 * The boot line already says how big the file is (`dbSizeMb`) and how much of
 * it is real (`freePct`). Measured on the live hub 2026-08-25 those read
 * `dbSizeMb=858 liveMb=840 freeMb=18 freePct=2` — so the growth from 153 MB
 * (08-08) is not a high-water mark waiting for a VACUUM, it is live rows. That
 * turned "should we VACUUM" into "which table", and nothing in this system
 * could answer it.
 *
 * Nothing could, structurally: per-addon scoped collections
 * (`<addonId>:<canonical>`) are created on the first write and declared in no
 * source file, so the real set only exists on the running node. A reference
 * page cannot list them and a grep cannot find them.
 *
 * ## Why `dbstat` and not `COUNT(*)`
 *
 * `dbstat` reports the pages a table actually occupies, which is the question —
 * a table with few enormous rows and a table with many small ones are the same
 * problem when the file is the thing that grew. It walks the b-tree structure
 * without decoding row payloads, so it costs a page traversal rather than a
 * full table scan. It is still real work on an 840 MB file, which is why the
 * caller runs it ONCE, well after boot, off the critical path — never on the
 * path a config read waits behind.
 */

/** What kind of object a `dbstat` group is. An index is an object too. */
export type SqliteObjectKind = 'table' | 'index' | 'unknown'

/** One `dbstat` group: an object and the space it occupies. */
export interface TableSizeRow {
  readonly name: string
  /**
   * `sqlite_master.tbl_name` — for a table this IS the table, for an index it
   * is the table the index belongs to. Ownership is read from the relation
   * SQLite already stores; an index name carries none (`idx_b_outbox` only
   * looks parseable, and `sqlite_autoindex_a:media_1` would parse to nonsense).
   */
  readonly tableName: string
  readonly bytes: number
  readonly pages: number
  readonly kind: SqliteObjectKind
}

/** One line of the report. */
export interface TableSizeEntry {
  readonly name: string
  readonly sizeMb: number
  readonly pages: number
  /** Share of the whole file, percent. 0 when the file size is unknown. */
  readonly pct: number
  readonly kind: SqliteObjectKind
}

/** Everything one addon prefix owns, tables and their indexes together. */
export interface OwnerRollup {
  readonly owner: string
  readonly sizeMb: number
  readonly objects: number
}

export interface TableSizeReport {
  readonly tables: readonly TableSizeEntry[]
  /** Megabytes held by everything below the cut. */
  readonly otherMb: number
  /** How many OBJECTS are behind `otherMb` — tables and indexes alike. */
  readonly otherObjects: number
  readonly tableCount: number
  readonly indexCount: number
  /** Every owner, biggest first. */
  readonly byOwner: readonly OwnerRollup[]
}

/** The label for anything that is not a per-addon scoped collection. */
export const UNSCOPED_OWNER = '(unscoped)'

function ownerOf(tableName: string): string {
  const colon = tableName.indexOf(':')
  return colon > 0 ? tableName.slice(0, colon) : UNSCOPED_OWNER
}

/**
 * Rank tables by the space they hold and keep the top `limit`.
 *
 * The tail is REPORTED, never dropped: a top-N that silently discards the rest
 * reads as "these N are the database", which is exactly the wrong conclusion
 * when the remainder is a third of the file.
 */
export function summariseTableSizes(
  rows: readonly TableSizeRow[],
  totalBytes: number,
  limit: number,
): TableSizeReport {
  const sorted = [...rows].sort((a, b) => b.bytes - a.bytes)
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)

  const owners = new Map<string, { bytes: number; objects: number }>()
  for (const row of rows) {
    const owner = ownerOf(row.tableName)
    const seen = owners.get(owner) ?? { bytes: 0, objects: 0 }
    owners.set(owner, { bytes: seen.bytes + row.bytes, objects: seen.objects + 1 })
  }

  return {
    tables: head.map((row) => ({
      name: row.name,
      sizeMb: Math.round(row.bytes / 1_048_576),
      pages: row.pages,
      pct: totalBytes > 0 ? Math.round((row.bytes / totalBytes) * 100) : 0,
      kind: row.kind,
    })),
    otherMb: Math.round(tail.reduce((sum, row) => sum + row.bytes, 0) / 1_048_576),
    otherObjects: tail.length,
    tableCount: rows.filter((row) => row.kind === 'table').length,
    indexCount: rows.filter((row) => row.kind === 'index').length,
    byOwner: [...owners.entries()]
      .map(([owner, agg]) => ({
        owner,
        sizeMb: Math.round(agg.bytes / 1_048_576),
        objects: agg.objects,
      }))
      .sort((a, b) => b.sizeMb - a.sizeMb),
  }
}

/**
 * How long after opening the connection the report runs.
 *
 * Not zero and not "on every boot forever at startup": boot is already the
 * busiest window this engine sees (`ensureTable` x9, the retired-key purge, the
 * vector registry), and a page traversal of an 840 MB file placed there would
 * be indistinguishable from the stall this whole subsystem was just fixed for.
 * Sixty seconds puts it after the storm, once per process.
 */
export const STORAGE_REPORT_DELAY_MS = 60_000

/** Top-N tables named individually; the remainder is reported as a tail. */
export const STORAGE_REPORT_TOP_N = 10

/** Owners named individually in the log line. */
export const STORAGE_REPORT_TOP_OWNERS = 15

/** `dbstat` shape, narrowed without a cast. */
export function toTableSizeRow(value: unknown): TableSizeRow | null {
  if (typeof value !== 'object' || value === null) return null
  const row: Record<string, unknown> = { ...value }
  const { name, tableName, bytes, pages, kind } = row
  if (typeof name !== 'string') return null
  if (typeof bytes !== 'number' || typeof pages !== 'number') return null
  return {
    name,
    // A LEFT JOIN that found nothing leaves the object standing alone rather
    // than silently attributing it to an owner nobody verified.
    tableName: typeof tableName === 'string' && tableName !== '' ? tableName : name,
    bytes,
    pages,
    kind: kind === 'table' || kind === 'index' ? kind : 'unknown',
  }
}
