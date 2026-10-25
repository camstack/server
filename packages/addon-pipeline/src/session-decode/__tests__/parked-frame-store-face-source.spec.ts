/**
 * Face source parcels (D644) live in their OWN budget: at their cap they evict
 * each other, never a track's keyFrame/thumbnail parcel (D58 — the media a
 * later pass depends on must land).
 */
import { describe, expect, it } from 'vitest'
import {
  FACE_SOURCE_PARCEL_PREFIX,
  FACE_SOURCE_PARCELS_PER_DEVICE_MAX,
  type ParkedFrame,
  PartitionedParkedFrameStore,
} from '../parked-frame-store.js'

function parcel(bytes: number, timestamp: number): ParkedFrame {
  return { jpeg: Buffer.alloc(bytes, 0xff), width: 4, height: 3, timestamp }
}

describe('PartitionedParkedFrameStore', () => {
  it('pins the prefix the hub parks under', () => {
    expect(FACE_SOURCE_PARCEL_PREFIX).toBe('face-src:')
  })

  it('face parcels at their per-camera cap never evict a track parcel', () => {
    const store = new PartitionedParkedFrameStore({
      track: { now: () => 1 },
      faceSource: { now: () => 1 },
    })
    store.park(101, 't-track', 'keyFrame', parcel(100, 1))
    for (let i = 0; i < FACE_SOURCE_PARCELS_PER_DEVICE_MAX * 3; i++) {
      store.park(101, `face-src:t${i}`, 'keyFrame', parcel(100, 10 + i))
    }
    expect(store.get(101, 't-track', 'keyFrame')).not.toBeNull()
    expect(store.statsByDevice(101).parcels).toBe(1 + FACE_SOURCE_PARCELS_PER_DEVICE_MAX)
  })

  it('face parcels over their byte budget evict each other, not the track budget', () => {
    const store = new PartitionedParkedFrameStore({
      track: { now: () => 1, budgetBytes: 1_000 },
      faceSource: { now: () => 1, budgetBytes: 250, perDeviceMax: 100 },
    })
    store.park(101, 't-track', 'keyFrame', parcel(900, 1))
    for (let i = 0; i < 5; i++) store.park(616, `face-src:t${i}`, 'keyFrame', parcel(100, 10 + i))
    expect(store.get(101, 't-track', 'keyFrame')).not.toBeNull()
    expect(store.get(616, 'face-src:t4', 'keyFrame')).not.toBeNull()
    expect(store.get(616, 'face-src:t0', 'keyFrame')).toBeNull()
  })

  it('release routes by key', () => {
    const store = new PartitionedParkedFrameStore()
    store.park(101, 't1', 'keyFrame', parcel(10, 1))
    store.park(101, 'face-src:t1', 'keyFrame', parcel(10, 1))
    expect(store.release(101, 'face-src:t1')).toBe(1)
    expect(store.get(101, 't1', 'keyFrame')).not.toBeNull()
  })
})
