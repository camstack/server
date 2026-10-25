/**
 * Package background memory — the position that "delivers" itself over and
 * over without anyone ever collecting it is scenery, and must stop notifying.
 *
 * Device 101's streetlight wedge cycled delivered→picked-up ~23 times a night
 * at ONE bbox (IoU ≈ 0.98 across hours). The area ceiling and the activity
 * gate each kill it on their own; this registry is the durable net behind
 * both: N ghost cycles at one position = background, until a REAL pick-up
 * (somebody actually collected from there) clears the cell.
 *
 * Style and durability mirror `pipeline/stationary/phantom-cells.ts` (D204):
 * RAM-only reads on the decision path, write-behind DurableLedger underneath.
 */
import { makeAnalyticsRecordsNow, type FakeRecords } from '../../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../__tests__/test-helpers.js'
import {
  PACKAGE_BACKGROUND_MIN_CYCLES,
  PACKAGE_BACKGROUND_WINDOW_MS,
  PackageBackgroundRegistry,
} from '../package-background.js'

const T0 = 1_760_000_000_000
const DEVICE = 101
/** The wedge's centroid on 101 (bbox 104.5,165.5 271.3×80.3 → 240.2, 205.7). */
const WEDGE = { x: 240.2, y: 205.7 }

function makeRegistry(world: FakeRecords): PackageBackgroundRegistry {
  return new PackageBackgroundRegistry({
    records: world.records,
    logger: makeSilentLogger(),
  })
}

async function ghost(
  r: PackageBackgroundRegistry,
  now: number,
  pos: { x: number; y: number } = WEDGE,
): Promise<void> {
  await r.noteGhostCycle({
    deviceId: DEVICE,
    className: 'package',
    x: pos.x,
    y: pos.y,
    now,
  })
}

function background(
  r: PackageBackgroundRegistry,
  now: number,
  pos: { x: number; y: number } = WEDGE,
): boolean {
  return r.isBackground({
    deviceId: DEVICE,
    className: 'package',
    x: pos.x,
    y: pos.y,
    now,
  }).background
}

describe('PackageBackgroundRegistry', () => {
  let world: FakeRecords
  let registry: PackageBackgroundRegistry

  beforeEach(async () => {
    world = makeAnalyticsRecordsNow()
    registry = makeRegistry(world)
    await registry.load()
  })

  it('is INERT below the cycle threshold — one bad night is not scenery', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES - 1; i += 1) {
      await ghost(registry, T0 + i * 3_600_000)
    }
    expect(background(registry, T0 + 10 * 3_600_000)).toBe(false)
    // CONTROL: one more cycle flips it, so the loop above is not vacuous.
    await ghost(registry, T0 + 10 * 3_600_000)
    expect(background(registry, T0 + 10 * 3_600_000)).toBe(true)
  })

  it('bbox jitter lands in the SAME cell (the wedge never repeats to the pixel)', async () => {
    // Measured wedge jitter: 104.5→104.0 in x, 165.5→164.7 in y (px, 640×360).
    await ghost(registry, T0, { x: 240.2, y: 205.7 })
    await ghost(registry, T0 + 1, { x: 240.0, y: 204.8 })
    await ghost(registry, T0 + 2, { x: 241.1, y: 205.0 })
    expect(background(registry, T0 + 3)).toBe(true)
  })

  it('cycles age out of the window', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES; i += 1) {
      await ghost(registry, T0 + i)
    }
    expect(background(registry, T0 + 10)).toBe(true)
    expect(background(registry, T0 + PACKAGE_BACKGROUND_WINDOW_MS + 10)).toBe(false)
  })

  it('a REAL pick-up clears the cell — collected proves it was a delivery spot', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES; i += 1) {
      await ghost(registry, T0 + i)
    }
    expect(background(registry, T0 + 10)).toBe(true)
    const cleared = await registry.noteRealPickup({
      deviceId: DEVICE,
      className: 'package',
      x: WEDGE.x,
      y: WEDGE.y,
    })
    expect(cleared).toBe(true)
    expect(background(registry, T0 + 11)).toBe(false)
  })

  it('a real pick-up somewhere else clears nothing', async () => {
    await ghost(registry, T0)
    const cleared = await registry.noteRealPickup({
      deviceId: DEVICE,
      className: 'package',
      x: WEDGE.x + 200,
      y: WEDGE.y,
    })
    expect(cleared).toBe(false)
  })

  it('cells are isolated per device', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES; i += 1) {
      await ghost(registry, T0 + i)
    }
    const other = registry.isBackground({
      deviceId: 102,
      className: 'package',
      x: WEDGE.x,
      y: WEDGE.y,
      now: T0 + 10,
    })
    expect(other.background).toBe(false)
  })

  it('survives a restart — the memory is durable', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES; i += 1) {
      await ghost(registry, T0 + i)
    }
    const reborn = makeRegistry(world)
    const loaded = await reborn.load()
    expect(loaded).toBeGreaterThan(0)
    expect(background(reborn, T0 + 10)).toBe(true)
  })

  it('clearDevice drops only that device', async () => {
    for (let i = 0; i < PACKAGE_BACKGROUND_MIN_CYCLES; i += 1) {
      await ghost(registry, T0 + i)
    }
    await registry.clearDevice(DEVICE)
    expect(background(registry, T0 + 10)).toBe(false)
  })
})
