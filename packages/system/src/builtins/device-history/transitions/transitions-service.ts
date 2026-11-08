/**
 * The transition ledger as the device-history addon sees it (D1022): the
 * declared kind, the kernel-only writer, the paged reads, the retention sweep
 * and the device-removal hook body (D865).
 *
 * Reads go to the store: an answered empty page is "no transitions". The
 * ledger is not a second copy of any device fact - the hub mirror stays the
 * one authority, and nothing here is read back to decide a device's state.
 */
import {
  type DeviceTransition,
  type IScopedLogger,
  InvalidRecordError,
  type RecordKindHandle,
  RecordTooLargeError,
  type RecordsAccess,
  type RecordWhere,
  type TransitionActorKind,
  type TransitionOutcome,
  type TransitionRecordResult,
  type TransitionRefusalReason,
  type TransitionsStatus,
} from '@camstack/types'
import { DAY_MS } from '../time/bucket-time.js'
import { deviceTransitionsRecordKinds } from './device-transitions-record-kinds.js'

/** The only caller `record` accepts: the hub kernel's device-manager states its own id. */
export const KERNEL_CALLER = 'device-manager'

export interface TransitionsServiceDeps {
  readonly records: RecordsAccess
  readonly logger: IScopedLogger
  readonly clock: () => number
  /** Gives the thread back between delete slices; a spec counts it. */
  readonly yieldNow?: () => Promise<void>
}

interface Window {
  readonly atFrom?: number | undefined
  readonly atTo?: number | undefined
}

export interface ListTransitionsInput extends Window {
  readonly deviceId: number
  readonly capName?: string | undefined
  readonly actorKind?: TransitionActorKind | undefined
  readonly outcome?: TransitionOutcome | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

export interface ListRecentInput extends Window {
  readonly actorKind?: TransitionActorKind | undefined
  readonly outcome?: TransitionOutcome | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

export interface TransitionPage {
  readonly transitions: readonly DeviceTransition[]
  readonly nextCursor: string | null
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function rangeOf(window: Window): { readonly at?: { gte?: number; lt?: number } } {
  const range = {
    ...(window.atFrom !== undefined ? { gte: window.atFrom } : {}),
    ...(window.atTo !== undefined ? { lt: window.atTo } : {}),
  }
  return Object.keys(range).length > 0 ? { at: range } : {}
}

/** One equality filter per call: each is served by its own declared index. */
function assertOneFilter(filters: Readonly<Record<string, unknown>>): void {
  const named = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
  if (named.length > 1) {
    throw new Error(
      `filter by one of ${Object.keys(filters).join(', ')} per call (got ${named.join(' and ')})`,
    )
  }
}

function isRejectedRow(err: unknown): boolean {
  return err instanceof InvalidRecordError || err instanceof RecordTooLargeError
}

export class TransitionsService {
  private handle: RecordKindHandle<DeviceTransition> | null = null
  private lastWriteAt: number | null = null
  private readonly refused = new Map<TransitionRefusalReason, number>()

  constructor(private readonly deps: TransitionsServiceDeps) {}

  /** Declare the kind. */
  async open(): Promise<void> {
    await this.deps.records.declare(deviceTransitionsRecordKinds)
    this.handle = this.deps.records.kind(deviceTransitionsRecordKinds['device-transitions'])
  }

  private kind(): RecordKindHandle<DeviceTransition> {
    if (this.handle === null) throw new Error('the transition ledger is not open yet')
    return this.handle
  }

  private count(reason: TransitionRefusalReason, by: number): void {
    this.refused.set(reason, (this.refused.get(reason) ?? 0) + by)
  }

  /**
   * Write a batch. Only the kernel may: a forked addon is stamped by the
   * transport and an HTTP session's stamp is stripped, so anything but the
   * kernel's own id is refused, counted and logged. A storage failure throws,
   * so the sender keeps the batch (D49).
   */
  async record(
    callerAddonId: string | null,
    transitions: readonly DeviceTransition[],
  ): Promise<TransitionRecordResult> {
    if (callerAddonId !== KERNEL_CALLER) {
      this.count('not-kernel', transitions.length)
      this.deps.logger.warn(
        'device-transitions: refused a batch from a caller that is not the kernel (not-kernel)',
        {
          meta: { caller: callerAddonId, rows: transitions.length },
        },
      )
      return {
        written: 0,
        refused: transitions.map((t) => ({ id: t.id, reason: 'not-kernel' })),
      }
    }
    if (transitions.length === 0) return { written: 0, refused: [] }
    const handle = this.kind()
    const puts = transitions.map((t) => ({ id: t.id, deviceId: t.deviceId, at: t.at, data: t }))
    try {
      await handle.putMany(puts)
      this.lastWriteAt = this.deps.clock()
      return { written: transitions.length, refused: [] }
    } catch (err: unknown) {
      if (!isRejectedRow(err)) throw err
    }
    // The batch is atomic: one rejected row failed all of them. Write the rest one by one.
    let written = 0
    const refused: { id: string; reason: TransitionRefusalReason }[] = []
    for (const put of puts) {
      try {
        await handle.put(put)
        written += 1
      } catch (err: unknown) {
        if (!isRejectedRow(err)) throw err
        refused.push({ id: put.id, reason: 'invalid' })
        this.count('invalid', 1)
        this.deps.logger.warn(
          'device-transitions: a transition was rejected by the ledger (invalid)',
          {
            tags: { deviceId: put.deviceId },
            meta: { id: put.id, error: err instanceof Error ? err.message : String(err) },
          },
        )
      }
    }
    if (written > 0) this.lastWriteAt = this.deps.clock()
    return { written, refused }
  }

  async list(input: ListTransitionsInput): Promise<TransitionPage> {
    assertOneFilter({ capName: input.capName, actorKind: input.actorKind, outcome: input.outcome })
    const paging = {
      desc: true,
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    }
    const range = rangeOf(input)
    const handle = this.kind()
    const page =
      input.capName !== undefined
        ? await handle.query({
            where: { deviceId: input.deviceId, capName: input.capName, ...range },
            ...paging,
          })
        : input.actorKind !== undefined
          ? await handle.query({
              where: { deviceId: input.deviceId, 'actor.kind': input.actorKind, ...range },
              ...paging,
            })
          : input.outcome !== undefined
            ? await handle.query({
                where: { deviceId: input.deviceId, outcome: input.outcome, ...range },
                ...paging,
              })
            : await handle.query({
                deviceId: input.deviceId,
                ...(input.atFrom !== undefined ? { atFrom: input.atFrom } : {}),
                ...(input.atTo !== undefined ? { atTo: input.atTo } : {}),
                ...paging,
              })
    return { transitions: page.records.map((row) => row.data), nextCursor: page.nextCursor }
  }

  async listRecent(input: ListRecentInput): Promise<TransitionPage> {
    assertOneFilter({ actorKind: input.actorKind, outcome: input.outcome })
    const paging = {
      desc: true,
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    }
    const range = rangeOf(input)
    const handle = this.kind()
    const where: RecordWhere | null =
      input.actorKind !== undefined
        ? { 'actor.kind': input.actorKind, ...range }
        : input.outcome !== undefined
          ? { outcome: input.outcome, ...range }
          : null
    const page =
      where !== null
        ? await handle.query({ where, ...paging })
        : await handle.query({
            ...(input.atFrom !== undefined ? { atFrom: input.atFrom } : {}),
            ...(input.atTo !== undefined ? { atTo: input.atTo } : {}),
            ...paging,
          })
    return { transitions: page.records.map((row) => row.data), nextCursor: page.nextCursor }
  }

  async get(input: {
    readonly deviceId: number
    readonly id: string
  }): Promise<DeviceTransition | null> {
    const row = await this.kind().get(input.id)
    return row !== null && row.data.deviceId === input.deviceId ? row.data : null
  }

  async status(): Promise<TransitionsStatus> {
    let rows: number | null = null
    try {
      rows = await this.kind().count({})
    } catch (err: unknown) {
      this.deps.logger.warn('device-transitions: the row count failed - reported as unknown', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    return { rows, lastWriteAt: this.lastWriteAt, refused: Object.fromEntries(this.refused) }
  }

  /**
   * Delete every row older than `cutoff` (a row AT the cutoff is kept), in
   * day-wide slices from the oldest row, yielding between them. Answers the
   * rows deleted.
   */
  async sweep(cutoff: number): Promise<number> {
    const handle = this.kind()
    const oldest = await handle.query({ desc: false, limit: 1 })
    const first = oldest.records[0]?.at
    if (first === undefined || first === null || first >= cutoff) return 0
    const yieldNow = this.deps.yieldNow ?? yieldToEventLoop
    let deleted = 0
    for (let lo = first; lo < cutoff; lo += DAY_MS) {
      deleted += await handle.deleteWhere({ atBefore: Math.min(lo + DAY_MS, cutoff) })
      await yieldNow()
    }
    return deleted
  }

  /** The D865 hook body: how many transition rows the removal deleted. */
  async removeDevice(deviceId: number): Promise<number> {
    const counts = await this.deps.records.deleteDevice(deviceId, { kinds: ['device-transitions'] })
    return counts['device-transitions'] ?? 0
  }

  /** Rows per device, for the admin clean-up listing. */
  async countByDevice(): Promise<readonly { deviceId: number; count: number }[]> {
    const handle = this.handle
    if (handle === null) return []
    const rows = await handle.aggregate({ op: 'count', groupBy: 'deviceId' })
    const out: { deviceId: number; count: number }[] = []
    for (const row of rows) {
      if (typeof row.group === 'number' && row.value !== null) {
        out.push({ deviceId: row.group, count: row.value })
      }
    }
    return out
  }
}
