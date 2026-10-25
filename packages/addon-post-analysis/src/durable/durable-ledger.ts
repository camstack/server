/**
 * `DurableLedger` — the one mechanism behind "remember a value across a
 * restart", extracted from `notification-center/liveness-ledger.ts` (D130).
 *
 * ## Why this exists
 *
 * The 2026-08-13 census (`docs/design/2026-08-13-durable-value-tracking-and-
 * runtime-state.md`) counted **five** stores in this repo that had each written
 * the same 120 lines: declare a collection, mirror it into RAM, reseed at boot,
 * write behind the decision, choose a failure direction. Five copies is five
 * chances to choose the direction wrong — and two of them had already been
 * chosen wrong in the same week (the occupancy cold baseline, the liveness
 * flood). A sixth copy was being written at the time of the extraction.
 *
 * What is shared here is MECHANICS ONLY. What a value MEANS — whether a repeat
 * is a duplicate or a change, which keys are still active, when a row may be
 * dropped — stays with the feature that owns it. That is the same split D3
 * applies to capability registration and D62 to per-camera switches, and it is
 * the only shape that survives this repo's history of a second authority
 * disagreeing with the first.
 *
 * ## The contract, stated once
 *
 * 1. **The MIRROR is the read surface. The store is never on a decision path.**
 *    Every read (`get`, `snapshot`, `size`) answers from RAM. A gate that
 *    consulted SQLite would be a gate that fails when SQLite is slow, which is
 *    D49's whole subject.
 * 2. **A failed load NEVER clears the mirror.** There is deliberately no knob
 *    for this: dropping remembered state on a transient read error is precisely
 *    what produced the notification flood, so no code path may do it on
 *    purpose. `load()` reports the failure and returns what is already held.
 * 3. **An empty mirror SEEDS.** {@link DurableLedger.observe} answers `seeded`
 *    for a key it has never held — never `flip`. The failure direction is
 *    therefore always toward DISCARD: a lost notification costs one line
 *    nobody reads; a phantom one costs trust in every notification the hub
 *    sends.
 * 4. **A malformed row is SKIPPED, not repaired.** `fromRecord` returning
 *    `null` drops the row from the reseed, so its key re-seeds cold (a
 *    silence) rather than hydrating a value nothing can ever equal (a
 *    permanent phantom flip).
 * 5. **Write mode is declared, not chosen per call site.**
 *    `write-behind` advances the mirror first and persists behind the verdict —
 *    correct when losing the write costs at most one silent re-seed.
 *    `write-through` persists FIRST and only then advances the mirror —
 *    correct when a phantom in-RAM level would be worse than a retry.
 *
 * ## What this deliberately does NOT do
 *
 * - **No pruning policy.** `pruneExcept` exists, but only a caller that holds
 *   an authoritative active set may call it. D130: a prune is work DESTROYED
 *   on a fallible read.
 * - **No retention sweep, no TTL.** Bounding rows is the owner's decision and
 *   it must be written down in the `@durable` annotation on the collection
 *   constant, where `scripts/check-durable-state-declared.ts` can see it.
 * - **No delivery-attempt semantics.** `NcOutbox` is deliberately NOT a
 *   consumer: it tracks per-target attempts and a dedup horizon, which a ledger
 *   primitive should not learn.
 *
 * ## Why this file exists TWICE, and what stops the copies drifting
 *
 * Addons never import each other (`ctx.api` is the only cross-addon layer), and
 * this primitive has consumers in two of them — `addon-post-analysis` and
 * `addon-pipeline-orchestrator`. A framework home (`types`/`system`) is the
 * right one, but a framework fix is not live until a whole `@camstack/server`
 * is published, and the holes this closes are deployable today. So the file is
 * duplicated, byte for byte, and
 * `scripts/check-durable-state-declared.ts` FAILS the build if the two copies
 * differ by one character. Edit either copy and the guard tells you to copy it
 * across; when the framework home lands, delete both and import.
 *
 * ## Storage (records plan phase 3)
 *
 * The durable half reads and writes through a {@link RecordKindHandle} — a
 * kind declared via `ctx.records.declare`, served by the records engine on
 * every node.
 *
 * ## The catalogue
 *
 * Semantic class, owner, write trigger and retention are declared in a
 * `@durable` annotation on the collection-name constant — NOT in this spec.
 * One authority, readable without importing anything, and it covers the
 * collections that will never use this primitive (raw DDL, the kernel's
 * canonical KV list) as well as the ones that do. `docs/reference/storage.md`
 * renders it; the guard fails a new declared collection that omits it.
 */

import type {
  CollectionColumn,
  CollectionIndex,
  IScopedLogger,
  RecordKindHandle,
} from '@camstack/types'

/** The persisted body of a durable row — the column map minus the pk. */
export type DurableRecordBody = Record<string, unknown>

/**
 * What kind of fact a collection holds. The class is what decides whether
 * losing it is a bug, and it is declared per collection in the `@durable`
 * annotation — this union is the vocabulary that annotation must use.
 */
export type DurableSemanticClass =
  /** A fact only this component ever held — "the last observation I ACCEPTED".
   *  No other authority can regenerate it. Must be durable. */
  | 'ledger'
  /** A derived copy of an authority that lives elsewhere. Rehydrated from that
   *  authority; a persisted copy may only ever prevent a cold window. */
  | 'mirror'
  /** Correct to lose. Must not be persisted. */
  | 'ephemeral'
  /** Operator intent. Durable everywhere already. */
  | 'config'
  /** Written for a human to read later, never read back by the system. */
  | 'audit'

/** When the durable write happens relative to the mirror advancing. */
export type DurableWriteMode =
  /** Mirror first, persist behind it. A lost write costs one silent re-seed. */
  | 'write-behind'
  /** Persist first, mirror only on success. A failed write leaves no phantom. */
  | 'write-through'

/**
 * What one observation was worth.
 *
 * `seeded` and `no-flip` both mean "do not act"; they are two verdicts rather
 * than one because they are two different sentences in the log, and "did the
 * process just forget, or did nothing happen" is exactly the question a ledger
 * exists to answer.
 */
export type DurableVerdict = 'seeded' | 'no-flip' | 'flip'

/**
 * Everything the primitive needs to own a collection on a feature's behalf.
 * Pure mechanics: no policy, no thresholds, no clocks.
 */
export interface DurableLedgerSpec<TRow> {
  /** The declared collection name. Must carry a `@durable` annotation. */
  readonly collection: string
  readonly columns: readonly CollectionColumn[]
  readonly indexes?: readonly CollectionIndex[]
  /** See {@link DurableWriteMode}. */
  readonly writeMode: DurableWriteMode
  /** The row's primary key. */
  readonly keyOf: (row: TRow) => string
  /** The persisted column map (the PK is passed separately). */
  readonly toValue: (row: TRow) => Record<string, unknown>
  /** Structural validation on reseed. `null` ⇒ skip the row (re-seed cold). */
  readonly fromRecord: (key: string, data: Record<string, unknown>) => TRow | null
  /**
   * Do two rows describe the SAME accepted fact? Required by
   * {@link DurableLedger.observe}; a spec without it may still use
   * {@link DurableLedger.put}.
   *
   * Deliberately not `deepEqual`: most ledger rows carry an `updatedAt` that
   * moves on every write, so a structural compare would call every repeat a
   * flip. The owner names the fields that constitute the fact.
   */
  readonly equalFact?: (held: TRow, incoming: TRow) => boolean
  /**
   * The device a row is about, when it is about one. Every log line this
   * primitive emits about such a row carries `tags: { deviceId }` — a miss
   * rate or a media gap is always asked per-camera, and a line that omits the
   * tag cannot answer it.
   */
  readonly deviceIdOf?: (row: TRow) => number | undefined
  /**
   * Query cap on the boot reseed. A generous ceiling that still bounds a
   * pathological read; the owner sets it from the row set it expects.
   */
  readonly loadLimit?: number
}

export interface DurableLedgerDeps<TRow> {
  readonly spec: DurableLedgerSpec<TRow>
  readonly kind: RecordKindHandle<DurableRecordBody>
  readonly logger: IScopedLogger
}

/** Default reseed cap — every current consumer's row set is installation-bounded. */
const DEFAULT_LOAD_LIMIT = 100_000

/** Page size for records reseed queries. */
const QUERY_PAGE = 1_000

export class DurableLedger<TRow> {
  private readonly mirror = new Map<string, TRow>()
  /** Whether ANY load has read the store successfully — see {@link hasAnswered}. */
  private answered = false
  private readonly spec: DurableLedgerSpec<TRow>
  private readonly kind: RecordKindHandle<DurableRecordBody>
  private readonly logger: IScopedLogger

  constructor(deps: DurableLedgerDeps<TRow>) {
    this.spec = deps.spec
    this.kind = deps.kind
    this.logger = deps.logger
  }

  /** The collection this ledger owns — for the caller's own log lines. */
  get collection(): string {
    return this.spec.collection
  }

  /**
   * Boot reseed. Replaces the mirror with what the store holds and returns the
   * rows, so a caller that must hydrate something else (a watcher, a registry)
   * gets them without a second read.
   *
   * **A failure returns what is already mirrored** rather than clearing it —
   * see contract rule 2. The count is worth logging out loud at the call site:
   * "loaded 0" after a container recreate is the one line that explains a
   * silent flood.
   */
  async load(): Promise<readonly TRow[]> {
    try {
      const next = new Map<string, TRow>()
      let skipped = 0
      let seen = 0
      const cap = this.spec.loadLimit ?? DEFAULT_LOAD_LIMIT
      let cursor: string | undefined
      for (;;) {
        const limit = Math.min(QUERY_PAGE, cap - seen)
        if (limit <= 0) break
        const page = await this.kind.query({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        })
        seen += page.records.length
        for (const record of page.records) {
          const row = this.spec.fromRecord(record.id, record.data)
          if (row === null) {
            skipped += 1
            continue
          }
          next.set(this.spec.keyOf(row), row)
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      this.mirror.clear()
      for (const [key, row] of next) this.mirror.set(key, row)
      this.answered = true
      if (skipped > 0) {
        this.logger.warn('durable rows skipped as malformed — they gate NOTHING', {
          meta: { collection: this.spec.collection, kind: this.kind.name, skipped },
        })
      }
      return [...this.mirror.values()]
    } catch (err) {
      this.logger.warn('durable load failed — keeping the state already in memory', {
        meta: {
          collection: this.spec.collection,
          kind: this.kind.name,
          error: String(err),
          held: this.mirror.size,
        },
      })
      return [...this.mirror.values()]
    }
  }

  /**
   * Whether the mirror is an ANSWER from the store: true once any load has
   * succeeded, and never false again (a later failed load keeps that answer).
   * Before it, an empty mirror is "not read yet", never "the store is empty" —
   * {@link load} swallows its failure, so a caller that must tell the two apart
   * asks here (D642 review I1).
   */
  hasAnswered(): boolean {
    return this.answered
  }

  /** Every mirrored row, insertion-ordered. */
  snapshot(): readonly TRow[] {
    return [...this.mirror.values()]
  }

  /** The row currently held for a key, if any. Pure RAM — never I/O. */
  get(key: string): TRow | undefined {
    return this.mirror.get(key)
  }

  has(key: string): boolean {
    return this.mirror.has(key)
  }

  get size(): number {
    return this.mirror.size
  }

  /**
   * Judge ONE observation against what the ledger already accepted, and advance
   * it.
   *
   * Synchronous on purpose: the verdict is a function of the in-RAM mirror
   * alone, so a decision can never be gated on an I/O that might fail (D49).
   * The durable write is kicked off behind it and its failure changes no
   * verdict.
   *
   * `no-flip` leaves the held row UNTOUCHED — including any timestamp it
   * carries, which therefore means "when this key last CHANGED", not "when it
   * last spoke". That is the timestamp anyone reading the table wants.
   */
  observe(row: TRow): DurableVerdict {
    const equalFact = this.spec.equalFact
    if (equalFact === undefined) {
      throw new Error(
        `DurableLedger(${this.spec.collection}): observe() requires the spec to declare equalFact`,
      )
    }
    const key = this.spec.keyOf(row)
    const held = this.mirror.get(key)
    if (held !== undefined && equalFact(held, row)) return 'no-flip'
    this.mirror.set(key, row)
    void this.persist(row)
    return held === undefined ? 'seeded' : 'flip'
  }

  /**
   * Upsert a row without a verdict — the write path for a ledger whose owner
   * has already decided the value changed.
   *
   * The order of the mirror advance and the durable write is the spec's
   * {@link DurableWriteMode}, not the call site's: two call sites that
   * disagreed about it would be two different durability guarantees on one
   * collection.
   */
  async put(row: TRow): Promise<void> {
    const key = this.spec.keyOf(row)
    const body = this.spec.toValue(row)
    if (this.spec.writeMode === 'write-behind') {
      this.mirror.set(key, row)
      await this.persistRow(key, body, row)
      return
    }
    await this.kind.put(this.buildPut(key, body, row))
    this.mirror.set(key, row)
  }

  /**
   * Advance the mirror WITHOUT persisting, for an owner that deliberately
   * coalesces its writes.
   *
   * The stationary registry is the reason this exists: a parked car is
   * re-confirmed on every processed frame (5–30 Hz), and persisting each
   * confirmation would offer thousands of commits a day to the checkpoint
   * lottery (D96) to maintain a handful of rows. It stages the advance and
   * flushes on its 5-minute sweep — 288 writes a day instead of ~10⁶.
   *
   * **The cost is stated, not hidden**: a staged value that is never flushed
   * is lost on a crash. An owner may only stage a field whose staleness its
   * own TTL absorbs. Anything that GATES work must go through {@link put} or
   * {@link observe}.
   */
  stage(row: TRow): void {
    this.mirror.set(this.spec.keyOf(row), row)
  }

  /**
   * Drop a key from the MIRROR only — the durable row survives.
   *
   * What a scope-unbind needs: this process stops holding the value, and a
   * rebind reloads it from the store. Deliberately distinct from
   * {@link forget}, which deletes; conflating the two is how an unbind turns
   * into a wipe.
   */
  evict(key: string): void {
    this.mirror.delete(key)
  }

  /**
   * Drop one key, mirror and row. Best-effort on the durable half: a failed
   * delete leaves a row that the next load will re-mirror, which is a stale
   * value rather than a lost one.
   */
  async forget(key: string): Promise<void> {
    this.mirror.delete(key)
    try {
      await this.kind.delete(key)
    } catch (err) {
      this.logger.debug('durable delete failed', {
        meta: { collection: this.spec.collection, kind: this.kind.name, key, error: String(err) },
      })
    }
  }

  /**
   * Drop every MIRRORED row about `deviceId` (per the spec's `deviceIdOf`),
   * leaving the durable rows to the caller's `deleteWhere` (D871). Returns how
   * many mirror entries went; a spec without `deviceIdOf` evicts nothing.
   */
  evictDevice(deviceId: number): number {
    const of = this.spec.deviceIdOf
    if (of === undefined) return 0
    let evicted = 0
    for (const [key, row] of [...this.mirror.entries()]) {
      if (of(row) !== deviceId) continue
      this.mirror.delete(key)
      evicted += 1
    }
    return evicted
  }

  /**
   * Drop every mirrored key NOT in `activeKeys`. Returns how many rows went.
   *
   * **The caller must hold an AUTHORITATIVE active set.** A prune driven by a
   * fallible read is work destroyed on an error (D49/D130) — that is why this
   * is a method a feature opts into rather than a policy the primitive runs.
   * Best-effort per row: a failed delete keeps the key (retried next prune)
   * rather than aborting the sweep.
   */
  async pruneExcept(activeKeys: ReadonlySet<string>): Promise<number> {
    let pruned = 0
    for (const key of [...this.mirror.keys()]) {
      if (activeKeys.has(key)) continue
      try {
        await this.kind.delete(key)
        this.mirror.delete(key)
        pruned += 1
      } catch (err) {
        this.logger.debug('durable prune delete failed', {
          meta: { collection: this.spec.collection, kind: this.kind.name, key, error: String(err) },
        })
      }
    }
    return pruned
  }

  /**
   * Write-behind durable upsert. Best-effort and logged, never thrown at the
   * decision path: the mirror already holds the truth for this process, and the
   * worst a lost write can do is one silent re-seed after the next restart.
   */
  private persist(row: TRow): void {
    const key = this.spec.keyOf(row)
    void this.persistRow(key, this.spec.toValue(row), row)
  }

  private buildPut(
    key: string,
    body: DurableRecordBody,
    row?: TRow,
  ): { readonly id: string; readonly data: DurableRecordBody; readonly deviceId?: number } {
    const deviceId = this.resolveRecordDeviceId(row, body)
    return {
      id: key,
      data: body,
      ...(deviceId !== undefined ? { deviceId } : {}),
    }
  }

  private resolveRecordDeviceId(
    row: TRow | undefined,
    body: DurableRecordBody,
  ): number | undefined {
    if (row !== undefined) {
      const fromSpec = this.spec.deviceIdOf?.(row)
      if (fromSpec !== undefined && Number.isFinite(fromSpec)) return fromSpec
    }
    return this.deviceIdFromBody(body)
  }

  private async persistRow(key: string, body: DurableRecordBody, row?: TRow): Promise<void> {
    const deviceId = this.resolveRecordDeviceId(row, body)
    try {
      await this.kind.put(this.buildPut(key, body, row))
    } catch (err) {
      this.logger.warn('durable persist failed — this key may re-seed on boot', {
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: {
          collection: this.spec.collection,
          kind: this.kind.name,
          key,
          error: String(err),
        },
      })
    }
  }

  private deviceIdFromBody(body: DurableRecordBody): number | undefined {
    const raw = body['deviceId']
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
}
