/**
 * Phantom-cell memory.
 *
 * The measurement half (`noteShortMotionlessTrack`) counted in RAM and
 * suppressed nothing, on purpose, so the thresholds here could be read off data
 * rather than intuition. The data: 32 cells with >=3 short-motionless closes in
 * 24 h, the worst at 31. Every constant below is pinned against those numbers.
 *
 * Each negative is proved against a CONTROL that must hold, so no assertion can
 * pass vacuously.
 */
import { withNcFaults } from '../../../../notification-center/__tests__/support/nc-test-deps.js'
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../__tests__/test-helpers.js'
import {
  PHANTOM_BAR_CEILING,
  PHANTOM_BAR_STEP,
  PHANTOM_CELL_PX,
  PHANTOM_CELL_WINDOW_MS,
  PHANTOM_SUSPECT_MIN_CLOSES,
  PhantomCellRegistry,
  phantomCellId,
  phantomSpawnBar,
  pruneCloses,
} from '../phantom-cells.js'

const T0 = 1_700_000_000_000
const BASE = 0.4

describe('phantom-cell geometry', () => {
  it('quantises birth points that never repeat to the pixel into ONE cell', () => {
    expect(phantomCellId(100, 200)).toBe(phantomCellId(100 + PHANTOM_CELL_PX / 4, 200))
    // CONTROL: a genuinely different place is a different cell.
    expect(phantomCellId(100, 200)).not.toBe(phantomCellId(100 + PHANTOM_CELL_PX * 2, 200))
  })

  it('drops closes older than the window, keeps the rest ordered', () => {
    const now = T0
    const closes = [now - PHANTOM_CELL_WINDOW_MS - 1, now - 1000, now]
    expect(pruneCloses(closes, now)).toEqual([now - 1000, now])
  })
})

describe('phantomSpawnBar', () => {
  it('is INERT below the suspect threshold — a healthy scene is untouched', () => {
    for (let n = 0; n < PHANTOM_SUSPECT_MIN_CLOSES; n += 1) {
      expect(phantomSpawnBar(BASE, n)).toBe(BASE)
    }
    // CONTROL: one more close DOES raise it, so the loop above is not vacuous.
    expect(phantomSpawnBar(BASE, PHANTOM_SUSPECT_MIN_CLOSES)).toBeGreaterThan(BASE)
  })

  it('raises one step per close above the threshold', () => {
    expect(phantomSpawnBar(BASE, PHANTOM_SUSPECT_MIN_CLOSES)).toBeCloseTo(
      BASE + PHANTOM_BAR_STEP,
      9,
    )
    expect(phantomSpawnBar(BASE, PHANTOM_SUSPECT_MIN_CLOSES + 1)).toBeCloseTo(
      BASE + 2 * PHANTOM_BAR_STEP,
      9,
    )
  })

  it('saturates at the ceiling — a cell is never impossible to be born in', () => {
    // The worst cell measured on the fleet: 31 closes in 24 h.
    expect(phantomSpawnBar(BASE, 31)).toBe(PHANTOM_BAR_CEILING)
    expect(PHANTOM_BAR_CEILING).toBeLessThan(1)
  })

  it('never LOWERS a bar, whatever the base', () => {
    for (const base of [0, 0.4, 0.95, 1]) {
      for (const n of [0, 3, 10, 100]) {
        expect(phantomSpawnBar(base, n)).toBeGreaterThanOrEqual(base)
      }
    }
  })
})

describe('PhantomCellRegistry', () => {
  let world: FakeRecords
  let registry: PhantomCellRegistry

  beforeEach(async () => {
    // `enforceDeclaredColumns` ON: a spec that asks "does this cell SURVIVE a
    // restart" must run against a store that drops what no column can hold.
    world = makeAnalyticsRecordsNow()
    registry = new PhantomCellRegistry({
      records: world.records,
      logger: makeSilentLogger(),
    })
  })

  const close = (n: number, over: Partial<{ x: number; y: number; className: string }> = {}) => ({
    deviceId: 101,
    className: over.className ?? 'person',
    trackId: `t-${n}`,
    x: over.x ?? 320,
    y: over.y ?? 240,
    now: T0 + n * 60_000,
  })

  const bar = (over: Partial<{ x: number; className: string; now: number }> = {}) =>
    registry.spawnBar({
      deviceId: 101,
      className: over.className ?? 'person',
      x: over.x ?? 320,
      y: 240,
      base: BASE,
      now: over.now ?? T0 + 10 * 60_000,
    })

  it('leaves the bar alone until the cell has repeated', async () => {
    await registry.noteMotionlessClose(close(1))
    await registry.noteMotionlessClose(close(2))
    expect(bar().bar).toBe(BASE)
    expect(bar().raised).toBe(false)
    // CONTROL: the third close is what arms it.
    await registry.noteMotionlessClose(close(3))
    expect(bar().bar).toBeGreaterThan(BASE)
    expect(bar().raised).toBe(true)
  })

  it('arms the SPECIFIC cell and class, not the camera', async () => {
    for (const n of [1, 2, 3, 4]) await registry.noteMotionlessClose(close(n))
    expect(bar().raised).toBe(true)
    // A different place on the same camera: untouched.
    expect(bar({ x: 320 + PHANTOM_CELL_PX * 5 }).raised).toBe(false)
    // A different class in the same place: untouched. Cap-shared class names
    // are exactly how a per-device aggregation goes wrong (D12).
    expect(bar({ className: 'vehicle' }).raised).toBe(false)
  })

  it('INCLUDES person — a motionless person is furniture until they move', async () => {
    for (const n of [1, 2, 3]) await registry.noteMotionlessClose(close(n))
    expect(bar({ className: 'person' }).raised).toBe(true)
  })

  it('forgets a cell whose closes have all aged out of the window', async () => {
    for (const n of [1, 2, 3]) await registry.noteMotionlessClose(close(n))
    expect(bar().raised).toBe(true)
    expect(bar({ now: T0 + PHANTOM_CELL_WINDOW_MS + 60_000 }).raised).toBe(false)
  })

  /**
   * The reactivation the operator asked for. A cell's suspicion is a statement
   * about a place while nothing there moves; one real subject revokes it.
   */
  it('a MOVING track born in a suspect cell clears it immediately', async () => {
    for (const n of [1, 2, 3, 4, 5]) await registry.noteMotionlessClose(close(n))
    expect(bar().raised).toBe(true)

    const forgotten = await registry.noteMovingClose({
      deviceId: 101,
      className: 'person',
      x: 320,
      y: 240,
    })
    expect(forgotten).toBe(true)
    expect(bar().raised).toBe(false)
    expect(bar().bar).toBe(BASE)
  })

  it('a moving track in a cell nobody suspected reports nothing', async () => {
    expect(
      await registry.noteMovingClose({
        deviceId: 101,
        className: 'person',
        x: 999,
        y: 999,
      }),
    ).toBe(false)
  })

  it('survives a restart: a fresh registry over the same store re-arms the cell', async () => {
    for (const n of [1, 2, 3, 4]) await registry.noteMotionlessClose(close(n))
    const reborn = new PhantomCellRegistry({
      records: world.records,
      logger: makeSilentLogger(),
    })
    const loaded = await reborn.load()
    expect(loaded).toBeGreaterThan(0)
    expect(
      reborn.spawnBar({
        deviceId: 101,
        className: 'person',
        x: 320,
        y: 240,
        base: BASE,
        now: T0 + 10 * 60_000,
      }).raised,
    ).toBe(true)
  })

  it('a failed load NEVER clears what is already held (D130)', async () => {
    for (const n of [1, 2, 3]) await registry.noteMotionlessClose(close(n))
    // Same registry, but every read now throws. The mirror must be untouched:
    // dropping remembered state on a transient error is exactly the failure
    // direction that produced the notification flood.
    const broken = new PhantomCellRegistry({
      records: withNcFaults(world, { read: () => 'sqlite busy' }).records,
      logger: makeSilentLogger(),
    })
    for (const n of [1, 2, 3]) await broken.noteMotionlessClose(close(n))
    await broken.load()
    expect(
      broken.spawnBar({
        deviceId: 101,
        className: 'person',
        x: 320,
        y: 240,
        base: BASE,
        now: T0 + 10 * 60_000,
      }).raised,
    ).toBe(true)
  })

  it('clearDevice drops that camera and nobody else', async () => {
    for (const n of [1, 2, 3]) await registry.noteMotionlessClose(close(n))
    await registry.noteMotionlessClose({ ...close(4), deviceId: 102 })
    await registry.clearDevice(101)
    expect(bar().raised).toBe(false)
    expect(registry.cellsForDevice(102)).toHaveLength(1)
  })
})
