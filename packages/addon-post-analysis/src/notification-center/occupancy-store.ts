/**
 * OccupancyStore — durable confirmed occupancy edge-state (design
 * `2026-07-24-nc-occupancy-timelapse-design.md`, task A3).
 *
 * A records kind (`occupancy`) mirrored into an in-RAM cache through
 * `DurableLedger`, on every node. {@link OccupancyStore.declare} declares the
 * LEGACY table, for specs and migration scripts only — no boot calls it.
 *
 * Boot reseed (durability contract, `OccupancyWatcher.hydrate`): a confirmed
 * `{ confirmedCount, occupied, lastChangeAt }` level persisted before a restart
 * is returned verbatim by a fresh store's {@link OccupancyStore.load}, so the
 * watcher re-observes the SAME level and emits no re-fired edge — while a
 * genuine post-restart transition still fires. Pending (in-flight) edges are
 * intentionally never persisted; they re-open naturally on the next snapshots.
 *
 * Bounded row count: the durable set is per-(device, zone, class) key, which is
 * bounded by the WATCHED rule set — but a key stops being watched when its rule
 * is deleted/edited. {@link OccupancyStore.pruneExcept} drops the rows whose key
 * is no longer active so the collection cannot grow without bound.
 *
 * The column schema stores only the durable scalars (`key` PK + `deviceId` idx +
 * counts/timestamps); `zoneId`/`className`/`threshold` are derived from the key
 * on load via {@link parseOccupancyKey} (the key grammar's single decode site),
 * keeping the persisted row and the watcher's `OccupancyStateRow` losslessly
 * isomorphic. The key's trailing `t<n>` threshold marker makes a legacy
 * three-segment (pre-amendment) row self-identifying: it is rejected on parse
 * and skipped, never mis-hydrated.
 *
 * ## Where the mechanics live
 *
 * Declare / mirror / reseed / prune are {@link DurableLedger}'s (`../durable/`),
 * extracted from the liveness ledger once the census found five copies of them.
 * What stays here is the part only occupancy knows: the key grammar, the
 * write-THROUGH direction (a phantom in-RAM confirmed level would re-fire an
 * edge — worse than a retry), and the fact that the watcher, not this store,
 * owns the cold-seed rule.
 */

import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../durable/durable-ledger.js'
import { type DurableKindDeps } from '../durable/durable-wiring.js'
import { ncDurableRecordKinds } from './nc-durable-record-kinds.js'
import {
  parseOccupancyKey,
  type OccupancyKey,
  type OccupancyStateRow,
} from './occupancy-watcher.js'

/**
 * @durable class=ledger owner=notification-center
 *   write="a CONFIRMED occupancy level flip (debounced edge commit), write-through"
 *   retention="pruneExcept(activeKeys) every 30 s — bounded by the WATCHED rule key set, never by age"
 */
const NC_OCCUPANCY_COLLECTION = 'notification-center:occupancy'

const NC_OCCUPANCY_COLUMNS = [
  { name: 'key', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'confirmedCount', type: 'INTEGER' as const, notNull: true },
  { name: 'occupied', type: 'BOOLEAN' as const, notNull: true },
  { name: 'lastChangeAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
] as const

const NC_OCCUPANCY_INDEXES = [
  { name: 'idx_nc_occupancy_device', columns: ['deviceId'] as const },
] as const

export interface OccupancyStoreDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

/**
 * The mechanics, declared once.
 *
 * `write-through` is the load-bearing choice and it differs from the liveness
 * ledger's: a confirmed occupancy LEVEL that exists only in RAM would, after a
 * restart, be re-observed as a transition and re-fire an edge the operator has
 * already been told about. The store therefore goes first, and a failed write
 * is a throw the caller retries — never a phantom level.
 *
 * There is no `equalFact`: this store never judges. The watcher owns the
 * "an edge needs two observed snapshots" rule (`seedState`), and it decides
 * what to persist; the store only records what it is handed.
 */
const NC_OCCUPANCY_SPEC: DurableLedgerSpec<OccupancyStateRow> = {
  collection: NC_OCCUPANCY_COLLECTION,
  columns: NC_OCCUPANCY_COLUMNS,
  indexes: NC_OCCUPANCY_INDEXES,
  writeMode: 'write-through',
  keyOf: (row) => row.key,
  toValue: rowToValue,
  fromRecord: recordToRow,
  deviceIdOf: (row) => row.deviceId,
}

export class OccupancyStore {
  private readonly ledger: DurableLedger<OccupancyStateRow>
  private readonly logger: IScopedLogger

  constructor(deps: OccupancyStoreDeps) {
    this.logger = deps.logger
    this.ledger = new DurableLedger({
      spec: NC_OCCUPANCY_SPEC,
      kind: deps.records.kind(ncDurableRecordKinds.occupancy),
      logger: deps.logger,
    })
  }

  /**
   * Reseed the confirmed edge-state from the store (boot) — replaces the cache
   * wholesale and returns the rows for {@link OccupancyWatcher.hydrate}. A row
   * whose scalars/key no longer parse is skipped with a warning (a degraded row
   * must never crash the reseed). Best-effort: a store error yields the rows
   * already mirrored — nothing at boot, i.e. a cold watcher — never a throw.
   */
  async load(): Promise<readonly OccupancyStateRow[]> {
    const rows = await this.ledger.load()
    this.logger.debug('occupancy state loaded', { meta: { keys: rows.length } })
    return rows
  }

  /** Drop a deleted device's mirrored rows (the durable ones go by `deleteWhere`, D871). */
  evictDevice(deviceId: number): number {
    return this.ledger.evictDevice(deviceId)
  }

  /** The in-RAM confirmed-state mirror (post-{@link load}/{@link persist}). */
  snapshot(): readonly OccupancyStateRow[] {
    return this.ledger.snapshot()
  }

  /**
   * Durably upsert one confirmed edge-state row (write-through: the store FIRST,
   * then the mirror — a failed persist never leaves a phantom in-RAM level). The
   * `key` is the PK, so re-persisting a key advances it in place.
   */
  persist(row: OccupancyStateRow): Promise<void> {
    return this.ledger.put(row)
  }

  /**
   * Prune every persisted key NOT in `activeKeys` (the currently watched set) —
   * the bounded-row-count guarantee when rules stop watching a key. Returns the
   * number of rows dropped. Best-effort per row: a failed delete is logged and
   * the key retained (retried next prune) rather than aborting the sweep.
   *
   * The active set here is AUTHORITATIVE (it is recomputed from the enabled
   * rules the centre already holds in RAM), which is what makes a prune legal
   * at all — see the primitive's note on D130.
   */
  pruneExcept(activeKeys: ReadonlySet<OccupancyKey>): Promise<number> {
    return this.ledger.pruneExcept(activeKeys)
  }
}

/** The persisted column map for a row (the `key` PK is passed separately). */
function rowToValue(row: OccupancyStateRow): Record<string, unknown> {
  return {
    deviceId: row.deviceId,
    confirmedCount: row.confirmedCount,
    occupied: row.occupied,
    lastChangeAt: row.lastChangeAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Structurally validate a persisted record and reconstruct the full
 * {@link OccupancyStateRow} (deriving `zoneId`/`className`/`threshold` from the
 * key). Returns `null` for any malformed row — including a legacy
 * three-segment key with no `t<n>` threshold marker, which
 * {@link parseOccupancyKey} rejects — so the caller skips it (cold re-observe)
 * rather than hydrating a mis-parsed scope.
 */
function recordToRow(key: string, data: Record<string, unknown>): OccupancyStateRow | null {
  const scope = parseOccupancyKey(key)
  if (scope === null) return null
  const deviceId = Number(data['deviceId'])
  const confirmedCount = Number(data['confirmedCount'])
  const lastChangeAt = Number(data['lastChangeAt'])
  const updatedAt = Number(data['updatedAt'])
  if (
    !Number.isFinite(deviceId) ||
    !Number.isFinite(confirmedCount) ||
    !Number.isFinite(lastChangeAt) ||
    !Number.isFinite(updatedAt)
  ) {
    return null
  }
  // BOOLEAN round-trips as a real boolean (real backend) or a 0/1 int (defensive).
  const rawOccupied = data['occupied']
  const occupied = rawOccupied === true || rawOccupied === 1
  return {
    key,
    deviceId,
    ...(scope.zoneId !== undefined ? { zoneId: scope.zoneId } : {}),
    ...(scope.className !== undefined ? { className: scope.className } : {}),
    threshold: scope.threshold,
    confirmedCount,
    occupied,
    lastChangeAt,
    updatedAt,
  }
}
