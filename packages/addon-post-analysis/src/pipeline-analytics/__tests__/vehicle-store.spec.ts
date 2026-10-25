import { describe, it, expect, beforeEach } from 'vitest'
import { VehicleStore } from '../store/vehicle-store.js'
import { type AnalyticsLedgers, makeAnalyticsWorld, seedLedgerRows } from './fake-records.js'
import { makeSilentLogger } from './test-helpers.js'

describe('VehicleStore', () => {
  let ledgers: AnalyticsLedgers
  let store: VehicleStore

  beforeEach(async () => {
    ;({ ledgers } = await makeAnalyticsWorld())
    store = new VehicleStore({
      logger: makeSilentLogger(),
      vehicleLedger: ledgers.vehicles,
      sampleLedger: ledgers.vehicleSamples,
    })
  })

  it('creates, renames, lists vehicles', async () => {
    const v = await store.createVehicle({ name: 'Van' })
    expect(v.name).toBe('Van')
    expect(v.sampleCount).toBe(0)
    await store.renameVehicle(v.id, 'White Van')
    const all = await store.listVehicles()
    expect(all.map((x) => x.name)).toEqual(['White Van'])
  })

  it('normalizes a SQL NULL coverMediaId to undefined', async () => {
    await seedLedgerRows(ledgers.vehicles, [
      {
        id: 'v-null',
        data: { name: 'Van', sampleCount: 1, createdAt: 1, updatedAt: 1, coverMediaId: null },
      },
    ])
    const [v] = await store.listVehicles()
    expect(v!.coverMediaId).toBeUndefined()
    for (const val of Object.values(v!)) expect(val).not.toBeNull()
  })

  it('addSample bumps sampleCount and sets cover on first sample', async () => {
    const v = await store.createVehicle({ name: 'Van' })
    await store.addSample({
      vehicleId: v.id,
      text: 'AB123CD',
      score: 0.9,
      mediaId: 101,
      deviceId: 9,
    })
    const [after] = await store.listVehicles()
    expect(after!.sampleCount).toBe(1)
    expect(after!.coverMediaId).toBe(101)
    const samples = await store.listSamples(v.id)
    expect(samples).toHaveLength(1)
    expect(samples[0]!.text).toBe('AB123CD')
  })

  it('deleteVehicle cascades its sample rows', async () => {
    const v = await store.createVehicle({ name: 'Van' })
    await store.addSample({ vehicleId: v.id, text: 'AB123CD', score: 0.9 })
    await store.deleteVehicle(v.id)
    expect(await store.listVehicles()).toHaveLength(0)
    expect(await store.listSamples(v.id)).toHaveLength(0)
  })

  it('loadGallery yields {vehicleId, text} per sample', async () => {
    const v = await store.createVehicle({ name: 'Van' })
    await store.addSample({ vehicleId: v.id, text: 'AB123CD', score: 0.9 })
    await store.addSample({ vehicleId: v.id, text: 'AB123CO', score: 0.7 })
    const gallery = await store.loadGallery()
    expect(gallery).toEqual([
      { vehicleId: v.id, text: 'AB123CD' },
      { vehicleId: v.id, text: 'AB123CO' },
    ])
  })

  it('removeSample decrements sampleCount', async () => {
    const v = await store.createVehicle({ name: 'Van' })
    const s = await store.addSample({ vehicleId: v.id, text: 'AB123CD', score: 0.9 })
    await store.removeSample(v.id, s.id)
    const [after] = await store.listVehicles()
    expect(after!.sampleCount).toBe(0)
  })
})

describe('VehicleStore — records path', () => {
  it('createVehicle lands in the vehicles records kind', async () => {
    const { world, ledgers } = await makeAnalyticsWorld()
    const store = new VehicleStore({
      logger: makeSilentLogger(),
      vehicleLedger: ledgers.vehicles,
      sampleLedger: ledgers.vehicleSamples,
    })
    const vehicle = await store.createVehicle({ name: 'Hub Van' })
    expect(world.tables.get('vehicles')?.size).toBe(1)
    const listed = await store.listVehicles()
    expect(listed.map((v) => v.name)).toEqual(['Hub Van'])
    expect(listed[0]!.id).toBe(vehicle.id)
  })
})
