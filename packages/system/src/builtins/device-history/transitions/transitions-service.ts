/**
 * The transition ledger as the device-history addon sees it (D1022, D1084): the
 * declared kind of stored COMMAND rows, the kernel-only writer, the paged reads, the
 * retention sweep and the device-removal hook body (D865). A device read merges the
 * stored commands with the device's own changes derived from its raw history series.
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
import type { FieldChange } from './change-coalescing.js'
import type { DerivedChanges } from './derived-changes.js'
import { deviceTransitionsRecordKinds } from './device-transitions-record-kinds.js'

/** The only caller `record` accepts: the hub kernel's device-manager states its own id. */
export const KERNEL_CALLER = 'device-manager'

export interface TransitionsServiceDeps {
  readonly records: RecordsAccess
  readonly logger: IScopedLogger
  readonly clock: () => number
  /** The device's own changes, read from device-history. */
  readonly derived: Pick<DerivedChanges, 'read'>
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

function rangeOf(window: Window): {
  readonly at?: { gte?: number; lt?: number }
} {
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

/** Where a row sits in the merged order: time, then source (a command before a change), then id. */
interface SortKey {
  readonly at: number
  readonly source: 0 | 1
  readonly id: string
}

interface Keyed {
  readonly key: SortKey
  readonly row: DeviceTransition
}

const SOURCE_CHANGE = 0
const SOURCE_COMMAND = 1

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.at !== b.at) return a.at - b.at
  if (a.source !== b.source) return a.source - b.source
  return compareIds(a.id, b.id)
}

/**
 * Ids in the order the store yields one millisecond: insertion order, which for a command id
 * `<deviceId>:<at>:c<seq>` is its sequence NUMBER, so `c9` precedes `c10`. A plain string compare
 * puts `c10` first and a cursor on either side of that pair drops a row.
 */
function compareIds(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? []
  const right = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] ?? ''
    const y = right[i] ?? ''
    if (x === y) continue
    const numeric = /^\d/.test(x) && /^\d/.test(y)
    if (numeric) return Number(x) - Number(y)
    return x < y ? -1 : 1
  }
  return left.length - right.length
}

function commandKey(row: DeviceTransition): Keyed {
  return { key: { at: row.at, source: SOURCE_COMMAND, id: row.id }, row }
}

/** A derived change as a row: actor `device`, outcome `device`, an id that names what it is. */
function changeKey(deviceId: number, change: FieldChange): Keyed {
  const id = `chg:${deviceId}:${change.at}:${change.capName}.${change.field}`
  return {
    key: { at: change.at, source: SOURCE_CHANGE, id },
    row: {
      id,
      deviceId,
      at: change.at,
      capName: change.capName,
      field: change.field,
      from: change.from,
      to: change.to,
      outcome: 'device',
      actor: { kind: 'device' },
    },
  }
}

function cursorOf(item: Keyed): string {
  return `${item.key.at}.${item.key.source}.${item.key.id}`
}

function parseCursor(cursor: string): SortKey {
  const first = cursor.indexOf('.')
  const second = cursor.indexOf('.', first + 1)
  const at = Number(cursor.slice(0, first))
  const source = cursor.slice(first + 1, second)
  if (first < 0 || second < 0 || !Number.isFinite(at) || (source !== '0' && source !== '1')) {
    throw new Error('invalid cursor')
  }
  return {
    at,
    source: source === '1' ? SOURCE_COMMAND : SOURCE_CHANGE,
    id: cursor.slice(second + 1),
  }
}

/** Take the first `count` rows of several newest-first sources, merged into one newest-first run. */
async function takeMerged(
  sources: readonly AsyncIterable<Keyed>[],
  count: number,
): Promise<Keyed[]> {
  const iterators = sources.map((s) => s[Symbol.asyncIterator]())
  const heads = await Promise.all(iterators.map((it) => it.next()))
  const out: Keyed[] = []
  try {
    while (out.length < count) {
      let best = -1
      for (const [i, head] of heads.entries()) {
        if (head.done === true) continue
        const current = best < 0 ? undefined : heads[best]
        if (
          current === undefined ||
          current.done === true ||
          compareKeys(head.value.key, current.value.key) > 0
        )
          best = i
      }
      const winner = best < 0 ? undefined : heads[best]
      if (winner === undefined || winner.done === true) break
      out.push(winner.value)
      const it = iterators[best]
      if (it !== undefined) heads[best] = await it.next()
    }
  } finally {
    await Promise.all(iterators.map((it) => it.return?.()))
  }
  return out
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
    const puts = transitions.map((t) => ({
      id: t.id,
      deviceId: t.deviceId,
      at: t.at,
      data: t,
    }))
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
            meta: {
              id: put.id,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        )
      }
    }
    if (written > 0) this.lastWriteAt = this.deps.clock()
    return { written, refused }
  }

  /**
   * One time-ordered page of a device's commands and its own changes, newest first. The cursor
   * is the sort key of the last row returned (time, source, id), so a page boundary is the same
   * whichever source the last row came from. `outcome` and every actor kind but `device` select
   * commands; `actorKind: 'device'` selects the derived changes.
   */
  async list(input: ListTransitionsInput): Promise<TransitionPage> {
    assertOneFilter({
      capName: input.capName,
      actorKind: input.actorKind,
      outcome: input.outcome,
    })
    const after = input.cursor === undefined ? null : parseCursor(input.cursor)
    const wantCommands = input.actorKind !== 'device'
    const wantChanges =
      input.outcome === undefined && (input.actorKind === undefined || input.actorKind === 'device')
    const sources: AsyncIterable<Keyed>[] = []
    if (wantCommands) sources.push(this.commandRows(input, after))
    if (wantChanges) sources.push(await this.changeRows(input, after))
    const page = await takeMerged(sources, input.limit + 1)
    const rows = page.slice(0, input.limit)
    const last = rows[rows.length - 1]
    return {
      transitions: rows.map((r) => r.row),
      nextCursor: page.length > input.limit && last !== undefined ? cursorOf(last) : null,
    }
  }

  /** Stored commands, newest first, strictly after the cursor. */
  private async *commandRows(
    input: ListTransitionsInput,
    after: SortKey | null,
  ): AsyncGenerator<Keyed> {
    const handle = this.kind()
    // The cursor's own millisecond is read again (`lt` is exclusive) and cut below.
    const atTo = Math.min(
      input.atTo ?? Number.POSITIVE_INFINITY,
      after === null ? Infinity : after.at + 1,
    )
    const range = rangeOf({
      atFrom: input.atFrom,
      atTo: Number.isFinite(atTo) ? atTo : undefined,
    })
    let cursor: string | undefined
    for (;;) {
      const paging = {
        desc: true,
        limit: input.limit + 1,
        ...(cursor !== undefined ? { cursor } : {}),
      }
      const page =
        input.capName !== undefined
          ? await handle.query({
              where: {
                deviceId: input.deviceId,
                capName: input.capName,
                ...range,
              },
              ...paging,
            })
          : input.actorKind !== undefined
            ? await handle.query({
                where: {
                  deviceId: input.deviceId,
                  'actor.kind': input.actorKind,
                  ...range,
                },
                ...paging,
              })
            : input.outcome !== undefined
              ? await handle.query({
                  where: {
                    deviceId: input.deviceId,
                    outcome: input.outcome,
                    ...range,
                  },
                  ...paging,
                })
              : await handle.query({
                  deviceId: input.deviceId,
                  ...(input.atFrom !== undefined ? { atFrom: input.atFrom } : {}),
                  ...(atTo !== Infinity ? { atTo } : {}),
                  ...paging,
                })
      for (const record of page.records) {
        const keyed = commandKey(record.data)
        if (after === null || compareKeys(keyed.key, after) < 0) yield keyed
      }
      if (page.nextCursor === null) return
      cursor = page.nextCursor
    }
  }

  /** The device's derived changes, newest first, strictly after the cursor. */
  private async changeRows(
    input: ListTransitionsInput,
    after: SortKey | null,
  ): Promise<AsyncIterable<Keyed>> {
    const now = this.deps.clock()
    const changes = await this.deps.derived.read(input.deviceId, {
      from: input.atFrom ?? 0,
      to: Math.min(input.atTo ?? now, now),
      capName: input.capName,
    })
    const rows = changes
      .filter((c) => input.atTo === undefined || c.at < input.atTo)
      .filter((c) => input.atFrom === undefined || c.at >= input.atFrom)
      .map((c) => changeKey(input.deviceId, c))
      .toSorted((a, b) => compareKeys(b.key, a.key))
      .filter((k) => after === null || compareKeys(k.key, after) < 0)
    return (async function* () {
      for (const row of rows) yield row
    })()
  }

  /** The fleet page: stored commands only. A device's own changes are derived per device. */
  async listRecent(input: ListRecentInput): Promise<TransitionPage> {
    assertOneFilter({ actorKind: input.actorKind, outcome: input.outcome })
    if (input.actorKind === 'device') return { transitions: [], nextCursor: null }
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
    return {
      transitions: page.records.map((row) => row.data),
      nextCursor: page.nextCursor,
    }
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
    return {
      rows,
      lastWriteAt: this.lastWriteAt,
      refused: Object.fromEntries(this.refused),
    }
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
      deleted += await handle.deleteWhere({
        atBefore: Math.min(lo + DAY_MS, cutoff),
      })
      await yieldNow()
    }
    return deleted
  }

  /** The D865 hook body: how many transition rows the removal deleted. */
  async removeDevice(deviceId: number): Promise<number> {
    const counts = await this.deps.records.deleteDevice(deviceId, {
      kinds: ['device-transitions'],
    })
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
