/**
 * `RowMapStore` — a `Record<key, T>` settings blob, stored as ONE ROW PER
 * ENTRY.
 *
 * ## What this replaces, and what it cost
 *
 * A forked addon's `ctx.settings` is `readBlob/mergeBlob('addon-settings',
 * 'root', <addonId>)` — ONE row holding every top-level key the addon has ever
 * persisted, including the operator's config fields. `BaseAddon.state(key, …)`
 * hands out a `DurableState` over one of those keys, and every `get()` parses
 * that whole row while every `set()` rewrites it.
 *
 * On the reference hub that row was 201 833 bytes for the recorder and 33 155
 * for the stream-broker. The recorder's export engine patches `progressPct`
 * about once a second for an in-flight render: 201 KB read, parsed, re-
 * serialised and rewritten, per second, to move one integer. The staging walk
 * paid the same toll per DEVICE until it was taught to read the map once —
 * 267 s of a boot, measured 2026-08-18. This primitive removes the cause rather
 * than the symptom.
 *
 * ## The shape
 *
 * `<key TEXT PRIMARY KEY>` + the columns the owner PROJECTS out of the value
 * (so a per-device question is an indexed `where`, not a scan) + `value JSON`
 * holding the validated payload verbatim.
 *
 * The payload column is deliberately named `value`, never `data`: a declared
 * collection whose ONLY non-PK column is `data` is the settings engine's
 * KV-blob shape, and it would silently stop destructuring the projected
 * columns.
 *
 * ## Failure direction: an entry, never the map
 *
 * The blob failed WHOLE — one unparseable device took `RecordingConfigsBlob`
 * to its empty fallback, and every camera read as unconfigured. A row fails
 * ALONE: `readAll` skips it (loudly, once, with a count), `read` answers
 * `null`. That is strictly better than the thing it replaces and it is the
 * reason the schema is applied per row rather than per map.
 *
 * ## What this is NOT
 *
 * Not a {@link DurableLedger}. That primitive exists for a value a DECISION is
 * gated on, so it mirrors into RAM and never lets a fallible read change a
 * verdict. These maps are read on demand by their owner and a keyed read is
 * already one row; adding a mirror would add a staleness surface for nothing.
 * When a value gates work, use the ledger.
 */

import type {
  CollectionColumn,
  CollectionIndex,
  IScopedLogger,
  SettingsStoreClient,
} from '@camstack/types'
import type { ZodType } from 'zod'

/**
 * The primary-key column every row map declares, and the column holding the
 * validated payload.
 *
 * `id` + `value` is not a new convention: it is exactly `NC_META_COLUMNS`
 * (`notification-center:meta`), and `id` is the PK of every live declared
 * collection in the repo (`notification-center:outbox`,
 * `pipeline-analytics:faces`, `device-manager:devices`).
 */
export const ROW_MAP_ID_COLUMN = 'id'
export const ROW_MAP_VALUE_COLUMN = 'value'

/** Everything the primitive needs to own one collection on a feature's behalf. */
export interface RowMapSpec<T> {
  /** The declared collection name. Must carry a `@durable` annotation. */
  readonly collection: string
  /** Validates one entry on read and on write. */
  readonly schema: ZodType<T>
  /**
   * The columns projected OUT of the value, for the questions the owner asks
   * with a `where`. The key and payload columns are added by the store.
   */
  readonly columns: readonly CollectionColumn[]
  readonly indexes?: readonly CollectionIndex[]
  /**
   * Produce every projected column for one entry. Must return all of them —
   * SQLite evaluates `NOT NULL` on the INSERT attempt, BEFORE the upsert
   * clause intercepts the key conflict, so a partial write cannot insert.
   */
  readonly project: (key: string, value: T) => Record<string, unknown>
  /**
   * Which projected column carries the numeric deviceId, when a row is about
   * one device.
   *
   * Read off the COLUMN and not off the parsed value on purpose: the line that
   * most needs the tag is the one reporting a value that would not parse. Every
   * log line about a device carries `tags: { deviceId }` — a media gap is
   * always asked per-camera.
   */
  readonly deviceIdColumn?: string
  /**
   * Explicit cap on the whole-map read. `settings-store.query` imposes a SILENT
   * 2 000-row default when a caller passes none, so the owner names its own
   * ceiling and a read that reaches it is reported rather than shrunk.
   */
  readonly loadLimit: number
}

export interface RowMapStoreDeps<T> {
  readonly spec: RowMapSpec<T>
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
}

/** The `tags` fragment for a row, empty when the row is not about a device. */
type DeviceTags = { readonly tags: { readonly deviceId: number } } | Record<string, never>

/** One entry as the store returns it: its key and its validated value. */
export interface RowMapEntry<T> {
  readonly key: string
  readonly value: T
}

/** Ordering for {@link RowMapStore.readWhere}. */
export interface RowMapOrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

/** The predicate half of a filter — projected columns only. */
export interface RowMapMutation {
  readonly where?: Record<string, unknown>
  readonly whereIn?: Record<string, unknown[]>
  readonly whereBetween?: Record<string, [unknown, unknown]>
}

/** A bounded, ordered read over projected columns. */
export interface RowMapQuery extends RowMapMutation {
  readonly orderBy?: RowMapOrderBy
  readonly limit?: number
  readonly offset?: number
}

export class RowMapStore<T> {
  private readonly spec: RowMapSpec<T>
  private readonly store: SettingsStoreClient
  private readonly logger: IScopedLogger

  constructor(deps: RowMapStoreDeps<T>) {
    this.spec = deps.spec
    this.store = deps.store
    this.logger = deps.logger
  }

  /** The collection this store owns — for the caller's own log lines. */
  get collection(): string {
    return this.spec.collection
  }

  /**
   * Register the collection. MUST run at boot, before any read or write: the
   * SQLite backend answers 412 for an undeclared collection.
   */
  static declare<T>(store: SettingsStoreClient, spec: RowMapSpec<T>): Promise<void> {
    return store.declareCollection.mutate({
      collection: spec.collection,
      columns: [
        { name: ROW_MAP_ID_COLUMN, type: 'TEXT', primaryKey: true, notNull: true },
        ...spec.columns,
        { name: ROW_MAP_VALUE_COLUMN, type: 'JSON', notNull: true },
      ],
      ...(spec.indexes !== undefined ? { indexes: [...spec.indexes] } : {}),
    })
  }

  declare(): Promise<void> {
    return RowMapStore.declare(this.store, this.spec)
  }

  /** One entry, by key. `null` when absent OR unparseable (which is said aloud). */
  async read(key: string): Promise<T | null> {
    const raw = await this.store.get.query({ collection: this.spec.collection, key })
    if (!isRecord(raw)) return null
    const row = raw
    const parsed = this.spec.schema.safeParse(row[ROW_MAP_VALUE_COLUMN])
    if (!parsed.success) {
      this.logger.warn('row-map row skipped as unparseable', {
        ...this.deviceTags(row),
        meta: { collection: this.spec.collection, key, error: parsed.error.message },
      })
      return null
    }
    return parsed.data
  }

  /**
   * Every entry, keyed. Unparseable rows are skipped — one bad entry costs that
   * entry, never the map.
   */
  async readAll(): Promise<Map<string, T>> {
    const records = await this.store.query.query({
      collection: this.spec.collection,
      filter: { limit: this.spec.loadLimit },
    })
    const out = new Map<string, T>()
    let skipped = 0
    for (const record of records) {
      const parsed = this.spec.schema.safeParse(record.data[ROW_MAP_VALUE_COLUMN])
      if (!parsed.success) {
        skipped += 1
        continue
      }
      out.set(record.id, parsed.data)
    }
    if (skipped > 0) {
      this.logger.warn('row-map rows skipped as unparseable', {
        meta: { collection: this.spec.collection, skipped, kept: out.size },
      })
    }
    if (records.length >= this.spec.loadLimit) {
      // The caller is about to act as if it read everything. A retention sweep
      // that sees 5 000 of 40 000 rows deletes 5 000 and reports success.
      this.logger.warn('row-map read hit its own bound — the map may be truncated', {
        meta: { collection: this.spec.collection, loadLimit: this.spec.loadLimit },
      })
    }
    return out
  }

  /**
   * Every entry as it was WRITTEN, unvalidated and unparsed — the read a
   * MIGRATION needs.
   *
   * {@link readAll} answers through the CURRENT schema, which is exactly what a
   * migration must not do: a retired key is stripped by a non-strict `z.object`
   * before the migration could see it, so the row it is there to rescue looks
   * like a row that never needed rescuing. Only a migration should call this;
   * everything else wants the validated read.
   */
  async readAllRaw(): Promise<Map<string, unknown>> {
    const records = await this.store.query.query({
      collection: this.spec.collection,
      filter: { limit: this.spec.loadLimit },
    })
    const out = new Map<string, unknown>()
    for (const record of records) out.set(record.id, record.data[ROW_MAP_VALUE_COLUMN])
    return out
  }

  /** Insert or replace ONE entry. Validates at the boundary. */
  async write(key: string, value: T): Promise<void> {
    const validated = this.spec.schema.parse(value)
    const columns = this.spec.project(key, validated)
    await this.store.set.mutate({
      collection: this.spec.collection,
      key,
      value: { ...columns, [ROW_MAP_VALUE_COLUMN]: validated },
    })
  }

  /** Drop ONE entry. Idempotent. */
  async remove(key: string): Promise<void> {
    await this.store.delete.mutate({ collection: this.spec.collection, key })
  }

  /**
   * Make the collection hold exactly `next` — the write path for an owner whose
   * in-memory map IS the authority (a persister handed the complete set).
   *
   * Returns how many rows were DELETED, and says so out loud when any were: a
   * replace that silently drops rows is indistinguishable from one that never
   * had them. Only an owner holding an authoritative set may call this — a
   * prune driven by a fallible read is work destroyed (D130, D49).
   */
  async replaceAll(next: ReadonlyMap<string, T>): Promise<number> {
    const held = await this.store.query.query({
      collection: this.spec.collection,
      filter: { limit: this.spec.loadLimit },
    })
    for (const [key, value] of next) await this.write(key, value)
    const doomed = held.filter((record) => !next.has(record.id))
    for (const record of doomed) await this.remove(record.id)
    if (doomed.length > 0) {
      this.logger.warn('row-map replaceAll dropped rows', {
        meta: {
          collection: this.spec.collection,
          dropped: doomed.length,
          keys: doomed.slice(0, 20).map((r) => r.id),
          remaining: next.size,
        },
      })
    }
    return doomed.length
  }

  /**
   * The entries matching a projected-column predicate, in the order asked for.
   *
   * This is what projecting columns BUYS: "every export for camera 102, newest
   * first, capped at 50" is an indexed `WHERE` + `ORDER BY` + `LIMIT`, not a
   * parse of the whole map followed by a filter in JS.
   *
   * A `limit` is REQUIRED — `settings-store.query` silently caps an unbounded
   * read at 2 000 rows and answers as if that were everything.
   */
  async readWhere(filter: RowMapQuery): Promise<readonly RowMapEntry<T>[]> {
    const records = await this.store.query.query({
      collection: this.spec.collection,
      filter: {
        ...(filter.where !== undefined ? { where: filter.where } : {}),
        ...(filter.whereIn !== undefined ? { whereIn: filter.whereIn } : {}),
        ...(filter.whereBetween !== undefined ? { whereBetween: filter.whereBetween } : {}),
        ...(filter.orderBy !== undefined ? { orderBy: filter.orderBy } : {}),
        ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
        limit: filter.limit ?? this.spec.loadLimit,
      },
    })
    const out: RowMapEntry<T>[] = []
    let skipped = 0
    for (const record of records) {
      const parsed = this.spec.schema.safeParse(record.data[ROW_MAP_VALUE_COLUMN])
      if (!parsed.success) {
        skipped += 1
        continue
      }
      out.push({ key: record.id, value: parsed.data })
    }
    if (skipped > 0) {
      this.logger.warn('row-map rows skipped as unparseable', {
        meta: { collection: this.spec.collection, skipped, kept: out.length },
      })
    }
    return out
  }

  /** How many rows match, without materialising one. */
  async count(filter?: RowMapQuery): Promise<number> {
    return this.store.count.query({
      collection: this.spec.collection,
      ...(filter !== undefined
        ? {
            filter: {
              ...(filter.where !== undefined ? { where: filter.where } : {}),
              ...(filter.whereIn !== undefined ? { whereIn: filter.whereIn } : {}),
              ...(filter.whereBetween !== undefined ? { whereBetween: filter.whereBetween } : {}),
            },
          }
        : {}),
    })
  }

  /**
   * Delete every row matching a predicate, in ONE statement. Returns how many
   * went, and says so — a retention trim that silently drops rows is
   * indistinguishable from one that had nothing to do.
   *
   * The predicate is REQUIRED and the engine REFUSES one that compiles to
   * nothing: deleting a whole collection is a legitimate intent, but it must be
   * asked for by name rather than reached through an empty object.
   */
  async deleteWhere(filter: RowMapMutation): Promise<number> {
    const { deleted } = await this.store.deleteWhere.mutate({
      collection: this.spec.collection,
      filter,
    })
    if (deleted > 0) {
      this.logger.warn('row-map deleteWhere dropped rows', {
        meta: { collection: this.spec.collection, deleted, filter },
      })
    }
    return deleted
  }

  /** `tags: { deviceId }` off the PROJECTED column, when the spec names one. */
  private deviceTags(row: Readonly<Record<string, unknown>>): DeviceTags {
    const column = this.spec.deviceIdColumn
    if (column === undefined) return {}
    const raw = row[column]
    return typeof raw === 'number' && Number.isInteger(raw) ? { tags: { deviceId: raw } } : {}
  }
}

/** A store payload that is a plain object, or `null`. A type guard, not a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
