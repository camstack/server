import { describe, it, expect, beforeEach } from 'vitest'
import { PlateStore } from '../store/plate-store.js'
import { makeAnalyticsWorld } from './fake-records.js'
import { makeSilentLogger } from './test-helpers.js'

describe('PlateStore — assignment + keyframe columns', () => {
  let store: PlateStore

  beforeEach(async () => {
    const { ledgers } = await makeAnalyticsWorld()
    store = new PlateStore({ logger: makeSilentLogger(), plateLedger: ledgers.plates })
  })

  it('insert round-trips the new columns (assigned + plateBbox + keyFrameMediaId)', async () => {
    await store.insert({
      id: 'plate-t1',
      deviceId: 9,
      trackId: 't1',
      timestamp: 1,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: false,
      keyFrameMediaId: 4001,
      plateBbox: { x: 1, y: 2, w: 3, h: 4 },
    })
    const p = await store.get('plate-t1')
    expect(p!.assigned).toBe(false)
    expect(p!.keyFrameMediaId).toBe(4001)
    expect(p!.plateBbox).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    expect(p!.recognizedVehicleId).toBeUndefined()
  })

  it('markAssigned then clearAssignment toggles the vehicle link', async () => {
    await store.insert({
      id: 'plate-t1',
      deviceId: 9,
      trackId: 't1',
      timestamp: 1,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: false,
    })
    await store.markAssigned('plate-t1', 'veh-1', 'samp-1')
    let p = await store.get('plate-t1')
    expect(p!.assigned).toBe(true)
    expect(p!.recognizedVehicleId).toBe('veh-1')
    expect(p!.assignedSampleId).toBe('samp-1')

    await store.clearAssignment('plate-t1')
    p = await store.get('plate-t1')
    expect(p!.assigned).toBe(false)
    expect(p!.recognizedVehicleId).toBeUndefined()
    expect(p!.assignedSampleId).toBeUndefined()
  })

  it('pruneCapOverflow exempts an assigned read', async () => {
    await store.insert({
      id: 'plate-old-assigned',
      deviceId: 9,
      trackId: 't-a',
      timestamp: 1,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: true,
    })
    await store.insert({
      id: 'plate-old-plain',
      deviceId: 9,
      trackId: 't-b',
      timestamp: 1,
      text: 'XY999ZZ',
      score: 0.9,
      corrected: false,
      assigned: false,
    })
    const deleted = await store.pruneCapOverflow({ maxPerDevice: 0 })
    expect(deleted).toEqual(['plate-old-plain'])
    expect(await store.get('plate-old-assigned')).not.toBeNull()
    expect(await store.get('plate-old-plain')).toBeNull()
  })

  it('deleteByTracks removes unassigned reads but EXEMPTS assigned reads', async () => {
    await store.insert({
      id: 'plate-t1',
      deviceId: 9,
      trackId: 't1',
      timestamp: 1,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: false,
    })
    await store.insert({
      id: 'plate-t2',
      deviceId: 9,
      trackId: 't2',
      timestamp: 1,
      text: 'XY999ZZ',
      score: 0.9,
      corrected: false,
      assigned: true,
    })
    await store.deleteByTracks(['t1', 't2'])
    expect(await store.get('plate-t1')).toBeNull()
    expect(await store.get('plate-t2')).not.toBeNull()
  })
})
