/**
 * `ctx.records` - an addon's handle on its OWN record kinds (D881).
 *
 * The owner is closed over at construction (the addon id) and the transport
 * decides how it is proven: a hub in-process caller states it, a forked or
 * agent addon sends the bare input and the parent stamps who is calling - the
 * `ctx.secrets` model. Nothing a caller passes can change it.
 *
 * ## Secrets are a feature of the kind
 *
 * A field of the kind's Zod schema marked `.meta({ secret: true })` is stored
 * as a keychain MARKER bound to the row's own ref and never as a value:
 *
 *  - **write**: a non-empty string goes to the keychain FIRST, then the row is
 *    written holding the marker. The redaction token (or an empty/absent
 *    value on a `patch`) keeps what is stored; `put` is a full replace, so a
 *    secret field it omits is removed - and so is its keychain value. A locked
 *    keychain refuses the whole write (`records/secret-unavailable`):
 *    plaintext is never stored, never logged, never in an error message.
 *  - **read**: every read shows the redaction token for a set secret. The
 *    owner that needs the value asks for it (`getResolved`, `query` with
 *    `resolveSecrets`); the keychain answering `unavailable` or `missing`
 *    THROWS - a locked keychain is never read as an empty password.
 *  - **delete**: the keychain values of the removed rows go with them.
 */
import type { z } from 'zod'
import type {
  DeclareKindResult,
  IRecordsProvider,
  RecordQueryInput,
  RecordTransactOp,
  RecordView,
  RecordWhere,
} from '../capabilities/records.cap.js'
import { REDACTED_SECRET } from '../interfaces/config-ui-secrets.js'
import { makeSecretMarker } from '../keychain/secret-marker.js'
import { classifySecretWrite } from '../keychain/secret-marker.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import { InvalidRecordError, RecordSecretUnavailableError, asRecordsError } from './errors.js'
import {
  type DefinedRecordKind,
  declarationsOf,
  type RecordKindDeclaration,
} from './record-kind.js'
import { mapSecretLeaves, REMOVE_LEAF, recordSecretRef } from './secret-paths.js'

/** The wire: the `records` provider's methods. The owner is never an argument. */
export type RecordsTransport = IRecordsProvider

/** A row as the owner sees it. Secret fields hold the redaction token unless resolved. */
export interface RecordRow<T> {
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: T
}

export interface RecordPut<T> {
  readonly id: string
  readonly deviceId?: number
  readonly at?: number
  readonly expiresAt?: number
  readonly data: T
}

export interface RecordsLogger {
  warn(message: string, extras?: { readonly meta?: Record<string, unknown> }): void
}

export interface RecordsAccessOptions {
  readonly owner: string
  readonly transport: RecordsTransport
  /** The owner's keychain handle; `null` where there is none (a kind with secrets then refuses). */
  readonly secrets: SecretsAccess | null
  readonly logger?: RecordsLogger
  /** Builds the transport for another owner - in-process system builtins only. */
  readonly transportForOwner?: (owner: string) => RecordsTransport
}

export interface RecordQueryOptions {
  /** Resolve the secret fields of the page in ONE keychain call. A failure throws. */
  readonly resolveSecrets?: boolean
}

/**
 * One write prepared for {@link RecordsAccess.transact}: the wire op plus the
 * undo of the keychain writes made for it (a refused transaction puts the
 * previous secret values back). Build it with the kind handle's `txPut`,
 * `txPatch` and `txDelete`, which run the same validation and secret handling
 * as the single `put` / `patch` / `delete`.
 */
export interface PreparedTransactOp {
  readonly wire: RecordTransactOp
  readonly rollback: () => Promise<void>
}

/** What one op of a transaction did, in op order. `rev` is `null` for a delete. */
export interface TransactOpResult {
  readonly rev: number | null
  readonly deleted: boolean
}

export interface RecordKindHandle<T> {
  readonly name: string
  /** `put` as an op of {@link RecordsAccess.transact}. */
  txPut(input: RecordPut<T>, opts?: { readonly ifRev?: number }): Promise<PreparedTransactOp>
  /** `patch` as an op of {@link RecordsAccess.transact}. */
  txPatch(
    id: string,
    partial: Readonly<Record<string, unknown>>,
    opts?: {
      readonly ifRev?: number
      readonly at?: number | null
      readonly expiresAt?: number | null
    },
  ): Promise<PreparedTransactOp>
  /** `delete` as an op of {@link RecordsAccess.transact}. */
  txDelete(id: string): PreparedTransactOp
  get(id: string): Promise<RecordRow<T> | null>
  getMany(ids: readonly string[]): Promise<readonly RecordRow<T>[]>
  /** `get` with the secret fields resolved from the keychain. */
  getResolved(id: string): Promise<RecordRow<T> | null>
  put(input: RecordPut<T>, opts?: { readonly ifRev?: number }): Promise<{ readonly rev: number }>
  putMany(inputs: readonly RecordPut<T>[]): Promise<{ readonly count: number }>
  /** RFC 7396 merge in one statement. `null` removes a field. */
  patch(
    id: string,
    partial: Readonly<Record<string, unknown>>,
    opts?: {
      readonly ifRev?: number
      readonly at?: number | null
      readonly expiresAt?: number | null
    },
  ): Promise<{ readonly rev: number }>
  delete(id: string): Promise<boolean>
  deleteMany(ids: readonly string[]): Promise<number>
  query(
    q: Omit<RecordQueryInput, 'kind' | 'limit'> & { readonly limit?: number },
    opts?: RecordQueryOptions,
  ): Promise<{ readonly records: readonly RecordRow<T>[]; readonly nextCursor: string | null }>
  count(q: {
    readonly deviceId?: number
    readonly atFrom?: number
    readonly atTo?: number
    readonly where?: RecordWhere
  }): Promise<number>
  histogram(q: {
    readonly deviceId?: number
    readonly from: number
    readonly to: number
    readonly bucketMs: number
  }): Promise<readonly { readonly bucketStart: number; readonly count: number }[]>
  aggregate(q: {
    readonly op: 'sum' | 'min' | 'max' | 'count'
    readonly field?: string
    readonly groupBy?: string
    readonly where?: RecordWhere
  }): Promise<readonly { readonly group: string | number | null; readonly value: number | null }[]>
  deleteWhere(q: {
    readonly deviceId?: number
    readonly atBefore?: number
    readonly where?: RecordWhere
  }): Promise<number>
  allocateId(): Promise<number>
}

export interface RecordsAccess {
  readonly owner: string
  /**
   * Reconcile this addon's kinds (the engine creates the indexes; additive
   * only; it never moves data, D853).
   */
  declare(
    kinds: Readonly<Record<string, DefinedRecordKind>>,
  ): Promise<Readonly<Record<string, DeclareKindResult>>>
  kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): RecordKindHandle<z.infer<S>>
  /**
   * Several writes in ONE transaction: all land or none does. Every op's kind
   * must be declared by this owner in ONE database file under ONE
   * `transactFamily`; anything else throws `records/transact-refused` before a
   * row is touched. Results are in op order.
   */
  transact(ops: readonly PreparedTransactOp[]): Promise<readonly TransactOpResult[]>
  /**
   * In-process SYSTEM builtins only (the entries service): act as the door of
   * another owner. `null` everywhere else - a forked addon has no way to state
   * an identity the transport would accept.
   */
  readonly forOwner: ((owner: string) => RecordsAccess) | null
  /** The D865 hook body: delete the device's rows from every kind declared `deviceRemoval: 'delete'`. */
  deleteDevice(
    deviceId: number,
    opts?: { readonly kinds?: readonly string[] },
  ): Promise<Readonly<Record<string, number>>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Run a transport call and give a wire failure its typed class back. */
async function call<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn()
  } catch (err: unknown) {
    throw asRecordsError(err)
  }
}

function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

function toRow<T>(view: RecordView, data: T): RecordRow<T> {
  return {
    id: view.id,
    deviceId: view.deviceId,
    at: view.at,
    expiresAt: view.expiresAt,
    rev: view.rev,
    updatedAt: view.updatedAt,
    data,
  }
}

class KindHandle<T> implements RecordKindHandle<T> {
  readonly name: string
  private readonly decl: RecordKindDeclaration

  constructor(
    private readonly def: DefinedRecordKind,
    private readonly o: RecordsAccessOptions,
  ) {
    this.name = def.name
    this.decl = def.declaration
  }

  private get hasSecrets(): boolean {
    return this.decl.secretPaths.length > 0
  }

  private requireSecrets(): SecretsAccess {
    if (this.o.secrets === null) {
      throw new RecordSecretUnavailableError(
        `kind "${this.name}" has secret fields and this process has no keychain door`,
      )
    }
    return this.o.secrets
  }

  /** Read the body as the schema's type. The engine already redacted the secrets. */
  private typed(view: RecordView): RecordRow<T> {
    // The engine stored what this handle's schema validated on write.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: rows are written through this schema
    return toRow(view, view.data as T)
  }

  /**
   * Classify and store the secret leaves of a body about to be written. The
   * keychain is written FIRST (a failure throws before any row is touched), and
   * what each ref held before is remembered: when the row write is then refused
   * (a stale `ifRev`, too large, a unique index) `rollback` puts the previous
   * values back, so a refused write never destroys the secret that was stored.
   */
  private async storeSecrets(
    id: string,
    body: unknown,
    mode: 'put' | 'patch',
  ): Promise<{ readonly body: unknown; readonly rollback: () => Promise<void> }> {
    if (!this.hasSecrets) return { body, rollback: async () => {} }
    const secrets = this.requireSecrets()
    const writes: { readonly ref: string; readonly value: string }[] = []
    const prepared = mapSecretLeaves(
      body,
      this.decl.secretPaths,
      this.decl.secretArrayKeys,
      (leaf) => {
        const intent = classifySecretWrite(leaf.value)
        if (intent.kind === 'clear') return REMOVE_LEAF
        if (intent.kind === 'keep') {
          if (mode === 'put') return REDACTED_SECRET
          // A patch with `null` removes the field (RFC 7396). An untouched plain field
          // is simply left out of the merge; an array is REPLACED by the merge, so its
          // element keeps the token and the engine restores the stored marker.
          if (leaf.value === null) return null
          return leaf.concrete.includes('[') ? REDACTED_SECRET : REMOVE_LEAF
        }
        const ref = recordSecretRef(this.o.owner, this.name, id, leaf.concrete)
        writes.push({ ref, value: intent.value })
        return makeSecretMarker(ref)
      },
    )
    const done: { readonly ref: string; readonly previous: string | undefined }[] = []
    const rollback = async (): Promise<void> => {
      for (const { ref, previous } of done) {
        try {
          if (previous === undefined) await secrets.delete([ref])
          else await secrets.put(ref, previous)
        } catch (err: unknown) {
          this.o.logger?.warn('records: could not restore a keychain value after a refused write', {
            meta: { kind: this.name, error: err instanceof Error ? err.message : 'unknown' },
          })
        }
      }
    }
    for (const write of writes) {
      try {
        const before = (await secrets.resolve([write.ref]))[write.ref]
        const previous = before?.kind === 'value' ? before.value : undefined
        await secrets.put(write.ref, write.value)
        done.push({ ref: write.ref, previous })
      } catch (err: unknown) {
        await rollback()
        throw new RecordSecretUnavailableError(
          `cannot store a secret of ${this.name}/${id}: ${err instanceof Error ? err.message : 'the keychain refused'}. Unlock the keychain (System -> Secrets) and save again`,
        )
      }
    }
    return { body: prepared, rollback }
  }

  private async releaseRefs(refs: readonly string[]): Promise<void> {
    if (refs.length === 0 || this.o.secrets === null) return
    try {
      await this.o.secrets.delete(refs)
    } catch (err: unknown) {
      this.o.logger?.warn('records: could not remove released keychain values', {
        meta: {
          kind: this.name,
          count: refs.length,
          error: err instanceof Error ? err.message : 'unknown',
        },
      })
    }
  }

  private validate(data: unknown, id: string): Record<string, unknown> {
    // An untouched secret arrives as the token / a marker view: shape it so the
    // schema (a plain string field) accepts it. The value is never inspected here.
    const shaped = this.hasSecrets
      ? mapSecretLeaves(data, this.decl.secretPaths, this.decl.secretArrayKeys, (leaf) => {
          const intent = classifySecretWrite(leaf.value)
          if (intent.kind === 'clear') return REMOVE_LEAF
          return intent.kind === 'keep' ? REDACTED_SECRET : leaf.value
        })
      : data
    const parsed = this.def.schema.safeParse(shaped)
    if (!parsed.success) {
      throw new InvalidRecordError(`${this.name}/${id}: ${zodSummary(parsed.error)}`)
    }
    if (!isRecord(parsed.data)) {
      throw new InvalidRecordError(`${this.name}/${id}: the body must be an object`)
    }
    return parsed.data
  }

  async get(id: string): Promise<RecordRow<T> | null> {
    const view = await call(() => this.o.transport.get({ kind: this.name, id }))
    return view === null ? null : this.typed(view)
  }

  async getMany(ids: readonly string[]): Promise<readonly RecordRow<T>[]> {
    if (ids.length === 0) return []
    const views = await call(() => this.o.transport.getMany({ kind: this.name, ids: [...ids] }))
    return views.map((v) => this.typed(v))
  }

  async getResolved(id: string): Promise<RecordRow<T> | null> {
    const row = await this.get(id)
    if (row === null) return null
    return (await this.resolveRows([row]))[0] ?? row
  }

  private async resolveRows(rows: readonly RecordRow<T>[]): Promise<readonly RecordRow<T>[]> {
    if (!this.hasSecrets || rows.length === 0) return rows
    const secrets = this.requireSecrets()
    const refsById = await call(() =>
      this.o.transport.secretRefs({ kind: this.name, ids: rows.map((r) => r.id) }),
    )
    const refs = Object.values(refsById).flatMap((byPath) => Object.values(byPath))
    if (refs.length === 0) return rows
    const answers = await secrets.resolve(refs)
    return rows.map((row) => {
      const byPath = refsById[row.id] ?? {}
      const resolved = mapSecretLeaves(
        row.data,
        this.decl.secretPaths,
        this.decl.secretArrayKeys,
        (leaf) => {
          const ref = byPath[leaf.concrete]
          if (ref === undefined) return leaf.value
          const answer = answers[ref]
          if (answer?.kind === 'value') return answer.value
          const why = answer?.kind === 'unavailable' ? answer.reason : (answer?.kind ?? 'no answer')
          throw new RecordSecretUnavailableError(
            `the secret "${leaf.concrete}" of ${this.name}/${row.id} cannot be served (${why})`,
          )
        },
      )
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: same shape, secrets filled in
      return { ...row, data: resolved as T }
    })
  }

  async txPut(
    input: RecordPut<T>,
    opts: { readonly ifRev?: number } = {},
  ): Promise<PreparedTransactOp> {
    const checked = this.validate(input.data, input.id)
    const { body, rollback } = await this.storeSecrets(input.id, checked, 'put')
    return {
      wire: {
        op: 'put',
        kind: this.name,
        record: { ...input, data: toBody(body) },
        ...(opts.ifRev === undefined ? {} : { ifRev: opts.ifRev }),
      },
      rollback,
    }
  }

  async txPatch(
    id: string,
    partial: Readonly<Record<string, unknown>>,
    opts: {
      readonly ifRev?: number
      readonly at?: number | null
      readonly expiresAt?: number | null
    } = {},
  ): Promise<PreparedTransactOp> {
    const { body, rollback } = await this.storeSecrets(id, partial, 'patch')
    return {
      wire: {
        op: 'patch',
        kind: this.name,
        id,
        data: toBody(body),
        ...(opts.at === undefined ? {} : { at: opts.at }),
        ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
        ...(opts.ifRev === undefined ? {} : { ifRev: opts.ifRev }),
      },
      rollback,
    }
  }

  txDelete(id: string): PreparedTransactOp {
    return { wire: { op: 'delete', kind: this.name, id }, rollback: async () => {} }
  }

  async put(input: RecordPut<T>, opts: { readonly ifRev?: number } = {}) {
    const checked = this.validate(input.data, input.id)
    const { body, rollback } = await this.storeSecrets(input.id, checked, 'put')
    const result = await call(() =>
      this.o.transport.put({
        kind: this.name,
        record: { ...input, data: toBody(body) },
        ...(opts.ifRev === undefined ? {} : { ifRev: opts.ifRev }),
      }),
    ).catch(async (err: unknown) => {
      await rollback()
      throw err
    })
    await this.releaseRefs(result.releasedRefs)
    return { rev: result.rev }
  }

  async putMany(inputs: readonly RecordPut<T>[]) {
    if (inputs.length === 0) return { count: 0 }
    const prepared: RecordPut<Record<string, unknown>>[] = []
    const rollbacks: (() => Promise<void>)[] = []
    try {
      for (const input of inputs) {
        const checked = this.validate(input.data, input.id)
        const { body, rollback } = await this.storeSecrets(input.id, checked, 'put')
        rollbacks.push(rollback)
        prepared.push({ ...input, data: toBody(body) })
      }
    } catch (err: unknown) {
      for (const rollback of rollbacks) await rollback()
      throw err
    }
    const result = await call(() =>
      this.o.transport.putMany({ kind: this.name, records: prepared }),
    ).catch(async (err: unknown) => {
      for (const rollback of rollbacks) await rollback()
      throw err
    })
    await this.releaseRefs(result.releasedRefs)
    return { count: result.count }
  }

  async patch(
    id: string,
    partial: Readonly<Record<string, unknown>>,
    opts: {
      readonly ifRev?: number
      readonly at?: number | null
      readonly expiresAt?: number | null
    } = {},
  ) {
    const { body, rollback } = await this.storeSecrets(id, partial, 'patch')
    const result = await call(() =>
      this.o.transport.patch({
        kind: this.name,
        id,
        data: toBody(body),
        ...(opts.at === undefined ? {} : { at: opts.at }),
        ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
        ...(opts.ifRev === undefined ? {} : { ifRev: opts.ifRev }),
      }),
    ).catch(async (err: unknown) => {
      await rollback()
      throw err
    })
    await this.releaseRefs(result.releasedRefs)
    return { rev: result.rev }
  }

  async delete(id: string): Promise<boolean> {
    const result = await call(() => this.o.transport.delete({ kind: this.name, id }))
    await this.releaseRefs(result.secretRefs)
    return result.deleted
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0
    const result = await call(() => this.o.transport.deleteMany({ kind: this.name, ids: [...ids] }))
    await this.releaseRefs(result.secretRefs)
    return result.deleted
  }

  async query(
    q: Omit<RecordQueryInput, 'kind' | 'limit'> & { readonly limit?: number },
    opts: RecordQueryOptions = {},
  ) {
    const result = await call(() =>
      this.o.transport.query({ ...q, kind: this.name, limit: q.limit ?? 100 }),
    )
    const rows = result.records.map((v) => this.typed(v))
    const out = opts.resolveSecrets === true ? await this.resolveRows(rows) : rows
    return { records: out, nextCursor: result.nextCursor }
  }

  async count(q: {
    readonly deviceId?: number
    readonly atFrom?: number
    readonly atTo?: number
    readonly where?: RecordWhere
  }): Promise<number> {
    return (await call(() => this.o.transport.count({ ...q, kind: this.name }))).count
  }

  async histogram(q: {
    readonly deviceId?: number
    readonly from: number
    readonly to: number
    readonly bucketMs: number
  }) {
    return (await call(() => this.o.transport.histogram({ ...q, kind: this.name }))).buckets
  }

  async aggregate(q: {
    readonly op: 'sum' | 'min' | 'max' | 'count'
    readonly field?: string
    readonly groupBy?: string
    readonly where?: RecordWhere
  }) {
    return (await call(() => this.o.transport.aggregate({ ...q, kind: this.name }))).rows
  }

  async deleteWhere(q: {
    readonly deviceId?: number
    readonly atBefore?: number
    readonly where?: RecordWhere
  }): Promise<number> {
    const result = await call(() => this.o.transport.deleteWhere({ ...q, kind: this.name }))
    await this.releaseRefs(result.secretRefs)
    return result.deleted
  }

  async allocateId(): Promise<number> {
    return (await call(() => this.o.transport.allocateId({ kind: this.name }))).id
  }
}

function toBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidRecordError('the record body must be an object')
  return value
}

/** Build the owner's records handle. */
export function createRecordsAccess(options: RecordsAccessOptions): RecordsAccess {
  const handles = new WeakMap<DefinedRecordKind, RecordKindHandle<unknown>>()
  const delegates = new Map<string, RecordsAccess>()
  return {
    owner: options.owner,

    forOwner:
      options.transportForOwner === undefined
        ? null
        : (other: string): RecordsAccess => {
            const existing = delegates.get(other)
            if (existing !== undefined) return existing
            const build = options.transportForOwner
            if (build === undefined) throw new Error('forOwner: no delegate transport')
            const delegate = createRecordsAccess({
              owner: other,
              transport: build(other),
              secrets: options.secrets?.forOwner?.(other) ?? null,
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            })
            delegates.set(other, delegate)
            return delegate
          },

    async declare(kinds) {
      const result = await call(() =>
        options.transport.declareKinds({ kinds: { ...declarationsOf(kinds) } }),
      )
      return result.kinds
    },

    kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): RecordKindHandle<z.infer<S>> {
      const existing = handles.get(definition)
      // The cache is keyed by the definition object; a definition has one handle per process.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the handle was built from this very definition
      if (existing !== undefined) return existing as RecordKindHandle<z.infer<S>>
      const handle = new KindHandle<z.infer<S>>(definition, options)
      handles.set(definition, handle)
      return handle
    },

    async transact(ops) {
      if (ops.length === 0) return []
      const result = await call(() =>
        options.transport.transact({ ops: ops.map((op) => op.wire) }),
      ).catch(async (err: unknown) => {
        for (const op of ops) await op.rollback()
        throw err
      })
      const released = [...result.releasedRefs, ...result.secretRefs]
      if (released.length > 0 && options.secrets !== null) {
        try {
          await options.secrets.delete(released)
        } catch (err: unknown) {
          options.logger?.warn('records: could not remove released keychain values', {
            meta: { count: released.length, error: err instanceof Error ? err.message : 'unknown' },
          })
        }
      }
      return result.results
    },

    async deleteDevice(deviceId, opts = {}) {
      const result = await call(() =>
        options.transport.deleteDevice({
          deviceId,
          ...(opts.kinds === undefined ? {} : { kinds: [...opts.kinds] }),
        }),
      )
      if (result.secretRefs.length > 0 && options.secrets !== null) {
        try {
          await options.secrets.delete(result.secretRefs)
        } catch (err: unknown) {
          options.logger?.warn('records: could not remove released keychain values', {
            meta: {
              count: result.secretRefs.length,
              error: err instanceof Error ? err.message : 'unknown',
            },
          })
        }
      }
      return result.deleted
    },
  }
}
