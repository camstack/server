/**
 * The scene CONFIG half of the store, over the `scenes` record kind (records
 * phase 2). Rows are asserted where the engine holds them, not through the
 * store's own mirror: a store that kept the scene in RAM and persisted nothing
 * would pass every read-back, and lose every scene on a respawn.
 */
import { describe, expect, it, vi } from 'vitest'
import { SceneMonitorSchema, type SceneMonitor } from '@camstack/types'
import { makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { SceneStore, sceneKey } from '../scene-store.js'

function monitor(id: string, label: string): SceneMonitor {
  return SceneMonitorSchema.parse({
    id,
    label,
    roi: { kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    enabled: true,
    triggerMode: 'periodic',
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
    states: [],
    currentStateId: null,
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: null,
    availability: 'ok',
    unavailableReason: null,
    unavailable: 'no-reference-for-condition',
    coveredConditions: [],
    baselineStateId: null,
    verdict: 'unknown',
    latched: false,
    armedAt: 1,
    divergedAt: null,
    restoredAt: null,
  })
}

async function build() {
  const world = await makeAnalyticsRecords()
  const warn = vi.fn()
  const logger = { ...makeSilentLogger(), warn }
  const make = () => new SceneStore({ records: world.records, logger })
  return { world, warn, make }
}

describe('SceneStore config over the `scenes` kind', () => {
  it('persists a scene as a row of the kind and a fresh store loads it back', async () => {
    const { world, make } = await build()
    const first = make()
    await first.putScene(102, monitor('gate', 'Cancello aperto'), 5_000)

    const row = world.tables.get('scenes')?.get(sceneKey(102, 'gate'))
    // The marked fields survived the write, not just the key.
    expect(row?.data).toMatchObject({
      deviceId: 102,
      enabled: true,
      updatedAt: 5_000,
      monitor: {
        id: 'gate',
        label: 'Cancello aperto',
        roi: { x: 0.1, height: 0.4 },
      },
    })

    const reborn = make()
    await reborn.load()
    expect(reborn.getScene(102, 'gate')).toMatchObject({
      deviceId: 102,
      updatedAt: 5_000,
      monitor: { label: 'Cancello aperto' },
    })
  })

  it('deleteScene removes the row from the engine, not only from the mirror', async () => {
    const { world, make } = await build()
    const store = make()
    await store.putScene(102, monitor('gate', 'g'), 1)
    await store.deleteScene(102, 'gate')
    expect(world.tables.get('scenes')?.size ?? 0).toBe(0)
    const reborn = make()
    await reborn.load()
    expect(reborn.listScenes()).toEqual([])
  })

  it('skips a row whose monitor no longer validates, and says so', async () => {
    const { world, warn, make } = await build()
    world.seed('scenes', {
      id: '300360',
      data: {
        deviceId: 1,
        enabled: true,
        updatedAt: 1,
        monitor: { nope: true },
      },
    })
    const store = make()
    await store.putScene(2, monitor('ok', 'fine'), 1)
    const reborn = make()
    await reborn.load()
    expect(reborn.listScenes().map((r) => r.key)).toEqual(['2:ok'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('malformed'))).toBe(true)
  })

  it('a failed reload keeps the scenes already in memory — never an empty set', async () => {
    const { world, make } = await build()
    const store = make()
    await store.putScene(102, monitor('gate', 'g'), 1)
    world.failReads(true)
    await store.load()
    expect(store.listScenes()).toHaveLength(1)
  })

  it('a refused write is logged with the device and leaves the scene live in this process', async () => {
    const { world, warn, make } = await build()
    const store = make()
    world.failWrites(true)
    await store.putScene(102, monitor('gate', 'g'), 1)
    expect(store.getScene(102, 'gate')).toBeDefined()
    expect(world.tables.get('scenes')?.size ?? 0).toBe(0)
    const line = warn.mock.calls.find((c) => String(c[0]).includes('scene persist failed'))
    expect(line?.[1]).toMatchObject({ tags: { deviceId: 102 } })
  })
})
