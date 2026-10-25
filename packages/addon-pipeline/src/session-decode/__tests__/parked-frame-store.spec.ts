/**
 * `ParkedFrameStore` — the per-track PARCEL a node keeps once the hub has said
 * "this frame matters to this track" (D422).
 *
 * What these cases pin, and why each one is a case:
 *  - a parcel is keyed by `(deviceId, trackId, kind)` and retrieved by exactly
 *    that — never by a frame handle, never by age;
 *  - a park is idempotent per key and REPLACES: the hub's ranking decides what
 *    is better, so a later park wins. A park that arrives OUT OF ORDER (older
 *    frame instant than the parcel already held) is ignored, because two
 *    in-flight parks racing on the wire must not let the loser overwrite;
 *  - the bound is per DEVICE and per NODE, and both evict the OLDEST parcel of
 *    the offending scope — never refuse the new one, which is the frame that
 *    was just judged to matter;
 *  - a track's parcels leave when the hub releases the track, and a track the
 *    hub forgot ages out under a hard ceiling so a lost release cannot pin RAM.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PARKED_FRAME_BUDGET_BYTES,
  PARKED_FRAME_MAX_AGE_MS,
  PARKED_FRAMES_PER_DEVICE_MAX,
  ParkedFrameStore,
  type ParkedFrame,
} from '../parked-frame-store.js'

const DEVICE = 102
const OTHER_DEVICE = 101

function parcel(bytes: number, timestamp = 1_000): ParkedFrame {
  return { jpeg: Buffer.alloc(bytes, 0xff), width: 4, height: 3, timestamp }
}

describe('ParkedFrameStore', () => {
  it('stores a parcel under (deviceId, trackId, kind) and answers exactly that key', () => {
    const store = new ParkedFrameStore({ now: () => 10_000 })
    expect(store.park(DEVICE, 't1', 'keyFrame', parcel(100))).toBe('stored')
    const got = store.get(DEVICE, 't1', 'keyFrame')
    expect(got?.jpeg.byteLength).toBe(100)
    expect(got?.parkedAt).toBe(10_000)
    // Same track, other kind — a separate parcel.
    expect(store.get(DEVICE, 't1', 'thumbnail')).toBeNull()
    // Same track id on another camera — never the same key (track ids are
    // opaque here, the device is part of the identity).
    expect(store.get(OTHER_DEVICE, 't1', 'keyFrame')).toBeNull()
  })

  it('a later park for the same key REPLACES the parcel (the hub said it is better)', () => {
    const store = new ParkedFrameStore()
    store.park(DEVICE, 't1', 'keyFrame', parcel(100, 1_000))
    expect(store.park(DEVICE, 't1', 'keyFrame', parcel(200, 2_000))).toBe('replaced')
    expect(store.get(DEVICE, 't1', 'keyFrame')?.jpeg.byteLength).toBe(200)
    expect(store.size).toBe(1)
    expect(store.bytes).toBe(200)
  })

  it('a park whose frame instant is OLDER than the held parcel is ignored — a racing loser never overwrites', () => {
    const store = new ParkedFrameStore()
    store.park(DEVICE, 't1', 'keyFrame', parcel(200, 2_000))
    expect(store.park(DEVICE, 't1', 'keyFrame', parcel(100, 1_000))).toBe('older-ignored')
    expect(store.get(DEVICE, 't1', 'keyFrame')?.jpeg.byteLength).toBe(200)
    // The SAME instant re-parked is a replace (a retry of the same decision).
    expect(store.park(DEVICE, 't1', 'keyFrame', parcel(150, 2_000))).toBe('replaced')
  })

  it('bounds parcels PER DEVICE by evicting that device’s oldest — the new parcel is never refused', () => {
    const onEvict = vi.fn()
    let now = 0
    const store = new ParkedFrameStore({ perDeviceMax: 2, now: () => now, onEvict })
    now = 1
    store.park(DEVICE, 't1', 'keyFrame', parcel(10))
    now = 2
    store.park(DEVICE, 't2', 'keyFrame', parcel(10))
    now = 3
    store.park(OTHER_DEVICE, 'o1', 'keyFrame', parcel(10))
    now = 4
    expect(store.park(DEVICE, 't3', 'keyFrame', parcel(10))).toBe('stored')
    expect(store.get(DEVICE, 't1', 'keyFrame')).toBeNull()
    expect(store.get(DEVICE, 't2', 'keyFrame')).not.toBeNull()
    expect(store.get(DEVICE, 't3', 'keyFrame')).not.toBeNull()
    // Another camera's parcel is untouched by this device's bound.
    expect(store.get(OTHER_DEVICE, 'o1', 'keyFrame')).not.toBeNull()
    expect(onEvict).toHaveBeenCalledTimes(1)
    expect(onEvict).toHaveBeenCalledWith({
      deviceId: DEVICE,
      trackId: 't1',
      kind: 'keyFrame',
      cause: 'device-bound',
    })
  })

  it('bounds bytes PER NODE by evicting the globally oldest parcel, whatever its device', () => {
    const onEvict = vi.fn()
    let now = 0
    const store = new ParkedFrameStore({ budgetBytes: 250, now: () => now, onEvict })
    now = 1
    store.park(OTHER_DEVICE, 'o1', 'keyFrame', parcel(100))
    now = 2
    store.park(DEVICE, 't1', 'keyFrame', parcel(100))
    now = 3
    expect(store.park(DEVICE, 't2', 'keyFrame', parcel(100))).toBe('stored')
    expect(store.bytes).toBeLessThanOrEqual(250)
    expect(store.get(OTHER_DEVICE, 'o1', 'keyFrame')).toBeNull()
    expect(store.get(DEVICE, 't2', 'keyFrame')).not.toBeNull()
    expect(onEvict).toHaveBeenCalledWith({
      deviceId: OTHER_DEVICE,
      trackId: 'o1',
      kind: 'keyFrame',
      cause: 'node-budget',
    })
  })

  it('a single parcel larger than the whole budget is still kept (keep ≥ 1, like the retained store)', () => {
    const store = new ParkedFrameStore({ budgetBytes: 50 })
    expect(store.park(DEVICE, 't1', 'keyFrame', parcel(100))).toBe('stored')
    expect(store.get(DEVICE, 't1', 'keyFrame')).not.toBeNull()
  })

  it('release(deviceId, trackId) drops EVERY kind of that track and reports how many left', () => {
    const store = new ParkedFrameStore()
    store.park(DEVICE, 't1', 'keyFrame', parcel(10))
    store.park(DEVICE, 't1', 'thumbnail', parcel(10))
    store.park(DEVICE, 't2', 'keyFrame', parcel(10))
    expect(store.release(DEVICE, 't1')).toBe(2)
    expect(store.get(DEVICE, 't1', 'keyFrame')).toBeNull()
    expect(store.get(DEVICE, 't1', 'thumbnail')).toBeNull()
    expect(store.get(DEVICE, 't2', 'keyFrame')).not.toBeNull()
    expect(store.bytes).toBe(10)
    // Releasing an unknown track is a harmless no-op.
    expect(store.release(DEVICE, 'never')).toBe(0)
  })

  it('a parcel the hub never released ages out under the hard ceiling', () => {
    const onEvict = vi.fn()
    let now = 0
    const store = new ParkedFrameStore({ maxAgeMs: 1_000, now: () => now, onEvict })
    store.park(DEVICE, 't1', 'keyFrame', parcel(10))
    now = 1_001
    // The sweep runs on the write path, like the registry's age sweep — a
    // timer here would be a second owner of the same lifetime.
    store.park(DEVICE, 't2', 'keyFrame', parcel(10))
    expect(store.get(DEVICE, 't1', 'keyFrame')).toBeNull()
    expect(onEvict).toHaveBeenCalledWith({
      deviceId: DEVICE,
      trackId: 't1',
      kind: 'keyFrame',
      cause: 'age',
    })
    // A read past the ceiling is a miss too, even before any write swept it.
    store.park(DEVICE, 't3', 'keyFrame', parcel(10))
    now = 2_500
    expect(store.get(DEVICE, 't3', 'keyFrame')).toBeNull()
  })

  it('statsByDevice says what a camera is costing, and clear() empties everything', () => {
    const store = new ParkedFrameStore()
    store.park(DEVICE, 't1', 'keyFrame', parcel(30))
    store.park(DEVICE, 't1', 'thumbnail', parcel(20))
    store.park(OTHER_DEVICE, 'o1', 'keyFrame', parcel(5))
    expect(store.statsByDevice(DEVICE)).toEqual({ parcels: 2, bytes: 50 })
    expect(store.statsByDevice(OTHER_DEVICE)).toEqual({ parcels: 1, bytes: 5 })
    store.clear()
    expect(store.size).toBe(0)
    expect(store.bytes).toBe(0)
    expect(store.get(DEVICE, 't1', 'keyFrame')).toBeNull()
  })

  it('the defaults are stated where they are spent, and are sane against a 4K key frame', () => {
    // A 4K key frame JPEG at quality 90 measures ~1.5–2.5 MB (scene-tile
    // sizing, `scene-tile.ts`). The node budget must hold a busy node's live
    // tracks worth of them; the device bound must hold a burst of subjects.
    expect(PARKED_FRAME_BUDGET_BYTES).toBeGreaterThanOrEqual(24 * 2.5 * 1024 * 1024)
    expect(PARKED_FRAMES_PER_DEVICE_MAX).toBeGreaterThanOrEqual(2 * 16)
    // Well past the analytics track TTL (30 s since lastSeen) and any session
    // hold (≤ 600 s): only a LOST release ever meets this ceiling.
    expect(PARKED_FRAME_MAX_AGE_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })
})
