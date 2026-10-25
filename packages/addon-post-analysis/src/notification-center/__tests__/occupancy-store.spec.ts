/**
 * OccupancyStore unit tests — declared-collection persistence + boot reseed.
 *
 * Mirrors the `rule-store.spec` shape (fake `SettingsStoreClient`) and asserts
 * the durable contract the OccupancyWatcher depends on: a confirmed edge-state
 * row persisted before a "restart" is returned verbatim by a fresh store's
 * `load()` (no re-fired edge, no lost transition), full zone/class/occupied
 * round-trip fidelity, a RAM-cache mirror, and stale-key pruning so the row
 * count stays bounded when rules stop watching a key.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable, seedRows } from './support/nc-test-deps.js'
import { describe, it, expect, beforeEach } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { occupancyKey, type OccupancyStateRow } from '../occupancy-watcher.js'
import { OccupancyStore } from '../occupancy-store.js'

function makeRow(overrides: Partial<OccupancyStateRow> = {}): OccupancyStateRow {
  const deviceId = overrides.deviceId ?? 42
  const threshold = overrides.threshold ?? 1
  const key =
    overrides.key ?? occupancyKey(deviceId, overrides.zoneId, overrides.className, threshold)
  return {
    key,
    deviceId,
    ...(overrides.zoneId !== undefined ? { zoneId: overrides.zoneId } : {}),
    ...(overrides.className !== undefined ? { className: overrides.className } : {}),
    threshold,
    confirmedCount: overrides.confirmedCount ?? 2,
    occupied: overrides.occupied ?? true,
    lastChangeAt: overrides.lastChangeAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
  }
}

describe('OccupancyStore', () => {
  let world: InMemoryRecords
  let store: OccupancyStore

  beforeEach(async () => {
    world = makeNcRecords()
    store = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
  })

  it('persist then a fresh store load() returns the confirmed level (survives restart)', async () => {
    const row = makeRow({ deviceId: 7, zoneId: 'gate', className: 'person', confirmedCount: 3 })
    await store.persist(row)

    // Fresh instance over the SAME store == an addon restart.
    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    const loaded = await store2.load()
    expect(loaded).toEqual([row])
  })

  it('round-trips frame-scope and zone/class keys with occupied both ways', async () => {
    const frame = makeRow({ deviceId: 5, confirmedCount: 0, occupied: false, lastChangeAt: 900 })
    const zoneClass = makeRow({
      deviceId: 5,
      zoneId: 'lobby',
      className: 'vehicle',
      confirmedCount: 4,
      occupied: true,
      lastChangeAt: 1_200,
      updatedAt: 1_300,
    })
    await store.persist(frame)
    await store.persist(zoneClass)

    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    const loaded = await store2.load()
    const byKey = new Map(loaded.map((r) => [r.key, r]))
    expect(byKey.get(frame.key)).toEqual(frame)
    expect(byKey.get(zoneClass.key)).toEqual(zoneClass)
  })

  it('persist upserts an existing key (advancing confirmed state, not duplicating rows)', async () => {
    const row = makeRow({ deviceId: 9, className: 'person', confirmedCount: 1, occupied: false })
    await store.persist(row)
    const advanced = makeRow({
      deviceId: 9,
      className: 'person',
      confirmedCount: 3,
      occupied: true,
      lastChangeAt: 2_000,
      updatedAt: 2_000,
    })
    await store.persist(advanced)

    expect(ncTable(world, 'occupancy').size).toBe(1)
    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    expect(await store2.load()).toEqual([advanced])
  })

  it('load populates the RAM cache mirror (snapshot reflects the store)', async () => {
    const a = makeRow({ deviceId: 1, className: 'person' })
    const b = makeRow({ deviceId: 2, zoneId: 'z1' })
    await store.persist(a)
    await store.persist(b)

    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    await store2.load()
    expect([...store2.snapshot()].sort((x, y) => x.key.localeCompare(y.key))).toEqual(
      [a, b].sort((x, y) => x.key.localeCompare(y.key)),
    )
  })

  it('pruneExcept deletes stale keys and keeps the active ones (bounded row count)', async () => {
    const keep = makeRow({ deviceId: 1, className: 'person' })
    const stale1 = makeRow({ deviceId: 2, zoneId: 'z1' })
    const stale2 = makeRow({ deviceId: 3, className: 'vehicle' })
    await store.persist(keep)
    await store.persist(stale1)
    await store.persist(stale2)

    const pruned = await store.pruneExcept(new Set([keep.key]))
    expect(pruned).toBe(2)
    expect(ncTable(world, 'occupancy').size).toBe(1)

    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    expect(await store2.load()).toEqual([keep])
  })

  it('pruneExcept over an all-active set is a no-op', async () => {
    const a = makeRow({ deviceId: 1 })
    const b = makeRow({ deviceId: 2 })
    await store.persist(a)
    await store.persist(b)
    const pruned = await store.pruneExcept(new Set([a.key, b.key]))
    expect(pruned).toBe(0)
    expect(ncTable(world, 'occupancy').size).toBe(2)
  })

  it('load skips malformed rows without throwing', async () => {
    const good = makeRow({ deviceId: 8, className: 'person' })
    await store.persist(good)
    seedRows(world, 'occupancy', [
      { id: 'broken', data: { deviceId: 'not-a-number', confirmedCount: 1 } },
    ])
    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    expect(await store2.load()).toEqual([good])
  })

  it('SKIPS a legacy three-segment key (no `t<n>` threshold marker) — never mis-parses it', async () => {
    const good = makeRow({ deviceId: 8, className: 'person' })
    await store.persist(good)
    // A pre-amendment row: `deviceId|zoneId|className` with NO threshold marker.
    // parseOccupancyKey must reject it so load() drops it (cold re-observe),
    // rather than positionally mangling className←threshold / zoneId←class.
    seedRows(world, 'occupancy', [
      {
        id: '7|gate|person',
        data: { deviceId: 7, confirmedCount: 3, occupied: true, lastChangeAt: 1, updatedAt: 1 },
      },
    ])
    const store2 = new OccupancyStore({ records: world.records, logger: makeSilentLogger() })
    const loaded = await store2.load()
    expect(loaded).toEqual([good]) // the legacy row is absent (skipped, not mangled)
  })
})
