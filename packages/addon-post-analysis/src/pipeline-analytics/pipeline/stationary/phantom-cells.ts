/**
 * Phantom-cell memory — the half that SURVIVES a track's death.
 *
 * ## The gap this fills
 *
 * The stationary registry does not answer this question. Its job is to decide
 * that an object IS parked and then suppress it; the dead ornamental grass on
 * device 101 produced tracks of 3.8 s, 4.1 s, 6.5 s and 19.0 s with 0–2.5 px of
 * total displacement, roughly fifteen a day, all at the same spot. Each one is
 * individually innocent. **The RECURRENCE is the signal**, and nothing survived
 * a track death to notice it.
 *
 * The registry now also decides on recurrence (`stationary-evidence.ts`), and
 * the two mechanisms remain separate on purpose: this one raises the BIRTH BAR
 * for a spawn in a suspect cell and forgets the cell the moment a real subject
 * moves through it; the evidence ledger creates a durable entry that
 * SUPPRESSES its object. A cell is a property of the scene; an entry is a
 * claim about a thing. Do not merge them.
 *
 * `noteShortMotionlessTrack` in `index.ts` was the MEASUREMENT half — it
 * counted, in RAM, and suppressed nothing, deliberately, so that "N closes in
 * what window" could be read off data instead of intuition. It has been read:
 * over 24 h the fleet showed **32 cells with ≥3 short-motionless closes, the
 * worst at 31**. This file is the memory half those numbers pay for.
 *
 * ## What it does, and what it refuses to do
 *
 * A cell is a coarse quantisation of a track's BIRTH point, per
 * `(device, class)`. Repeated short-motionless closes in one cell RAISE THE
 * SPAWN BAR there — the confirmation gate's `minConfidence` for a birth
 * candidate born inside it — and nothing else. It never closes a cell outright:
 * a raised bar still lets a real subject through, because a real subject
 * re-detects strongly in a native crop (the person floor alone is 0.65) while a
 * dead shrub read as a person does not.
 *
 * **`person` is included** (operator decision, 2026-08-20): a person motionless
 * for 30 s+ is furniture until they move, and the memory is released the moment
 * they do. Excluding the class would have exempted exactly the phantoms that
 * cost the most — a coat on a chair read as a person is the single most
 * expensive false positive this system produces.
 *
 * ## Two ways a cell forgets — and the second one is the point
 *
 * 1. **Time.** A close older than {@link PHANTOM_CELL_WINDOW_MS} is dropped
 *    from the count on the next touch; a cell whose closes all age out is
 *    deleted outright.
 * 2. **Movement.** A track born in a suspect cell that actually GOES SOMEWHERE
 *    clears it immediately ({@link PhantomCellRegistry.noteMovingClose}). This
 *    is the reactivation the operator asked for: the scenery reading applies
 *    only for as long as nothing there moves, and one real subject is enough to
 *    revoke it. Without this, a doorway that a delivery driver stands still in
 *    every morning would be suppressed forever on the strength of a plant that
 *    used to be there.
 *
 * The decisions here are PURE; {@link PhantomCellRegistry} owns the state and
 * the durable mirror.
 */

import type { IScopedLogger } from '@camstack/types'
import { DurableLedger, type DurableLedgerSpec } from '../../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../../durable/durable-wiring.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'

/**
 * Grid the birth point is quantised to, so respawns whose boxes never repeat to
 * the pixel still land in one cell. Carried over verbatim from the measurement
 * half — the 32-cell count was produced at this granularity, so changing it
 * would invalidate the number the thresholds below were chosen from.
 */
export const PHANTOM_CELL_PX = 32

/**
 * How long a cell remembers a close.
 *
 * 24 h, matching the window the live measurement was reported over ("32 cells
 * with ≥3 closes in 24 h, the worst at 31"). A shorter window would need the
 * thresholds re-derived from a distribution nobody has.
 */
export const PHANTOM_CELL_WINDOW_MS = 24 * 60 * 60_000

/**
 * Closes within the window before a cell is SUSPECT at all.
 *
 * 3, straight off the measured distribution: 32 cells clear it, and a real
 * subject that happens to pause briefly in one spot scores 1. Below this the
 * registry is completely inert — it is a counter and nothing more.
 */
export const PHANTOM_SUSPECT_MIN_CLOSES = 3

/** How much each close ABOVE the threshold adds to the spawn bar. */
export const PHANTOM_BAR_STEP = 0.1

/**
 * The highest the bar is ever raised.
 *
 * Deliberately below 1.0: a cell must never become impossible to be born in.
 * The worst measured cell (31 closes/24 h) sits here, and a genuine subject
 * standing in it still passes on a strong native re-detection.
 */
export const PHANTOM_BAR_CEILING = 0.9

/**
 * Cells retained per device before the least-recently-touched is dropped.
 *
 * A bound the geometry already implies (a 640x360 detection frame holds 20x12
 * cells per class), stated anyway: a camera producing phantoms continuously
 * must not decide how much of hub-main's heap this uses.
 */
const PHANTOM_MAX_CELLS_PER_DEVICE = 512

/** One remembered cell. `closes` are wall-clock ms, ascending. */
export interface PhantomCellRow {
  readonly key: string
  readonly deviceId: number
  readonly className: string
  /** `"<gx>,<gy>"` — the quantised birth point. */
  readonly cell: string
  readonly closes: readonly number[]
  readonly updatedAt: number
}

/** Quantise a birth point to its cell id. */
export function phantomCellId(x: number, y: number): string {
  return `${Math.round(x / PHANTOM_CELL_PX)},${Math.round(y / PHANTOM_CELL_PX)}`
}

/** The row key. Same shape the measurement half logged, so the two correlate. */
function phantomCellKey(deviceId: number, className: string, cell: string): string {
  return `${deviceId}:${className}:${cell}`
}

/** Closes still inside the window at `now`, ascending. */
export function pruneCloses(
  closes: readonly number[],
  now: number,
  windowMs: number = PHANTOM_CELL_WINDOW_MS,
): readonly number[] {
  return closes.filter((t) => now - t < windowMs && t <= now)
}

/**
 * The spawn bar for a cell with `closesInWindow` remembered closes.
 *
 * Monotonic, saturating, and never below the base — a cell can only ever make a
 * birth HARDER, never easier. Below {@link PHANTOM_SUSPECT_MIN_CLOSES} it is
 * exactly the base, so the whole mechanism is a no-op on a healthy scene.
 */
export function phantomSpawnBar(base: number, closesInWindow: number): number {
  if (closesInWindow < PHANTOM_SUSPECT_MIN_CLOSES) return base
  const steps = closesInWindow - PHANTOM_SUSPECT_MIN_CLOSES + 1
  // `max(base, ...)` OUTERMOST, deliberately. The other order lets the ceiling
  // LOWER an operator base already above it — a phantom cell would then make a
  // birth EASIER than a healthy one, which is the opposite of the whole file.
  return Math.max(base, Math.min(PHANTOM_BAR_CEILING, base + PHANTOM_BAR_STEP * steps))
}

/**
 * @durable class=ledger owner=pipeline-analytics
 *   write="a short-motionless track CLOSE in the cell (immediate); a movement close DELETES the row"
 *   retention="a close ages out of a 24h window on the next touch of its cell; a cell whose closes have all aged out is deleted, and a device is capped at 512 cells (least-recently-touched evicted). Never orphaned by track retention — a cell is a property of the SCENE, and the tracks that produced it are gone by construction."
 */
export const PHANTOM_CELLS_COLLECTION = 'pipeline-analytics:phantom-cells'

const PHANTOM_CELLS_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  { name: 'cell', type: 'TEXT' as const, notNull: true },
  { name: 'closes', type: 'JSON' as const },
  { name: 'updatedAt', type: 'INTEGER' as const },
] as const

const PHANTOM_CELLS_INDEXES = [
  { name: 'idx_phantom_cells_device', columns: ['deviceId'] as const },
] as const

export interface PhantomCellRegistryDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

const PHANTOM_CELLS_SPEC: DurableLedgerSpec<PhantomCellRow> = {
  collection: PHANTOM_CELLS_COLLECTION,
  columns: [...PHANTOM_CELLS_COLUMNS],
  indexes: [...PHANTOM_CELLS_INDEXES],
  writeMode: 'write-behind',
  keyOf: (row) => row.key,
  toValue: (row) => ({
    deviceId: row.deviceId,
    className: row.className,
    cell: row.cell,
    closes: [...row.closes],
    updatedAt: row.updatedAt,
  }),
  fromRecord: (key, data) => {
    const deviceId = data.deviceId
    const className = data.className
    const cell = data.cell
    const closes = data.closes
    const updatedAt = data.updatedAt
    if (typeof deviceId !== 'number' || typeof className !== 'string') return null
    if (typeof cell !== 'string' || !Array.isArray(closes)) return null
    const parsed = closes.filter((t): t is number => typeof t === 'number')
    return {
      key,
      deviceId,
      className,
      cell,
      closes: parsed,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    }
  },
  deviceIdOf: (row) => row.deviceId,
}

/** What a close looked like, from the registry's point of view. */
export interface PhantomCloseInput {
  readonly deviceId: number
  readonly className: string
  readonly trackId: string
  /** The track's FIRST observed position — the birth point. */
  readonly x: number
  readonly y: number
  readonly now: number
}

/** A birth candidate's cell lookup. */
export interface PhantomBarInput {
  readonly deviceId: number
  readonly className: string
  /** Birth-candidate box origin, detection-frame pixels. */
  readonly x: number
  readonly y: number
  readonly base: number
  readonly now: number
}

/** The bar a cell imposes, plus what it was imposed on. */
export interface PhantomBarResult {
  readonly bar: number
  readonly raised: boolean
  readonly cell: string
  readonly closesInWindow: number
}

/**
 * The durable cell memory. Reads answer from RAM only (D49) — a gate that
 * consulted SQLite would be a gate that fails when SQLite is slow.
 */
export class PhantomCellRegistry {
  private readonly ledger: DurableLedger<PhantomCellRow>
  private readonly logger: IScopedLogger

  constructor(deps: PhantomCellRegistryDeps) {
    this.logger = deps.logger
    this.ledger = new DurableLedger({
      spec: PHANTOM_CELLS_SPEC,
      kind: deps.records.kind(pipelineAnalyticsRecordKinds['phantom-cells']),
      logger: deps.logger,
    })
  }

  /** Boot reseed. Returns how many cells came back — "loaded 0" after a
   *  container recreate is the one line that explains a silent regression. */
  async load(): Promise<number> {
    const rows = await this.ledger.load()
    return rows.length
  }

  /**
   * Record ONE short-motionless close. Returns the cell's count inside the
   * window AFTER this close.
   */
  async noteMotionlessClose(input: PhantomCloseInput): Promise<PhantomBarResult> {
    const cell = phantomCellId(input.x, input.y)
    const key = phantomCellKey(input.deviceId, input.className, cell)
    const held = this.ledger.get(key)
    const closes = [...pruneCloses(held?.closes ?? [], input.now), input.now]
    await this.ledger.put({
      key,
      deviceId: input.deviceId,
      className: input.className,
      cell,
      closes,
      updatedAt: input.now,
    })
    await this.capDevice(input.deviceId)
    return {
      bar: phantomSpawnBar(0, closes.length),
      raised: closes.length >= PHANTOM_SUSPECT_MIN_CLOSES,
      cell,
      closesInWindow: closes.length,
    }
  }

  /**
   * A track born in this cell actually MOVED. Forget the cell.
   *
   * The reactivation half. Returns `true` when something was forgotten, so the
   * caller can say so out loud — a suppression that lifts silently is as hard
   * to explain as one that starts silently.
   */
  async noteMovingClose(input: {
    readonly deviceId: number
    readonly className: string
    readonly x: number
    readonly y: number
  }): Promise<boolean> {
    const cell = phantomCellId(input.x, input.y)
    const key = phantomCellKey(input.deviceId, input.className, cell)
    if (!this.ledger.has(key)) return false
    await this.ledger.forget(key)
    return true
  }

  /**
   * The spawn bar for a birth candidate. Pure RAM, synchronous by design: a
   * birth decision may never wait on, or be changed by, a fallible read.
   */
  spawnBar(input: PhantomBarInput): PhantomBarResult {
    const cell = phantomCellId(input.x, input.y)
    const key = phantomCellKey(input.deviceId, input.className, cell)
    const held = this.ledger.get(key)
    const closesInWindow = pruneCloses(held?.closes ?? [], input.now).length
    const bar = phantomSpawnBar(input.base, closesInWindow)
    return { bar, raised: bar > input.base, cell, closesInWindow }
  }

  /** Cells currently remembered for a device (diagnostics + the cap). */
  cellsForDevice(deviceId: number): readonly PhantomCellRow[] {
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
    if (rows.length <= PHANTOM_MAX_CELLS_PER_DEVICE) return
    const doomed = [...rows]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, rows.length - PHANTOM_MAX_CELLS_PER_DEVICE)
    for (const row of doomed) await this.ledger.forget(row.key)
    this.logger.info('phantom cells capped', {
      tags: { deviceId },
      meta: { evicted: doomed.length, cap: PHANTOM_MAX_CELLS_PER_DEVICE },
    })
  }
}
