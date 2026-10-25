import {
  type IScopedLogger,
  type InMemoryRecords,
  type RecordKindHandle,
  makeInMemoryRecords,
  type NcConfirm,
} from '@camstack/types'
import { NcConfirmSchema } from '@camstack/types'
import { prepareNotification } from '@camstack/types'
import type { NcNotificationInput } from '../../dispatcher.js'
import type { NcSystemEventSubject } from '../../rule-engine.js'
import { NC_CONFIRM_DEFAULT_MAX_IMAGE_PX, NC_CONFIRM_DEFAULT_TIMEOUT_MS } from '@camstack/types'
import { resolvePruneWindows } from '../../prune-windows.js'
import { ncDurableRecordKinds } from '../../nc-durable-record-kinds.js'
import { ncRecordKinds } from '../../record-kinds.js'

/** Every kind the centre owns: the config kinds and the live-state ledgers. */
export type NcKindName = keyof typeof ncRecordKinds | keyof typeof ncDurableRecordKinds

/**
 * The records world of a centre spec: `makeInMemoryRecords` (the real
 * `ctx.records` facade over an engine that keeps the real contract, refusals
 * included) with every NC kind declared, as the addon's boot leaves it. The
 * declaration is initiated here and the in-memory engine applies it before any
 * later operation, so a harness can stay synchronous.
 */
export function makeNcRecords(owner = 'pipeline-analytics'): InMemoryRecords {
  const world = makeInMemoryRecords(owner)
  void world.records.declare(ncRecordKinds)
  void world.records.declare(ncDurableRecordKinds)
  return world
}

/**
 * What a kind holds right now: id -> the stored body. A snapshot (a copy), so a
 * spec reads a table the way it read the fake settings store's `data.get(...)`.
 */
export function ncTable(
  world: InMemoryRecords,
  kind: NcKindName,
): Map<string, Record<string, unknown>> {
  const table = world.tables.get(kind)
  return new Map([...(table?.values() ?? [])].map((row) => [row.id, row.data]))
}

/** Default {@link NotificationCenterDeps.pruneWindows} for NC integration specs. */
export function defaultNcPruneWindows(): ReturnType<typeof resolvePruneWindows> {
  return resolvePruneWindows({})
}

export function ncPruneWindowsPort(): () => Promise<ReturnType<typeof resolvePruneWindows>> {
  return async () => defaultNcPruneWindows()
}

/** Complete logger stub when a spec only wires info/debug/warn. */
export function completeLoggerStub(stub: {
  readonly info?: IScopedLogger['info']
  readonly debug?: IScopedLogger['debug']
  readonly warn?: IScopedLogger['warn']
  readonly error?: IScopedLogger['error']
}): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: stub.debug ?? noop,
    info: stub.info ?? noop,
    warn: stub.warn ?? noop,
    error: stub.error ?? noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Rule-shaped {@link NcConfirm} — Zod defaults are not applied on cap input types. */
export function makeTestNcConfirm(
  patch: Partial<NcConfirm> & Pick<NcConfirm, 'enabled'>,
): NcConfirm {
  return NcConfirmSchema.parse({ ...patch, enabled: patch.enabled })
}

/** {@link NcConfirm} with schema defaults — for specs that need a full row shape. */
export function makeTestNcConfirmWithDefaults(
  patch: Partial<NcConfirm> & Pick<NcConfirm, 'enabled'>,
): NcConfirm {
  return {
    timeoutMs: NC_CONFIRM_DEFAULT_TIMEOUT_MS,
    onTimeout: 'fire',
    maxImagePx: NC_CONFIRM_DEFAULT_MAX_IMAGE_PX,
    ...patch,
    enabled: patch.enabled,
  }
}

export function makeTestNcSystemEventSubject(
  over: Partial<NcSystemEventSubject> & Pick<NcSystemEventSubject, 'kind' | 'subject'>,
): NcSystemEventSubject {
  return { data: {}, ...over }
}

/** Timelapse rule input default — GIF preview is opt-in (`previewMode`). */
export const testTimelapsePreviewMode = 'image' as const

/** {@link prepareNotification} input — NC dispatcher omits `format` / default `priority`. */
export function withNcNotificationFormat(
  input: NcNotificationInput,
): Parameters<typeof prepareNotification>[1] {
  return {
    body: input.body,
    format: 'text',
    priority: input.priority ?? 3,
    title: input.title,
    level: input.level,
    attachments:
      input.attachments?.map((a) => ({
        mediaType: a.mediaType,
        url: a.url,
        bytes: a.bytes !== undefined ? new Uint8Array(a.bytes) : undefined,
        mime: a.mime,
        name: a.name,
      })) ?? undefined,
    actions: input.actions?.map((a) => ({ ...a })),
    sound: input.sound,
    clickUrl: input.clickUrl,
    ttl: input.ttl,
    tag: input.tag,
  }
}

/** Which operations of which kind a {@link withNcFaults} world refuses, and with what message. */
/** The query a kind handle's `query` was sent. */
export type NcRecordsQuery = Parameters<RecordKindHandle<unknown>['query']>[0]

export interface NcFaultRules {
  /** A read (`get`, `getMany`, `query`, `count`) of this kind throws the returned message. */
  readonly read?: (kind: string, query?: NcRecordsQuery) => string | null
  /** A `query` of this kind runs through this hook: it decides when `read` runs and when its rows return. */
  readonly aroundQuery?: <R>(kind: string, read: () => Promise<R>) => Promise<R>
  /** A write of row `id` of this kind waits on this hook first (a stalled engine). */
  readonly aroundWrite?: (kind: string, id: string | undefined, data?: unknown) => Promise<void>
  /** A write of row `id` (undefined for a bulk write) of this kind throws the returned message. */
  readonly write?: (kind: string, id: string | undefined) => string | null
}

/**
 * The same world with chosen faults: every other operation, and the tables,
 * are the base world's. A restart over the faulty world sees what the base wrote.
 */
export function withNcFaults(world: InMemoryRecords, rules: NcFaultRules): InMemoryRecords {
  const reading = (kind: string, query?: NcRecordsQuery): void => {
    const message = rules.read?.(kind, query) ?? null
    if (message !== null) throw new Error(message)
  }
  const writing = async (kind: string, id: string | undefined, data?: unknown): Promise<void> => {
    await rules.aroundWrite?.(kind, id, data)
    const message = rules.write?.(kind, id) ?? null
    if (message !== null) throw new Error(message)
  }
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: async (id) => {
      reading(h.name)
      return h.get(id)
    },
    getMany: async (ids) => {
      reading(h.name)
      return h.getMany(ids)
    },
    getResolved: async (id) => {
      reading(h.name)
      return h.getResolved(id)
    },
    put: async (input, opts) => {
      await writing(h.name, input.id, input.data)
      return h.put(input, opts)
    },
    putMany: async (inputs) => {
      await writing(h.name, undefined)
      return h.putMany(inputs)
    },
    patch: async (id, partial, opts) => {
      await writing(h.name, id)
      return h.patch(id, partial, opts)
    },
    delete: async (id) => {
      await writing(h.name, id)
      return h.delete(id)
    },
    deleteMany: async (ids) => {
      await writing(h.name, undefined)
      return h.deleteMany(ids)
    },
    query: async (q, opts) => {
      reading(h.name, q)
      const around = rules.aroundQuery
      return around === undefined ? h.query(q, opts) : around(h.name, () => h.query(q, opts))
    },
    count: async (q) => {
      reading(h.name)
      return h.count(q)
    },
    histogram: (q) => h.histogram(q),
    aggregate: (q) => h.aggregate(q),
    deleteWhere: async (q) => {
      await writing(h.name, undefined)
      return h.deleteWhere(q)
    },
    allocateId: () => h.allocateId(),
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    ...world,
    records: { ...world.records, kind: (definition) => wrap(world.records.kind(definition)) },
  }
}

/** Seed several rows of a kind, as the engine would have stored them. */
export function seedRows(
  world: InMemoryRecords,
  kind: NcKindName,
  rows: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
): void {
  for (const row of rows) world.seed(kind, row)
}
