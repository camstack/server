/**
 * The records engine of ONE database file (D881): the operations behind
 * `ctx.records`, over the same connection the file's collections use.
 *
 * Everything here is synchronous SQLite inside a method that returns a promise,
 * so a big delete can YIELD between batches and the serving thread is not held.
 * One thread per file (D851) serialises every statement, so each op is atomic
 * and a read-modify-write goes through `ifRev`.
 *
 * Every statement is compiled with `kind_id = <literal>` first (records-sql.ts),
 * no op exists without an (owner, kind), and an owner reaches only its own
 * kinds: another addon's kind is indistinguishable from one that does not exist.
 */
import type Database from 'better-sqlite3'
import {
  type DataStoreDatabase,
  type DeclareKindResult,
  FilterRequiredError,
  InvalidRecordError,
  type IScopedLogger,
  BatchTooLargeError,
  RECORD_BATCH_MAX,
  RECORD_BATCH_MAX_BYTES,
  RECORD_DELETE_BATCH,
  type RecordInput,
  type RecordKindDeclaration,
  RecordKindDeclarationSchema,
  RecordNotFoundError,
  RecordTooLargeError,
  RecordUniqueViolationError,
  RevConflictError,
  type StorageKind,
  UnknownRecordKindError,
  DeclarationRefusedError,
  assertTransactScope,
} from '@camstack/types'
import { declareKind, ensureRecordsSchema, type KindRow, loadKinds } from './records-catalog.js'
import type {
  DropKindResult,
  KindRef,
  OwnedInput,
  RecordsEngineOps,
  RecordsOutput,
} from './records-engine-types.js'
import {
  planAggregate,
  planCount,
  planDeleteWhere,
  planHistogram,
  planQuery,
} from './records-plan.js'
import {
  enforceSecrets,
  markersOf,
  parseBody,
  type StoredRow,
  serializeBody,
  toView,
  validateHeader,
} from './records-rows.js'
import { INDEX_KIND_AT, INDEX_KIND_DEVICE_AT, indexName, kindClause } from './records-sql.js'

/** The row bounds of a kind whose retention is a ring, else null. */
function ringBounds(
  decl: RecordKindDeclaration,
): { readonly maxRows?: number; readonly maxRowsPerDevice?: number } | null {
  const { retention } = decl
  if ('maxRows' in retention || 'maxRowsPerDevice' in retention) {
    return {
      ...(retention.maxRows === undefined ? {} : { maxRows: retention.maxRows }),
      ...(retention.maxRowsPerDevice === undefined
        ? {}
        : { maxRowsPerDevice: retention.maxRowsPerDevice }),
    }
  }
  return null
}

const SLOW_STATEMENT_MS = 250
const TRIM_SLACK = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Give the event loop a turn between batches. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function keyOf(owner: string, kind: string): string {
  return `${owner}\u0000${kind}`
}

type CursorValue = string | number | null

function encodeCursor(tag: string, values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify({ t: tag, v: values }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): {
  readonly tag: string
  readonly values: readonly CursorValue[]
} {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (isRecord(parsed) && typeof parsed['t'] === 'string' && Array.isArray(parsed['v'])) {
      const values: CursorValue[] = []
      for (const item of parsed['v']) {
        if (typeof item === 'string' || typeof item === 'number' || item === null) values.push(item)
        else throw new Error('bad cursor value')
      }
      return { tag: parsed['t'], values }
    }
  } catch {
    /* falls through to the refusal below */
  }
  throw new InvalidRecordError('the cursor is not valid')
}

export interface RecordsEngineOptions {
  readonly databaseId: DataStoreDatabase
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export class RecordsEngine implements RecordsEngineOps {
  private readonly kinds = new Map<string, KindRow>()
  private readonly now: () => number
  private readonly writesSinceTrim = new Map<string, number>()

  constructor(
    private readonly db: Database.Database,
    private readonly options: RecordsEngineOptions,
  ) {
    this.now = options.now ?? Date.now
    // Inert until asked: the shared tables are created by the first declaration,
    // so a hub on which no addon declares a kind grows no table.
    this.schemaReady =
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_record_kinds'")
        .get() !== undefined
    if (this.schemaReady) {
      ensureRecordsSchema(db)
      for (const row of loadKinds(db)) this.kinds.set(keyOf(row.owner, row.kind), row)
      this.correctSequences()
    }
  }

  /**
   * Boot correction: every kind that ever allocated an id has its counter raised
   * above the highest numeric id it holds. Rows the records migration copied
   * (or any caller chosen numeric id) kept ids far above a counter that started at 1, and the
   * upsert would have overwritten another device's row on the first collision.
   * Runs on the engine's own connection, over the (kind_id, id) unique index.
   */
  private correctSequences(): void {
    const seq = this.db.prepare<[], { kind_id: number }>('SELECT kind_id FROM _record_sequences')
    for (const { kind_id: kindId } of seq.all()) {
      const top = this.db
        .prepare<[number], { m: number | null }>(
          "SELECT MAX(CAST(id AS INTEGER)) AS m FROM records WHERE kind_id = ? AND id GLOB '[0-9]*'",
        )
        .get(kindId)
      if (top?.m === null || top === undefined) continue
      const raised = this.db
        .prepare('UPDATE _record_sequences SET next = ? WHERE kind_id = ? AND next < ?')
        .run(top.m + 1, kindId, top.m + 1)
      if (raised.changes > 0) {
        this.options.logger.warn('records: id sequence raised above the highest stored id', {
          meta: { kindId, next: top.m + 1 },
        })
      }
    }
  }

  /** Ids handed out by allocateId and not yet written: their first write is insert-only. */
  private readonly pendingAllocated = new Set<string>()
  private static readonly PENDING_ALLOCATED_MAX = 4096

  /** Raise a kind's counter above the numeric ids of a caller-supplied batch. */
  private raiseSequenceFor(k: KindRow, records: readonly { readonly id: string }[]): void {
    let top = -1
    for (const r of records) {
      if (/^\d{1,15}$/.test(r.id)) top = Math.max(top, Number(r.id))
    }
    if (top < 0) return
    // An upsert, for every kind: a counter that does not exist yet starts above
    // the batch, so a later allocateId never hands out an id the batch holds.
    this.db
      .prepare(
        'INSERT INTO _record_sequences(kind_id, next) VALUES (?, ?) ' +
          'ON CONFLICT(kind_id) DO UPDATE SET next = MAX(next, excluded.next)',
      )
      .run(k.kindId, top + 1)
  }

  /** `owner\0kind` declared since this engine started — what the stale-data audit compares against. */
  private readonly declaredNow = new Set<string>()

  private schemaReady: boolean

  // ── catalog ────────────────────────────────────────────────────────────

  private kindOf(owner: string, kind: string): KindRow {
    const row = this.kinds.get(keyOf(owner, kind))
    // An orphaned kind stays usable: the audit only SUSPECTS it, and a wrong
    // suspicion must not break a running owner. Only an operator drop refuses.
    if (row === undefined || row.state === 'dropped') {
      throw new UnknownRecordKindError(`"${owner}" declared no kind "${kind}"`)
    }
    return row
  }

  async declareKinds(input: OwnedInput<'declareKinds'>): Promise<RecordsOutput<'declareKinds'>> {
    const out: Record<string, DeclareKindResult> = {}
    if (!this.schemaReady) {
      ensureRecordsSchema(this.db)
      this.schemaReady = true
    }
    for (const [kind, raw] of Object.entries(input.kinds)) {
      const declaration = RecordKindDeclarationSchema.parse(raw)
      if (declaration.database !== this.options.databaseId) {
        throw new DeclarationRefusedError(
          `kind "${kind}" is declared for "${declaration.database}" but this file is "${this.options.databaseId}"`,
        )
      }
      const prior = this.kinds.get(keyOf(input.owner, kind))
      const outcome = declareKind(this.db, input.owner, kind, declaration, prior)
      this.kinds.set(keyOf(input.owner, kind), outcome.row)
      this.declaredNow.add(keyOf(input.owner, kind))
      out[kind] = outcome.result
      if (outcome.result.state !== 'unchanged') {
        this.options.logger.info('records: kind reconciled', {
          meta: {
            owner: input.owner,
            kind,
            state: outcome.result.state,
            createdIndexes: outcome.result.createdIndexes,
          },
        })
      }
    }
    return { kinds: out }
  }

  // ── reads ──────────────────────────────────────────────────────────────

  private timed<R>(label: string, kind: string, fn: () => R): R {
    const started = performance.now()
    try {
      return fn()
    } finally {
      const ms = performance.now() - started
      if (ms >= SLOW_STATEMENT_MS) {
        this.options.logger.warn('records: slow statement', {
          meta: { op: label, kind, ms: Math.round(ms), database: this.options.databaseId },
        })
      }
    }
  }

  private static readonly ROW_SELECT =
    'SELECT rid, id, device_id AS deviceId, at, expires_at AS expiresAt, rev, updated_at AS updatedAt, json(data) AS data FROM records'

  async get(input: OwnedInput<'get'>): Promise<RecordsOutput<'get'>> {
    const k = this.kindOf(input.owner, input.kind)
    const row = this.timed('get', input.kind, () =>
      this.db
        .prepare<[string], StoredRow>(
          `${RecordsEngine.ROW_SELECT} WHERE ${kindClause(k.kindId)} AND id = ?`,
        )
        .get(input.id),
    )
    return row === undefined ? null : toView(row, k.declaration)
  }

  async getMany(input: OwnedInput<'getMany'>): Promise<RecordsOutput<'getMany'>> {
    const k = this.kindOf(input.owner, input.kind)
    const rows = this.timed('getMany', input.kind, () =>
      this.db
        .prepare<string[], StoredRow>(
          `${RecordsEngine.ROW_SELECT} WHERE ${kindClause(k.kindId)} AND id IN (${input.ids.map(() => '?').join(', ')})`,
        )
        .all(...input.ids),
    )
    return rows.map((row) => toView(row, k.declaration))
  }

  async secretRefs(input: OwnedInput<'secretRefs'>): Promise<RecordsOutput<'secretRefs'>> {
    const k = this.kindOf(input.owner, input.kind)
    const rows = this.db
      .prepare<string[], StoredRow>(
        `${RecordsEngine.ROW_SELECT} WHERE ${kindClause(k.kindId)} AND id IN (${input.ids.map(() => '?').join(', ')})`,
      )
      .all(...input.ids)
    const out: Record<string, Record<string, string>> = {}
    for (const row of rows) {
      const refs = Object.fromEntries(markersOf(k.declaration, parseBody(row.data)))
      if (Object.keys(refs).length > 0) out[row.id] = refs
    }
    return out
  }

  async query(input: OwnedInput<'query'>): Promise<RecordsOutput<'query'>> {
    const k = this.kindOf(input.owner, input.kind)
    const planned = planQuery(input.kind, k.kindId, k.declaration, {
      deviceId: input.deviceId,
      atFrom: input.atFrom,
      atTo: input.atTo,
      where: input.where,
      order: input.order,
      desc: input.desc,
      limit: input.limit,
      cursor: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
    })
    const raw = this.timed('query', input.kind, () =>
      this.db
        .prepare<unknown[], Record<string, unknown> & StoredRow>(planned.sql)
        .all(...planned.params),
    )
    const page = raw.slice(0, input.limit)
    const more = raw.length > input.limit
    const records = page.map((row) => toView(row, k.declaration))
    let nextCursor: string | null = null
    const last = page.at(-1)
    if (more && last !== undefined) {
      const keys: (string | number | null)[] = []
      for (let i = 0; i < planned.keyCount; i += 1) {
        const value = last[`_k${i}`]
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new InvalidRecordError(
            `${input.kind}: a row has no value for an ordering field, so this query cannot be paged`,
          )
        }
        keys.push(value)
      }
      keys.push(last.rid)
      nextCursor = encodeCursor(planned.tag, keys)
    }
    return { records, nextCursor }
  }

  async count(input: OwnedInput<'count'>): Promise<RecordsOutput<'count'>> {
    const k = this.kindOf(input.owner, input.kind)
    const planned = planCount(input.kind, k.kindId, k.declaration, input)
    const row = this.timed('count', input.kind, () =>
      this.db.prepare<unknown[], { n: number }>(planned.sql).get(...planned.params),
    )
    return { count: row?.n ?? 0 }
  }

  async histogram(input: OwnedInput<'histogram'>): Promise<RecordsOutput<'histogram'>> {
    const k = this.kindOf(input.owner, input.kind)
    const planned = planHistogram(input.kind, k.kindId, k.declaration, input)
    const rows = this.timed('histogram', input.kind, () =>
      this.db.prepare<unknown[], { b: number; c: number }>(planned.sql).all(...planned.params),
    )
    const from = Math.floor(input.from)
    return { buckets: rows.map((r) => ({ bucketStart: from + r.b * input.bucketMs, count: r.c })) }
  }

  async aggregate(input: OwnedInput<'aggregate'>): Promise<RecordsOutput<'aggregate'>> {
    const k = this.kindOf(input.owner, input.kind)
    const planned = planAggregate(input.kind, k.kindId, k.declaration, input)
    const rows = this.timed('aggregate', input.kind, () =>
      this.db
        .prepare<unknown[], { g: string | number | null; v: number | null }>(planned.sql)
        .all(...planned.params),
    )
    return { rows: rows.map((r) => ({ group: r.g, value: r.v })) }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  private storedRow(k: KindRow, id: string): StoredRow | undefined {
    return this.db
      .prepare<[string], StoredRow>(
        `${RecordsEngine.ROW_SELECT} WHERE ${kindClause(k.kindId)} AND id = ?`,
      )
      .get(id)
  }

  private upsertSql(kindId: number): string {
    return (
      `INSERT INTO records(kind_id, id, device_id, at, expires_at, rev, updated_at, data) ` +
      `VALUES (${kindId}, ?, ?, ?, ?, 1, ?, jsonb(?)) ` +
      `ON CONFLICT(kind_id, id) DO UPDATE SET device_id = excluded.device_id, at = excluded.at, ` +
      `expires_at = excluded.expires_at, rev = records.rev + 1, updated_at = excluded.updated_at, ` +
      `data = excluded.data RETURNING rev`
    )
  }

  private wrapWrite<R>(k: KindRow, fn: () => R): R {
    try {
      return fn()
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        err.message.includes(`rx_${k.kindId}_`)
      ) {
        const name = /rx_\d+_([a-z0-9_]+)/.exec(err.message)?.[1] ?? 'unique index'
        throw new RecordUniqueViolationError(
          `${k.kind}: the unique index "${name}" refused the write`,
        )
      }
      throw err
    }
  }

  /** One row, inside the caller's transaction. */
  private writeRecord(
    owner: string,
    k: KindRow,
    rec: RecordInput,
    ifRev: number | undefined,
    nowMs: number,
  ): { readonly rev: number; readonly releasedRefs: readonly string[] } {
    const header = validateHeader(k.kind, k.declaration, rec, nowMs)
    const allocatedKey = `${k.kindId}:${rec.id}`
    if (this.pendingAllocated.has(allocatedKey) && this.storedRow(k, rec.id) !== undefined) {
      this.options.logger.warn(
        'records: an allocated id collided with a stored row; write refused',
        {
          tags: { deviceId: rec.deviceId },
          meta: { kind: k.kind, id: rec.id },
        },
      )
      throw new RevConflictError(
        `${k.kind}/${rec.id}: an allocated id is insert-only and a row already holds it`,
      )
    }
    const needsStored = k.declaration.secretPaths.length > 0 || ifRev !== undefined
    const stored = needsStored ? this.storedRow(k, rec.id) : undefined
    if (ifRev !== undefined) {
      if (ifRev === 0 && stored !== undefined) {
        throw new RevConflictError(
          `${k.kind}/${rec.id}: the row exists (ifRev 0 means "must not exist")`,
        )
      }
      if (ifRev > 0 && stored?.rev !== ifRev) {
        throw new RevConflictError(
          `${k.kind}/${rec.id}: expected rev ${ifRev}, found ${stored === undefined ? 'no row' : `rev ${stored.rev}`}`,
        )
      }
    }
    const checked = enforceSecrets(
      owner,
      k.kind,
      k.declaration,
      rec.id,
      rec.data,
      stored === undefined ? null : parseBody(stored.data),
      'put',
    )
    const json = serializeBody(
      k.kind,
      k.declaration,
      rec.id,
      checked.body,
      (kind, bytes) =>
        this.options.logger.warn('records: a record exceeded maxDataBytes', {
          meta: { kind, bytes, max: k.declaration.maxDataBytes },
        }),
      nowMs,
    )
    const row = this.wrapWrite(k, () =>
      this.db
        .prepare<unknown[], { rev: number }>(this.upsertSql(k.kindId))
        .get(header.id, header.deviceId, header.at, header.expiresAt, nowMs, json),
    )
    if (row === undefined) throw new Error('records: the upsert returned no revision')
    this.pendingAllocated.delete(allocatedKey)
    return { rev: row.rev, releasedRefs: checked.releasedRefs }
  }

  async put(input: OwnedInput<'put'>): Promise<RecordsOutput<'put'>> {
    const k = this.kindOf(input.owner, input.kind)
    const nowMs = this.now()
    const result = this.timed('put', input.kind, () =>
      this.db.transaction(() =>
        this.writeRecord(input.owner, k, input.record, input.ifRev, nowMs),
      )(),
    )
    this.afterWrite(k, [input.record.deviceId])
    return { rev: result.rev, releasedRefs: [...result.releasedRefs] }
  }

  async putMany(input: OwnedInput<'putMany'>): Promise<RecordsOutput<'putMany'>> {
    const k = this.kindOf(input.owner, input.kind)
    if (input.records.length > RECORD_BATCH_MAX) {
      throw new BatchTooLargeError(`${input.records.length} records exceed ${RECORD_BATCH_MAX}`)
    }
    const bytes = input.records.reduce(
      (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf8'),
      0,
    )
    if (bytes > RECORD_BATCH_MAX_BYTES) {
      throw new BatchTooLargeError(`${bytes} bytes exceed ${RECORD_BATCH_MAX_BYTES}`)
    }
    const nowMs = this.now()
    const released: string[] = []
    this.timed('putMany', input.kind, () =>
      this.db.transaction(() => {
        for (const rec of input.records) {
          released.push(...this.writeRecord(input.owner, k, rec, undefined, nowMs).releasedRefs)
        }
        this.raiseSequenceFor(k, input.records)
      })(),
    )
    this.afterWrite(
      k,
      input.records.map((r) => r.deviceId),
    )
    return { count: input.records.length, releasedRefs: released }
  }

  async patch(input: OwnedInput<'patch'>): Promise<RecordsOutput<'patch'>> {
    const k = this.kindOf(input.owner, input.kind)
    const nowMs = this.now()
    return this.timed('patch', input.kind, () =>
      this.db.transaction(() => this.patchRecord(k, input, nowMs))(),
    )
  }

  /** One patch, inside the caller's transaction (shared with `transact`). */
  private patchRecord(
    k: KindRow,
    input: OwnedInput<'patch'>,
    nowMs: number,
  ): { readonly rev: number; readonly releasedRefs: string[] } {
    const decl = k.declaration
    if (input.at !== undefined && decl.at !== 'required') {
      throw new InvalidRecordError(`${input.kind}: declared at: "none"`)
    }
    if (input.at === null) throw new InvalidRecordError(`${input.kind}: "at" cannot be removed`)
    if (input.expiresAt !== undefined && decl.secretPaths.length > 0) {
      throw new InvalidRecordError(
        `${input.kind}: a kind with secret fields cannot expire by the engine (its keychain values would be orphaned)`,
      )
    }
    if (input.expiresAt !== undefined && 'ttlMs' in decl.retention) {
      throw new InvalidRecordError(`${input.kind}: expiresAt is set by the engine`)
    }
    {
      const hasSecrets = decl.secretPaths.length > 0
      const before =
        hasSecrets || input.ifRev !== undefined ? this.storedRow(k, input.id) : undefined
      const checked = enforceSecrets(
        input.owner,
        input.kind,
        decl,
        input.id,
        input.data,
        before === undefined ? null : parseBody(before.data),
        'patch',
      )
      const sets = ['data = jsonb_patch(data, ?)', 'rev = rev + 1', 'updated_at = ?']
      const params: unknown[] = [JSON.stringify(checked.body), nowMs]
      if (input.at !== undefined) {
        sets.push('at = ?')
        params.push(input.at)
      }
      if (input.expiresAt !== undefined) {
        sets.push('expires_at = ?')
        params.push(input.expiresAt)
      }
      const guard = input.ifRev === undefined ? '' : ' AND rev = ?'
      const where = [input.id, ...(input.ifRev === undefined ? [] : [input.ifRev])]
      const updated = this.wrapWrite(k, () =>
        this.db
          .prepare<unknown[], { rev: number; size: number }>(
            `UPDATE records SET ${sets.join(', ')} WHERE ${kindClause(k.kindId)} AND id = ?${guard} ` +
              `RETURNING rev, length(json(data)) AS size`,
          )
          .get(...params, ...where),
      )
      if (updated === undefined) {
        const exists = this.storedRow(k, input.id)
        if (exists === undefined) {
          throw new RecordNotFoundError(`${input.kind}/${input.id}: no such row`)
        }
        throw new RevConflictError(
          `${input.kind}/${input.id}: expected rev ${String(input.ifRev)}, found rev ${exists.rev}`,
        )
      }
      if (updated.size > decl.maxDataBytes) {
        throw new RecordTooLargeError(
          `${input.kind}/${input.id}: the patched body is ${updated.size} bytes, over maxDataBytes ${decl.maxDataBytes}`,
        )
      }
      let released: string[] = []
      if (hasSecrets && before !== undefined) {
        const after = this.storedRow(k, input.id)
        const kept = new Set(
          after === undefined ? [] : [...markersOf(decl, parseBody(after.data)).values()],
        )
        released = [...markersOf(decl, parseBody(before.data)).values()].filter(
          (ref) => !kept.has(ref),
        )
      }
      return { rev: updated.rev, releasedRefs: released }
    }
  }

  private refsOfRows(k: KindRow, rows: readonly { readonly data: string }[]): string[] {
    if (k.declaration.secretPaths.length === 0) return []
    return rows.flatMap((row) => [...markersOf(k.declaration, parseBody(row.data)).values()])
  }

  async delete(input: OwnedInput<'delete'>): Promise<RecordsOutput<'delete'>> {
    return this.deleteRecord(this.kindOf(input.owner, input.kind), input.id)
  }

  /** One delete (shared with `transact`). */
  private deleteRecord(k: KindRow, id: string): { deleted: boolean; secretRefs: string[] } {
    const hasSecrets = k.declaration.secretPaths.length > 0
    const rows = this.db
      .prepare<[string], { data: string }>(
        `DELETE FROM records WHERE ${kindClause(k.kindId)} AND id = ? RETURNING ${hasSecrets ? 'json(data)' : "'{}'"} AS data`,
      )
      .all(id)
    return { deleted: rows.length > 0, secretRefs: this.refsOfRows(k, rows) }
  }

  /**
   * Several put / patch / delete in ONE SQLite transaction. The scope rule
   * (one file, one `transactFamily`) is checked before a row moves; each op then
   * runs the very code of the single-row write, so secrets, indexes and size
   * bounds behave exactly as there. Any op throwing rolls the whole call back.
   */
  async transact(input: OwnedInput<'transact'>): Promise<RecordsOutput<'transact'>> {
    const kinds = new Map<string, KindRow>()
    for (const op of input.ops) {
      if (!kinds.has(op.kind)) kinds.set(op.kind, this.kindOf(input.owner, op.kind))
    }
    assertTransactScope(
      [...kinds.values()].map((k) => ({ kind: k.kind, declaration: k.declaration })),
    )
    const nowMs = this.now()
    const results: { rev: number | null; deleted: boolean }[] = []
    const releasedRefs: string[] = []
    const secretRefs: string[] = []
    const label = [...kinds.keys()].join('+')
    this.timed('transact', label, () =>
      this.db.transaction(() => {
        for (const op of input.ops) {
          const k = kinds.get(op.kind)
          if (k === undefined)
            throw new UnknownRecordKindError(`"${input.owner}" declared no kind "${op.kind}"`)
          if (op.op === 'put') {
            const w = this.writeRecord(input.owner, k, op.record, op.ifRev, nowMs)
            releasedRefs.push(...w.releasedRefs)
            results.push({ rev: w.rev, deleted: false })
          } else if (op.op === 'patch') {
            const w = this.patchRecord(k, { ...op, owner: input.owner }, nowMs)
            releasedRefs.push(...w.releasedRefs)
            results.push({ rev: w.rev, deleted: false })
          } else {
            const d = this.deleteRecord(k, op.id)
            secretRefs.push(...d.secretRefs)
            results.push({ rev: null, deleted: d.deleted })
          }
        }
      })(),
    )
    for (const [name, k] of kinds) {
      const devices = input.ops.flatMap((op) =>
        op.op === 'put' && op.kind === name ? [op.record.deviceId] : [],
      )
      if (devices.length > 0) this.afterWrite(k, devices)
    }
    return { results, releasedRefs, secretRefs }
  }

  async deleteMany(input: OwnedInput<'deleteMany'>): Promise<RecordsOutput<'deleteMany'>> {
    const k = this.kindOf(input.owner, input.kind)
    const hasSecrets = k.declaration.secretPaths.length > 0
    const rows = this.db
      .prepare<string[], { data: string }>(
        `DELETE FROM records WHERE ${kindClause(k.kindId)} AND id IN (${input.ids.map(() => '?').join(', ')}) RETURNING ${hasSecrets ? 'json(data)' : "'{}'"} AS data`,
      )
      .all(...input.ids)
    return { deleted: rows.length, secretRefs: this.refsOfRows(k, rows) }
  }

  /** Delete the rows `selectSql` names, in batches, yielding between them. */
  private async deleteBatched(
    k: KindRow,
    planned: { readonly sql: string; readonly params: readonly (string | number | null)[] },
  ): Promise<{ deleted: number; secretRefs: string[] }> {
    const hasSecrets = k.declaration.secretPaths.length > 0
    let deleted = 0
    const secretRefs: string[] = []
    const statement = this.db.prepare<unknown[], { data: string }>(
      `DELETE FROM records WHERE rid IN (${planned.sql}) RETURNING ${hasSecrets ? 'json(data)' : "'{}'"} AS data`,
    )
    for (;;) {
      const rows = this.timed('deleteWhere', k.kind, () => statement.all(...planned.params))
      deleted += rows.length
      secretRefs.push(...this.refsOfRows(k, rows))
      if (rows.length < RECORD_DELETE_BATCH) break
      await yieldToLoop()
    }
    return { deleted, secretRefs }
  }

  async deleteWhere(input: OwnedInput<'deleteWhere'>): Promise<RecordsOutput<'deleteWhere'>> {
    const k = this.kindOf(input.owner, input.kind)
    if (
      input.deviceId === undefined &&
      input.atBefore === undefined &&
      (input.where === undefined || Object.keys(input.where).length === 0)
    ) {
      throw new FilterRequiredError(
        `${input.kind}: deleteWhere needs deviceId, atBefore or where - there is no "delete all"`,
      )
    }
    const planned = planDeleteWhere(input.kind, k.kindId, k.declaration, input, RECORD_DELETE_BATCH)
    return this.deleteBatched(k, planned)
  }

  async deleteDevice(input: OwnedInput<'deleteDevice'>): Promise<RecordsOutput<'deleteDevice'>> {
    const deleted: Record<string, number> = {}
    const secretRefs: string[] = []
    for (const k of this.kinds.values()) {
      if (k.owner !== input.owner || k.state !== 'declared') continue
      if (k.declaration.deviceRemoval !== 'delete') continue
      if (input.kinds !== undefined && !input.kinds.includes(k.kind)) continue
      const planned = planDeleteWhere(
        k.kind,
        k.kindId,
        k.declaration,
        { deviceId: input.deviceId },
        RECORD_DELETE_BATCH,
      )
      const result = await this.deleteBatched(k, planned)
      deleted[k.kind] = result.deleted
      secretRefs.push(...result.secretRefs)
    }
    return { deleted, secretRefs }
  }

  async allocateId(input: OwnedInput<'allocateId'>): Promise<RecordsOutput<'allocateId'>> {
    const k = this.kindOf(input.owner, input.kind)
    const row = this.db
      .prepare<[number], { id: number }>(
        'INSERT INTO _record_sequences(kind_id, next) VALUES (?, 2) ' +
          'ON CONFLICT(kind_id) DO UPDATE SET next = next + 1 RETURNING next - 1 AS id',
      )
      .get(k.kindId)
    if (row === undefined) throw new Error('records: the sequence returned no id')
    this.pendingAllocated.add(`${k.kindId}:${row.id}`)
    if (this.pendingAllocated.size > RecordsEngine.PENDING_ALLOCATED_MAX) {
      const oldest = this.pendingAllocated.values().next()
      if (oldest.done !== true) this.pendingAllocated.delete(oldest.value)
    }
    return { id: row.id }
  }

  // ── retention ──────────────────────────────────────────────────────────

  /**
   * Trim a ring after a write. Counting a big ring on every write would be the
   * cost the bound exists to avoid, so a ring of more than TRIM_SLACK rows is
   * trimmed once per (bound / TRIM_SLACK) writes: the bound holds within 1 %.
   */
  private afterWrite(k: KindRow, devices: readonly (number | undefined)[]): void {
    const bounds = ringBounds(k.declaration)
    if (bounds === null) return
    const bound = Math.max(bounds.maxRows ?? 0, bounds.maxRowsPerDevice ?? 0)
    const interval = bound <= TRIM_SLACK ? 1 : Math.floor(bound / TRIM_SLACK)
    const count = (this.writesSinceTrim.get(String(k.kindId)) ?? 0) + devices.length
    if (count < interval) {
      this.writesSinceTrim.set(String(k.kindId), count)
      return
    }
    this.writesSinceTrim.set(String(k.kindId), 0)
    if (bounds.maxRows !== undefined) this.trimScope(k, bounds.maxRows, undefined)
    if (bounds.maxRowsPerDevice !== undefined) {
      const seen = new Set(devices.filter((d): d is number => d !== undefined))
      for (const device of seen) this.trimScope(k, bounds.maxRowsPerDevice, device)
    }
  }

  private trimScope(k: KindRow, max: number, deviceId: number | undefined): void {
    const index = deviceId === undefined ? INDEX_KIND_AT : INDEX_KIND_DEVICE_AT
    const where = deviceId === undefined ? '' : ' AND device_id = ?'
    const params = deviceId === undefined ? [] : [deviceId]
    const total =
      this.db
        .prepare<unknown[], { n: number }>(
          `SELECT COUNT(*) AS n FROM records INDEXED BY ${index} WHERE ${kindClause(k.kindId)}${where}`,
        )
        .get(...params)?.n ?? 0
    // Bounded: one trigger removes at most one batch, so a huge backlog never holds the serving
    // thread; the next trigger takes the rest.
    const excess = Math.min(total - max, RECORD_DELETE_BATCH)
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM records WHERE rid IN (SELECT rid FROM records INDEXED BY ${index} WHERE ${kindClause(k.kindId)}${where} ORDER BY at, rid LIMIT ${excess})`,
      )
      .run(...params)
  }

  async sweepExpired(input: { readonly batch?: number }): Promise<{ readonly deleted: number }> {
    if (!this.schemaReady) return { deleted: 0 }
    const batch = input.batch ?? RECORD_DELETE_BATCH
    const statement = this.db.prepare(
      `DELETE FROM records WHERE rid IN (SELECT rid FROM records INDEXED BY records_expires WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ${batch})`,
    )
    let deleted = 0
    for (;;) {
      const changes = statement.run(this.now()).changes
      deleted += changes
      if (changes < batch) break
      await yieldToLoop()
    }
    return { deleted }
  }

  // ── admin ──────────────────────────────────────────────────────────────

  async listKinds(input: {
    readonly owner?: string | undefined
    readonly counts?: boolean | undefined
  }): Promise<readonly StorageKind[]> {
    const out: StorageKind[] = []
    for (const k of this.kinds.values()) {
      if (input.owner !== undefined && k.owner !== input.owner) continue
      const counted = input.counts !== false
      const rows = counted ? this.countRows(k) : null
      let bytesEstimate: number | null = null
      if (rows !== null && rows > 0) {
        const avg = this.db
          .prepare<[], { avg: number | null }>(
            `SELECT AVG(s) AS avg FROM (SELECT length(data) AS s FROM records INDEXED BY ${INDEX_KIND_AT} WHERE ${kindClause(k.kindId)} LIMIT 100)`,
          )
          .get()?.avg
        bytesEstimate = avg === null || avg === undefined ? null : Math.round(avg * rows)
      }
      out.push({
        owner: k.owner,
        kind: k.kind,
        database: k.database,
        class: k.declaration.class,
        state: k.state,
        declaredThisBoot: this.declaredNow.has(keyOf(k.owner, k.kind)),
        rows,
        bytesEstimate,
        writeTrigger: k.declaration.writeTrigger,
        retention: k.declaration.retention,
        entry: k.declaration.entry !== undefined,
        declaration: k.declaration,
      })
    }
    return out
  }

  /** Flag kinds the audit found unused. Only a `declared` kind moves; the rest keep their state. */
  async markKindsOrphaned(input: {
    readonly kinds: readonly KindRef[]
  }): Promise<{ readonly marked: number }> {
    let marked = 0
    const stamp = this.db.prepare(
      "UPDATE _record_kinds SET state = 'orphaned', orphaned_at = ? WHERE kind_id = ? AND state = 'declared'",
    )
    for (const target of input.kinds) {
      const row = this.kinds.get(keyOf(target.owner, target.kind))
      if (row === undefined || row.state !== 'declared') continue
      if (this.declaredNow.has(keyOf(target.owner, target.kind))) continue
      stamp.run(this.now(), row.kindId)
      this.kinds.set(keyOf(target.owner, target.kind), { ...row, state: 'orphaned' })
      marked += 1
    }
    return { marked }
  }

  /**
   * Operator drop of an ORPHANED kind: its rows, its indexes and its sequence go,
   * the catalog row stays as `dropped` (a later declaration revives it). Refuses
   * a kind that is not orphaned or that an owner declared this boot.
   */
  async dropKind(input: KindRef): Promise<DropKindResult> {
    const k = this.kinds.get(keyOf(input.owner, input.kind))
    if (k === undefined || k.state !== 'orphaned') {
      throw new UnknownRecordKindError(`"${input.owner}" kind "${input.kind}" is not orphaned`)
    }
    if (this.declaredNow.has(keyOf(input.owner, input.kind))) {
      throw new UnknownRecordKindError(`"${input.owner}" declared "${input.kind}" this boot`)
    }
    const planned = {
      sql: `SELECT rid FROM records INDEXED BY ${INDEX_KIND_AT} WHERE ${kindClause(k.kindId)} LIMIT ${RECORD_DELETE_BATCH}`,
      params: [],
    }
    const result = await this.deleteBatched(k, planned)
    this.db.transaction(() => {
      for (const index of k.declaration.indexes) {
        this.db.exec(`DROP INDEX IF EXISTS "${indexName(k.kindId, index.name)}"`)
      }
      this.db.prepare('DELETE FROM _record_sequences WHERE kind_id = ?').run(k.kindId)
      this.db.prepare("UPDATE _record_kinds SET state = 'dropped' WHERE kind_id = ?").run(k.kindId)
    })()
    this.kinds.set(keyOf(input.owner, input.kind), { ...k, state: 'dropped' })
    this.options.logger.info('records: kind dropped', {
      meta: { owner: input.owner, kind: input.kind, deleted: result.deleted },
    })
    return result
  }

  private countRows(k: KindRow): number {
    return (
      this.db
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM records INDEXED BY ${INDEX_KIND_AT} WHERE ${kindClause(k.kindId)}`,
        )
        .get()?.n ?? 0
    )
  }

  /** The declarations this file holds, for the router's placement map and the entries service. */
  declarations(): readonly KindRow[] {
    return [...this.kinds.values()]
  }
}
