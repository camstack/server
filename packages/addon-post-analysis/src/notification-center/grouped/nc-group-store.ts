/**
 * The group RECORD — one row per burst, so a group is a thing that happened
 * rather than a sentence that was once sent.
 *
 * ## Why a row at all, when Phase 1 needs none
 *
 * The open windows (`NcGroupedWindowBuffer`) are RAM and need nothing
 * durable of their own (a respawn replays them from the persisted events, D692 §5). This table exists for a different reader — the timeline
 * card. The operator asked for **one expandable card per group**, and a card
 * needs something to be a card OF: a key, when it opened, who was in it, and
 * whether it is over. Deriving that on every read from a buffer that only
 * exists while the process is up is not a thing a timeline can do.
 *
 * It is deliberately the LIGHT half of a different question: id, rule, camera,
 * member track ids, the timestamps and `sealed`. No representative frame, no
 * anchor pixels, no clustering verdict.
 *
 * ## Two tables, two questions — they coexist
 *
 * `notification-center:track-groups` records a **BURST**: the set of subjects a
 * notification rule merged into one message on one camera, keyed by
 * `(ruleId, deviceId)`, decided by temporal chaining alone with no geometry,
 * and existing so a delivered notification has a record. It is rule-scoped, it
 * owns no pixels, and it is ring-bounded by count.
 *
 * `pipeline-analytics:track-groups` records a **CO-MOVING GROUP**: a spatial
 * partition of one session's eligible tracks, decided by proximity and motion,
 * not rule-scoped, owning a picture of its own, and cascading from its members.
 *
 * They are different questions about the same tracks. One burst may contain
 * several groups; one group may span two bursts of two different rules, or
 * none at all. Neither is derivable from the other, and neither replaces the
 * other.
 *
 * ## Retention, and why it is bounded by COUNT
 *
 * A burst must not outlive the tracks it names (D61). This table has no
 * membership cascade of its own, so the bound here is a RING: the newest
 * {@link NC_GROUP_MAX_ROWS_PER_DEVICE} groups per camera, pruned on write.
 * Bounded by count, never by age.
 *
 * ## Since D692: one row per grouped WINDOW
 *
 * A grouped rule's window is the unit of record. The row is written at OPEN
 * (`sealed:false`, nothing decided) and SEALED at close with the `outcome`
 * (`sent` or `dropped`), the `closeReason`, every member's fate and `waitedMs`,
 * so "why did my grouped rule say nothing at 14:02" is answerable from a durable
 * record as well as from the log. A row a D143 burst wrote before its removal reads back
 * with the new columns empty (`revision` is kept NOT NULL and is `1` on a window row).
 */

import type { IScopedLogger, RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import type { DurableLedgerBody } from '../../durable/durable-record-body.js'
import type { DurableKindDeps } from '../../durable/durable-wiring.js'
import { collectRecordPages, RANGE_FLOOR } from '../../durable/query-pages.js'
import { ncDurableRecordKinds } from '../nc-durable-record-kinds.js'
import type { NcGroupedCloseReason, NcGroupedWindow } from './grouped-window-buffer.js'

/**
 * @durable class=audit owner=notification-center database=events
 *   write="one row per grouped window (D692): written at OPEN, sealed at CLOSE with the outcome and each member's fate; best-effort"
 *   retention="ring — the newest NC_GROUP_MAX_ROWS_PER_DEVICE rows per device, pruned on write; never age-keyed"
 */
export const NC_GROUPS_COLLECTION = 'notification-center:track-groups'

/**
 * The ring bound. Generous — a row is a few hundred bytes (up to ~2 KB for a sealed window
 * of 24 members with their fates) and this is a read surface.
 */
export const NC_GROUP_MAX_ROWS_PER_DEVICE = 500

/** What became of a window: a message left, or nobody was told. */
export type NcGroupOutcome = 'sent' | 'dropped'

/**
 * Why a row was sealed: a window's own close reason, or `orphaned-at-start` — the boot
 * sweep found the row still open although no process holds its window (a D143 burst row
 * from before the removal, or a window whose process crashed).
 */
export type NcGroupRowCloseReason = NcGroupedCloseReason | typeof NC_GROUP_ORPHANED_AT_START

const NC_GROUP_ORPHANED_AT_START = 'orphaned-at-start' as const

/**
 * A member's fate. `sent` is in the message; a drop reason is the close pass's
 * (`NcGroupedDropReason`); the rest name why a whole window said nothing although the pass
 * kept the member. ONE schema serves the record reader and the `nc.listTrackGroups`
 * action (review T9b L-6); every drop reason must stay assignable to it, which the close
 * pass's fate mapping in `index.ts` checks at compile time.
 */
export const NcGroupMemberFateSchema = z.union([
  z.enum([
    'sent',
    'recognition-not-final',
    'recognised-out-of-scope',
    'already-notified',
    'fused-into-notified',
    'muted',
    'snoozed',
    'no-target',
    'rule-removed',
    'rule-disabled',
    'already-existed',
    'close-failed',
    // D706: the alarm notification speaks for the member (`alarm-push-policy.ts`).
    'alarm-entry-delay-started',
    'alarm-entry-delay',
    // D735: the member's sensor is excluded by the current arm.
    'alarm-sensor-excluded',
    // The operator bypassed the member's (rule, input) until disarm.
    'alarm-input-bypassed',
  ]),
  z.templateLiteral(['failed-condition:', z.string()]),
])
export type NcGroupMemberFate = z.infer<typeof NcGroupMemberFateSchema>

export interface NcGroupMemberRecord {
  readonly trackId: string
  readonly className: string
  readonly fate: NcGroupMemberFate
}

/** What a close decided — everything the SEAL adds to the open row. */
export interface NcGroupSeal {
  readonly closedAt: number
  readonly outcome: NcGroupOutcome
  readonly closeReason: NcGroupedCloseReason
  readonly members: readonly NcGroupMemberRecord[]
}

/** How the record reads back — the shape the `nc.listTrackGroups` action returns. */
export interface NcGroupRecord {
  readonly id: string
  readonly ruleId: string
  readonly deviceId: number
  readonly openedAt: number
  readonly lastGrowthAt: number
  readonly memberTrackIds: readonly string[]
  readonly memberCount: number
  readonly revision: number
  readonly sealed: boolean
  /** Sealed rows only. */
  readonly closedAt?: number
  readonly outcome?: NcGroupOutcome
  readonly closeReason?: NcGroupRowCloseReason
  readonly members?: readonly NcGroupMemberRecord[]
  readonly waitedMs?: number
}

export interface NcGroupStoreDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

export interface NcGroupQuery {
  readonly deviceId?: number
  readonly ruleId?: string
  readonly since?: number
  readonly limit?: number
}

/** Read cap, so a client cannot ask for the whole ring in one call. */
const MAX_QUERY_LIMIT = 200

export class NcGroupStore {
  /** The `track-groups` records kind (events.db). */
  private readonly rows: RecordKindHandle<DurableLedgerBody>
  private readonly logger: IScopedLogger
  /**
   * The OPEN write of every window whose row may not have landed yet. The SEAL is chained
   * behind it (fresh review L-7): a close that follows its open at once must not be
   * overwritten by the slower, older open write.
   */
  private readonly opens = new Map<string, Promise<void>>()
  /** Every SEAL write still in flight — what {@link flush} waits for (review T9b M-2). */
  private readonly seals = new Set<Promise<void>>()
  /** Writes since the last prune, per device — the ring is trimmed lazily. */
  private readonly writesSincePrune = new Map<number, number>()

  constructor(deps: NcGroupStoreDeps) {
    this.rows = deps.records.kind(ncDurableRecordKinds['track-groups'])
    this.logger = deps.logger
  }

  /**
   * D692: the row of a window that just OPENED — `sealed:false`, nothing decided. Not
   * awaited by the caller (the evaluation chain); best-effort like every write here.
   */
  recordOpen(window: NcGroupedWindow): Promise<void> {
    const write = this.write(window.key, window.deviceId, windowValue(window, undefined))
    const pending = write.finally(() => {
      if (this.opens.get(window.key) === pending) this.opens.delete(window.key)
    })
    this.opens.set(window.key, pending)
    return pending
  }

  /**
   * D692: SEAL a window's row with what the close decided. Writes the whole row (the
   * window is in hand), so a window that never had an open row — the tester's — is
   * recorded all the same; it waits for the open write of its own key, if one is in flight.
   */
  recordSealed(window: NcGroupedWindow, seal: NcGroupSeal): Promise<void> {
    const pending = (async (): Promise<void> => {
      await this.opens.get(window.key)
      await this.write(window.key, window.deviceId, windowValue(window, seal))
    })().finally(() => {
      this.seals.delete(pending)
    })
    this.seals.add(pending)
    return pending
  }

  /**
   * Wait for every seal (and open) write in flight (review T9b M-2). The shutdown close
   * awaits it INSIDE its 2 s bound: a window the stop sent must not be left `sealed:false`
   * forever because the process went away before its best-effort seal landed. Never
   * rejects — each write already owns its failure.
   */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.seals, ...this.opens.values()])
  }

  private async write(
    key: string,
    deviceId: number,
    value: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.rows.put({ id: key, deviceId, data: value })
      await this.pruneIfDue(deviceId)
    } catch (err) {
      this.logger.warn('group record write failed', {
        tags: { deviceId },
        meta: { groupKey: key, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Boot sweep (review T17 L-5): seal every row that still reads `sealed:false`.
   *
   * Called ONCE, before the evaluation opens and before the replay runs, so every open row
   * it finds is an orphan — a clean stop seals the live windows, and a replayed window
   * re-opens by key afterwards (its {@link recordOpen} overwrites the row, so a window the
   * replay brings back reads open again). Each row is rewritten whole with `sealed` and
   * `closeReason` the only changes: no outcome, no members — nobody decided anything.
   *
   * Never throws and never blocks the start: a failed read or write is a WARN and the
   * boot goes on (the row stays open, which is the pre-sweep behaviour, not a new fault).
   * One summary line, not one per row — the per-device split rides `byDevice`.
   */
  async sealOrphans(): Promise<void> {
    const sealed = new Map<number, number>()
    const failed = new Map<number, number>()
    try {
      const { rows } = await collectRecordPages(
        this.rows,
        { where: { sealed: false } },
        ORPHAN_SWEEP_LIMIT,
      )
      for (const row of rows) {
        const rawDevice = row.data['deviceId']
        const deviceId = typeof rawDevice === 'number' ? rawDevice : 0
        try {
          await this.rows.put({
            id: row.id,
            ...(deviceId > 0 ? { deviceId } : {}),
            data: { ...row.data, sealed: true, closeReason: NC_GROUP_ORPHANED_AT_START },
          })
          sealed.set(deviceId, (sealed.get(deviceId) ?? 0) + 1)
        } catch (err) {
          failed.set(deviceId, (failed.get(deviceId) ?? 0) + 1)
          this.logger.debug('group row orphan seal failed', {
            tags: { deviceId },
            meta: { groupKey: row.id, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    } catch (err) {
      this.logger.warn('group row sweep failed', {
        meta: { phase: 'read', error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const total = (m: ReadonlyMap<number, number>): number =>
      [...m.values()].reduce((a, b) => a + b, 0)
    if (total(failed) > 0) {
      this.logger.warn('group row sweep failed', {
        meta: {
          phase: 'write',
          failed: total(failed),
          byDevice: Object.fromEntries(failed),
          sealed: total(sealed),
        },
      })
    }
    if (total(sealed) > 0) {
      this.logger.info('group rows sealed at start', {
        meta: { sealed: total(sealed), byDevice: Object.fromEntries(sealed) },
      })
    }
  }

  /** Newest first. The timeline card's read. */
  async list(query: NcGroupQuery = {}): Promise<readonly NcGroupRecord[]> {
    try {
      // Each filter combination has an index ending in `openedAt`
      // (`nc-durable-record-kinds.ts`): the open time is the range and the order.
      const { records } = await this.rows.query({
        where: {
          ...(query.deviceId !== undefined ? { deviceId: query.deviceId } : {}),
          ...(query.ruleId !== undefined ? { ruleId: query.ruleId } : {}),
          openedAt: { gte: query.since ?? RANGE_FLOOR },
        },
        desc: true,
        limit: Math.min(query.limit ?? 50, MAX_QUERY_LIMIT),
      })
      return records.map((r) => rowToRecord(r.id, r.data))
    } catch (err) {
      this.logger.warn('group record read failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return []
    }
  }

  /**
   * Trim the ring for one camera, every {@link PRUNE_EVERY} writes.
   *
   * Lazy rather than per-write because the delete is a query + a bulk delete and
   * a busy camera writes several times per burst; amortising it keeps the write
   * path a single `set`.
   */
  private async pruneIfDue(deviceId: number): Promise<void> {
    const n = (this.writesSincePrune.get(deviceId) ?? 0) + 1
    if (n < PRUNE_EVERY) {
      this.writesSincePrune.set(deviceId, n)
      return
    }
    this.writesSincePrune.set(deviceId, 0)
    // The newest row PAST the ring is the cutoff. Records have no offset, so the
    // ring itself is read (500 rows, newest first) and the row after it kept.
    const { records } = await this.rows.query({
      where: { deviceId, openedAt: { gte: RANGE_FLOOR } },
      desc: true,
      limit: NC_GROUP_MAX_ROWS_PER_DEVICE + 1,
    })
    const tail = records[NC_GROUP_MAX_ROWS_PER_DEVICE]
    if (tail === undefined) return
    // Everything older than the ring's tail, by the SAME ordering the ring is
    // defined in — never "older than a timestamp", which would be an age sweep.
    const cutoff = tail.data['openedAt']
    if (typeof cutoff !== 'number') return
    const deleted = await this.rows.deleteWhere({
      where: { deviceId, openedAt: { gte: RANGE_FLOOR, lte: cutoff } },
    })
    if (deleted > 0) {
      this.logger.debug('group ring trimmed', {
        tags: { deviceId },
        meta: { deleted, keptPerDevice: NC_GROUP_MAX_ROWS_PER_DEVICE },
      })
    }
  }
}

const PRUNE_EVERY = 50

/** Open rows the boot sweep reads; a clean stop seals every live window, so this is orphans only. */
const ORPHAN_SWEEP_LIMIT = 10_000

function windowValue(
  window: NcGroupedWindow,
  seal: NcGroupSeal | undefined,
): Record<string, unknown> {
  return {
    ruleId: window.ruleId,
    deviceId: window.deviceId,
    openedAt: window.openedAt,
    lastGrowthAt: window.lastAdmittedAt,
    memberTrackIds: window.members.map((m) => m.trackId),
    memberCount: window.members.length,
    // Column kept (NOT NULL); a window has no revisions.
    revision: 1,
    sealed: seal !== undefined,
    ...(seal !== undefined
      ? {
          closedAt: seal.closedAt,
          outcome: seal.outcome,
          closeReason: seal.closeReason,
          members: seal.members,
          waitedMs: seal.closedAt - window.openedAt,
        }
      : {}),
  }
}

function rowToRecord(id: string, data: Record<string, unknown>): NcGroupRecord {
  const members = data['memberTrackIds']
  return {
    id,
    ruleId: typeof data['ruleId'] === 'string' ? data['ruleId'] : '',
    deviceId: typeof data['deviceId'] === 'number' ? data['deviceId'] : 0,
    openedAt: typeof data['openedAt'] === 'number' ? data['openedAt'] : 0,
    lastGrowthAt: typeof data['lastGrowthAt'] === 'number' ? data['lastGrowthAt'] : 0,
    memberTrackIds: Array.isArray(members) ? members.filter((m) => typeof m === 'string') : [],
    memberCount: typeof data['memberCount'] === 'number' ? data['memberCount'] : 0,
    revision: typeof data['revision'] === 'number' ? data['revision'] : 1,
    sealed: data['sealed'] === true,
    ...(typeof data['closedAt'] === 'number' ? { closedAt: data['closedAt'] } : {}),
    ...(data['outcome'] === 'sent' || data['outcome'] === 'dropped'
      ? { outcome: data['outcome'] }
      : {}),
    ...(isCloseReason(data['closeReason']) ? { closeReason: data['closeReason'] } : {}),
    ...(Array.isArray(data['members']) ? { members: data['members'].filter(isMemberRecord) } : {}),
    ...(typeof data['waitedMs'] === 'number' ? { waitedMs: data['waitedMs'] } : {}),
  }
}

function isCloseReason(value: unknown): value is NcGroupRowCloseReason {
  return (
    value === NC_GROUP_ORPHANED_AT_START ||
    value === 'all-final' ||
    value === 'deadline' ||
    value === 'shutdown' ||
    value === 'replayed' ||
    value === 'test'
  )
}

function isMemberRecord(value: unknown): value is NcGroupMemberRecord {
  if (value === null || typeof value !== 'object') return false
  const row = Object.fromEntries(Object.entries(value))
  return (
    typeof row['trackId'] === 'string' &&
    typeof row['className'] === 'string' &&
    NcGroupMemberFateSchema.safeParse(row['fate']).success
  )
}
