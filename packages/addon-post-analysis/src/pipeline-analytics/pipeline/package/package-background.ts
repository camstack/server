/**
 * Package background memory — durable suppression of a position that keeps
 * "delivering" itself with nobody ever collecting anything.
 *
 * ## The gap this fills
 *
 * The area ceiling (`package-area-gate.ts`) kills device 101's streetlight
 * wedge by SIZE, and the activity gate (`package-stillness-tracker.ts`) kills
 * it by "no courier ever precedes it". Both are per-sighting decisions with no
 * memory: an FP that happens to be parcel-SIZED and happens to co-occur with a
 * passer-by clears both, every night, forever. What identifies it is the
 * RECURRENCE — delivered→vanished cycles at one bbox with never a real
 * pick-up — and recurrence needs state that survives the candidate (and the
 * process). The wedge measured ~23 such cycles a night at IoU ≈ 0.98.
 *
 * ## What it does, and what it refuses to do
 *
 * A cell is a coarse quantisation of the candidate bbox CENTROID per
 * `(device, class)` — same 32 px grid as the phantom-cell memory
 * (`pipeline/stationary/phantom-cells.ts`), whose style and durability this
 * file mirrors (D204). A GHOST CYCLE — a promoted package whose delivery was
 * emitted and whose box then vanished with nobody around — increments the
 * cell. At {@link PACKAGE_BACKGROUND_MIN_CYCLES} inside the window the cell is
 * BACKGROUND: promotions there are suppressed (and say so in the log).
 *
 * Two ways a cell forgets, and the second is the point:
 *
 *  1. **Time** — cycles age out of {@link PACKAGE_BACKGROUND_WINDOW_MS}.
 *  2. **A real pick-up** — somebody actually collected from that spot
 *     ({@link PackageBackgroundRegistry.noteRealPickup}): the position is a
 *     genuine delivery spot and the memory is wrong. One real collection
 *     revokes it entirely.
 *
 * D62: this registry is the single authority for "this position is package
 * background"; nothing else stores or mirrors that fact. Reads answer from RAM
 * only (D49) — the promotion path never waits on SQLite.
 */

import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../../durable/durable-wiring.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import { phantomCellId } from '../stationary/phantom-cells.js'

/**
 * Ghost delivered→vanished cycles inside the window before a cell is
 * background. 3: the wedge produced ~23 a night, a genuine parcel produces at
 * most ONE (and that one ends in a real pick-up, which clears the cell).
 */
export const PACKAGE_BACKGROUND_MIN_CYCLES = 3

/**
 * How long a cell remembers a ghost cycle. 7 days, wider than the phantom
 * cells' 24 h on purpose: a light-artefact FP fires only under the conditions
 * that create it (this one: night, lamp on), so its cycles can arrive slowly —
 * 1–2 per dusk would never reach 3 inside 24 h.
 */
export const PACKAGE_BACKGROUND_WINDOW_MS = 7 * 24 * 60 * 60_000

/** Cells retained per device (LRU-evicted past this). A 640×360 frame is
 *  20×12 cells; a camera cycling everywhere must not own the heap. */
const PACKAGE_BACKGROUND_MAX_CELLS_PER_DEVICE = 128

/** One remembered cell. `cycles` are wall-clock ms, ascending. */
export interface PackageBackgroundRow {
  readonly key: string
  readonly deviceId: number
  readonly className: string
  /** `"<gx>,<gy>"` — the quantised candidate centroid. */
  readonly cell: string
  readonly cycles: readonly number[]
  readonly updatedAt: number
}

/** The row key. */
function packageBackgroundKey(deviceId: number, className: string, cell: string): string {
  return `${deviceId}:${className}:${cell}`
}

/** Cycles still inside the window at `now`, ascending. */
function pruneCycles(cycles: readonly number[], now: number): readonly number[] {
  return cycles.filter((t) => now - t < PACKAGE_BACKGROUND_WINDOW_MS && t <= now)
}

/**
 * @durable class=ledger owner=pipeline-analytics
 *   write="a GHOST package cycle at the cell (delivered, then vanished with nobody around) — immediate; a REAL pick-up at the cell DELETES the row"
 *   retention="a cycle ages out of a 7-day window on the next touch of its cell; a cell whose cycles have all aged out answers not-background and is rewritten on the next cycle; a device is capped at 128 cells (least-recently-touched evicted). Never orphaned by track retention — the cell describes the SCENE."
 */
export const PACKAGE_BACKGROUND_COLLECTION = 'pipeline-analytics:package-background'

const PACKAGE_BACKGROUND_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  { name: 'cell', type: 'TEXT' as const, notNull: true },
  { name: 'cycles', type: 'JSON' as const },
  { name: 'updatedAt', type: 'INTEGER' as const },
] as const

const PACKAGE_BACKGROUND_INDEXES = [
  { name: 'idx_package_background_device', columns: ['deviceId'] as const },
] as const

export interface PackageBackgroundRegistryDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

const PACKAGE_BACKGROUND_SPEC: DurableLedgerSpec<PackageBackgroundRow> = {
  collection: PACKAGE_BACKGROUND_COLLECTION,
  columns: [...PACKAGE_BACKGROUND_COLUMNS],
  indexes: [...PACKAGE_BACKGROUND_INDEXES],
  writeMode: 'write-behind',
  keyOf: (row) => row.key,
  toValue: (row) => ({
    deviceId: row.deviceId,
    className: row.className,
    cell: row.cell,
    cycles: [...row.cycles],
    updatedAt: row.updatedAt,
  }),
  fromRecord: (key, data) => {
    const deviceId = data['deviceId']
    const className = data['className']
    const cell = data['cell']
    const cycles = data['cycles']
    const updatedAt = data['updatedAt']
    if (typeof deviceId !== 'number' || typeof className !== 'string') return null
    if (typeof cell !== 'string' || !Array.isArray(cycles)) return null
    const parsed = cycles.filter((t): t is number => typeof t === 'number')
    return {
      key,
      deviceId,
      className,
      cell,
      cycles: parsed,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    }
  },
  deviceIdOf: (row) => row.deviceId,
}

/** A completed ghost cycle, from the caller's point of view. `x`/`y` is the
 *  candidate bbox CENTROID in detection-frame pixels. */
export interface PackageCycleInput {
  readonly deviceId: number
  readonly className: string
  readonly x: number
  readonly y: number
  readonly now: number
}

/** The cell's answer after a ghost cycle was recorded. */
export interface PackageCycleResult {
  readonly cell: string
  readonly cyclesInWindow: number
  /** Whether the cell is now at/above the background threshold. */
  readonly background: boolean
}

/** A promotion-time lookup. */
export interface PackageBackgroundQuery {
  readonly deviceId: number
  readonly className: string
  readonly x: number
  readonly y: number
  readonly now: number
}

export interface PackageBackgroundVerdict {
  readonly background: boolean
  readonly cell: string
  readonly cyclesInWindow: number
}

/**
 * The durable ghost-cycle memory. Reads answer from RAM only (D49); writes go
 * write-behind — a lost write costs one under-counted cycle, which is the
 * direction this must fail in.
 */
export class PackageBackgroundRegistry {
  private readonly ledger: DurableLedger<PackageBackgroundRow>
  private readonly logger: IScopedLogger

  constructor(deps: PackageBackgroundRegistryDeps) {
    this.logger = deps.logger
    this.ledger = new DurableLedger({
      spec: PACKAGE_BACKGROUND_SPEC,
      kind: deps.records.kind(pipelineAnalyticsRecordKinds['package-background']),
      logger: deps.logger,
    })
  }

  /** Boot reseed. Returns how many cells came back — "loaded 0" after a
   *  container recreate is the line that explains a returned FP loop. */
  async load(): Promise<number> {
    const rows = await this.ledger.load()
    return rows.length
  }

  /** Record ONE ghost cycle (delivered, then vanished with nobody around). */
  async noteGhostCycle(input: PackageCycleInput): Promise<PackageCycleResult> {
    const cell = phantomCellId(input.x, input.y)
    const key = packageBackgroundKey(input.deviceId, input.className, cell)
    const held = this.ledger.get(key)
    const cycles = [...pruneCycles(held?.cycles ?? [], input.now), input.now]
    await this.ledger.put({
      key,
      deviceId: input.deviceId,
      className: input.className,
      cell,
      cycles,
      updatedAt: input.now,
    })
    await this.capDevice(input.deviceId)
    return {
      cell,
      cyclesInWindow: cycles.length,
      background: cycles.length >= PACKAGE_BACKGROUND_MIN_CYCLES,
    }
  }

  /**
   * Somebody actually collected from this spot. Forget the cell — a real
   * pick-up proves the position is a genuine delivery spot. Returns `true`
   * when something was forgotten, so the caller can say so out loud.
   */
  async noteRealPickup(input: {
    readonly deviceId: number
    readonly className: string
    readonly x: number
    readonly y: number
  }): Promise<boolean> {
    const cell = phantomCellId(input.x, input.y)
    const key = packageBackgroundKey(input.deviceId, input.className, cell)
    if (!this.ledger.has(key)) return false
    await this.ledger.forget(key)
    return true
  }

  /**
   * Is this position package background? Pure RAM, synchronous by design: a
   * promotion decision may never wait on, or be changed by, a fallible read.
   */
  isBackground(query: PackageBackgroundQuery): PackageBackgroundVerdict {
    const cell = phantomCellId(query.x, query.y)
    const key = packageBackgroundKey(query.deviceId, query.className, cell)
    const held = this.ledger.get(key)
    const cyclesInWindow = pruneCycles(held?.cycles ?? [], query.now).length
    return {
      background: cyclesInWindow >= PACKAGE_BACKGROUND_MIN_CYCLES,
      cell,
      cyclesInWindow,
    }
  }

  /** Cells currently remembered for a device (diagnostics + the cap). */
  cellsForDevice(deviceId: number): readonly PackageBackgroundRow[] {
    return this.ledger.snapshot().filter((r) => r.deviceId === deviceId)
  }

  get size(): number {
    return this.ledger.size
  }

  /** Drop a device's memory wholesale (camera removed / analytics reset). */
  async clearDevice(deviceId: number): Promise<void> {
    for (const row of this.cellsForDevice(deviceId)) await this.ledger.forget(row.key)
  }

  /** Evict the least-recently-touched cells of a device past the cap. */
  private async capDevice(deviceId: number): Promise<void> {
    const rows = this.cellsForDevice(deviceId)
    if (rows.length <= PACKAGE_BACKGROUND_MAX_CELLS_PER_DEVICE) return
    const doomed = [...rows]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, rows.length - PACKAGE_BACKGROUND_MAX_CELLS_PER_DEVICE)
    for (const row of doomed) await this.ledger.forget(row.key)
    this.logger.info('package background cells capped', {
      tags: { deviceId },
      meta: {
        evicted: doomed.length,
        cap: PACKAGE_BACKGROUND_MAX_CELLS_PER_DEVICE,
      },
    })
  }
}
