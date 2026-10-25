/**
 * These assert READ COUNTS, not shapes.
 *
 * A test that checked `listAll` was called with `{ projection: 'slim' }` would
 * pass on a call that asks for the whole fleet slim — which is most of the cost
 * back — and would say nothing about the ten per-device reads the sweep then
 * performs on every id the scope returns. So the fake device manager reproduces
 * the amplification `device-queries.ts#listAll` really performs (one
 * `readDeviceStore` per returned row unless the projection is slim) and the
 * assertions are on counters.
 */

import { describe, expect, it } from 'vitest'
import { retentionScopeDeviceIds } from '../retention-scope.js'

/** How many per-device store reads ONE retention pass makes per device in
 *  scope. Measured on the live hub, 2026-08-25 — see `retention-scope.ts`. */
const PER_DEVICE_READS_PER_PASS = 10

interface FleetRow {
  readonly id: number
  readonly isCamera: boolean
}

interface ListAllInput {
  readonly isCamera?: boolean
  readonly projection?: string
}

/**
 * A device manager that charges what the real one charges.
 *
 * `device-queries.ts#listAll` materialises `config` with ONE
 * `pctx.settings.readDeviceStore(id)` per returned row, sequentially, unless
 * the caller asked for `projection: 'slim'`. That read is invisible from the
 * calling process, which is exactly why the fake has to model it — a fake that
 * returns rows for free agrees with the bug.
 */
function fakeDeviceManager(fleet: readonly FleetRow[]) {
  let deviceStoreReads = 0
  return {
    deviceStoreReads: () => deviceStoreReads,
    listAll: async (input: ListAllInput): Promise<readonly FleetRow[]> => {
      const rows = input.isCamera === true ? fleet.filter((d) => d.isCamera) : fleet
      if (input.projection !== 'slim') deviceStoreReads += rows.length
      return rows
    },
  }
}

/** The live shape: 967 devices, 36 of them cameras. */
function liveFleet(): readonly FleetRow[] {
  return Array.from({ length: 967 }, (_, i) => ({ id: i + 1, isCamera: i < 36 }))
}

const noop = (): void => undefined

describe('retentionScopeDeviceIds', () => {
  it('the fleet listing costs ZERO per-device settings reads', async () => {
    const dm = fakeDeviceManager(liveFleet())
    await retentionScopeDeviceIds(
      {
        listAll: dm.listAll,
        listTrackedDeviceIds: async () => [],
      },
      noop,
    )
    expect(dm.deviceStoreReads()).toBe(0)
  })

  it('scopes the pass to cameras, so the per-device reads are 40x fewer', async () => {
    const dm = fakeDeviceManager(liveFleet())
    const ids = await retentionScopeDeviceIds(
      {
        listAll: dm.listAll,
        listTrackedDeviceIds: async () => [],
      },
      noop,
    )
    expect(ids).toHaveLength(36)
    // What the pass will actually spend, which is the number that mattered:
    // 360 reads instead of 9 670.
    expect(ids.length * PER_DEVICE_READS_PER_PASS).toBe(360)
  })

  it('still covers a DELETED camera that owns tracks — the union is the safety', async () => {
    const dm = fakeDeviceManager(liveFleet())
    const ids = await retentionScopeDeviceIds(
      {
        listAll: dm.listAll,
        // 9001 is not in the fleet at all: the camera is gone, its history is not.
        listTrackedDeviceIds: async () => [9001, 12],
      },
      noop,
    )
    expect(ids).toContain(9001)
    expect(ids).toHaveLength(37)
  })

  it('a device-manager failure does not stop the track store from aging out', async () => {
    const seen: string[] = []
    const ids = await retentionScopeDeviceIds(
      {
        listAll: async () => {
          throw new Error('device manager unreachable')
        },
        listTrackedDeviceIds: async () => [7, 8],
      },
      (half) => seen.push(half),
    )
    expect(ids).toEqual([7, 8])
    expect(seen).toEqual(['cameras'])
  })

  it('a track-store failure does not stop the cameras from aging out', async () => {
    const seen: string[] = []
    const ids = await retentionScopeDeviceIds(
      {
        listAll: async () => [{ id: 1 }, { id: 2 }],
        listTrackedDeviceIds: async () => {
          throw new Error('store down')
        },
      },
      (half) => seen.push(half),
    )
    expect(ids).toEqual([1, 2])
    expect(seen).toEqual(['tracked'])
  })
})
