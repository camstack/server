import { describe, it, expect } from 'vitest'
import type { FrameHandle } from '@camstack/types'
import { NativeCropRegistry } from '../native-crop-registry.js'
import { mkNativeCropRequester } from '../../__tests__/support/native-crop-requester.js'

function handle(shmId: string, slot: number, seq: number): FrameHandle {
  return {
    shmId,
    slot,
    seq,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: 0,
    byteLength: 1,
    nodeId: 'hub',
    slotCount: 8,
  }
}

const mkRequester = mkNativeCropRequester

describe('NativeCropRegistry', () => {
  it('registers a requester and resolves it by handle identity (shmId#slot#seq)', () => {
    const reg = new NativeCropRegistry(8)
    const r = mkRequester()
    const h = handle('csr.dev7', 3, 10)
    reg.register(h, r, 101)
    const found = reg.lookup(handle('csr.dev7', 3, 10))
    expect(found.kind).toBe('live')
    if (found.kind !== 'live') throw new Error('unreachable')
    expect(found.request).toBe(r)
    // The camera a miss on this handle must be attributed to.
    expect(found.deviceId).toBe(101)
    // A different seq for the same slot is a DIFFERENT frame → miss.
    expect(reg.lookup(handle('csr.dev7', 3, 12)).kind).toBe('unknown')
  })

  it('a handle never registered is UNKNOWN (miss → caller falls back)', () => {
    const reg = new NativeCropRegistry(8)
    expect(reg.lookup(handle('csr.dev7', 0, 0)).kind).toBe('unknown')
  })

  it('evicts the oldest entry past the capacity and releases its lease (bounded LRU)', () => {
    const reg = new NativeCropRegistry(2)
    const r0 = mkRequester()
    reg.register(handle('s', 0, 1), r0, 101)
    reg.register(handle('s', 1, 1), mkRequester(), 101)
    reg.register(handle('s', 2, 1), mkRequester(), 101) // evicts the oldest (slot 0)
    expect(reg.size).toBe(2)
    expect(reg.lookup(handle('s', 0, 1)).kind).toBe('unknown')
    expect(r0.release).toHaveBeenCalledTimes(1) // evicted → lease released
    expect(reg.lookup(handle('s', 1, 1)).kind).toBe('live')
    expect(reg.lookup(handle('s', 2, 1)).kind).toBe('live')
  })

  it('release(handle) frees the frame’s lease and drops the entry', () => {
    const reg = new NativeCropRegistry(8)
    const r = mkRequester()
    const h = handle('s', 4, 2)
    reg.register(h, r, 101)
    reg.release(handle('s', 4, 2))
    expect(r.release).toHaveBeenCalledTimes(1)
    expect(reg.lookup(h).kind).toBe('unknown')
    expect(reg.size).toBe(0)
    // Releasing an unknown handle is a harmless no-op.
    reg.release(handle('s', 99, 99))
  })

  it('clear() releases every lease and drops every entry', () => {
    const reg = new NativeCropRegistry(8)
    const r = mkRequester()
    reg.register(handle('s', 0, 1), r, 101)
    reg.clear()
    expect(r.release).toHaveBeenCalledTimes(1)
    expect(reg.size).toBe(0)
    expect(reg.lookup(handle('s', 0, 1)).kind).toBe('unknown')
  })

  it('a requester whose release() throws does not break eviction (best-effort)', () => {
    const reg = new NativeCropRegistry(1)
    const bad = mkRequester()
    bad.release.mockImplementation(() => {
      throw new Error('worker gone')
    })
    reg.register(handle('s', 0, 1), bad, 101)
    expect(() => reg.register(handle('s', 1, 1), mkRequester(), 101)).not.toThrow()
    expect(reg.size).toBe(1)
  })
})

// The miss diagnostics (2026-07-30). A native-crop miss has four different
// causes with four different fixes, and the line that reports it must be
// attributable to a CAMERA — `FrameHandle` carries neither a deviceId nor a
// correlatable clock, so registration time is the only place both exist.
describe('NativeCropRegistry — miss attribution', () => {
  it('reports the age since registration on lookup', () => {
    const reg = new NativeCropRegistry(8)
    const h = handle('s', 0, 1)
    reg.register(h, mkRequester(), 102)
    const found = reg.lookup(h)
    expect(found.kind).toBe('live')
    if (found.kind !== 'live') throw new Error('unreachable')
    expect(found.deviceId).toBe(102)
    expect(found.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('still attributes an EVICTED handle to its camera', () => {
    const reg = new NativeCropRegistry(1)
    const first = handle('s', 0, 1)
    reg.register(first, mkRequester(), 101)
    // Evicts the first entry.
    reg.register(handle('s', 1, 1), mkRequester(), 102)
    expect(reg.lookup(first).kind).toBe('unknown')
    // …but the miss is still reportable per-camera, which is the whole point.
    expect(reg.deviceIdFor(first)).toBe(101)
  })

  it('returns null for a handle it never saw', () => {
    const reg = new NativeCropRegistry(4)
    expect(reg.deviceIdFor(handle('never', 9, 9))).toBeNull()
  })
})

// ── Cap sizing ────────────────────────────────────────────────────────────

import {
  DEFAULT_NATIVE_CROP_REGISTRY_CAP,
  NATIVE_CROP_REGISTRY_BUSIEST_NODE_HANDLES_PER_S,
  NATIVE_CROP_REGISTRY_WINDOW_MS,
} from '../native-crop-registry.js'

describe('the default cap covers the TILE window on the busiest node', () => {
  // The registry is the ONLY way a late request reaches the worker that holds
  // a frame's tiles. Since the scene-tile fix (2026-09-05) those tiles answer
  // for 30 s, but the registry — an LRU shared by every camera on the node —
  // evicted the handle after 256 entries: 3.2 s on `hub/detection` (~80
  // handles/s), 6.4 s on the Mac. 7 579 `no-registry-entry` misses a day were
  // requests for frames whose TILES were still there and could not be reached.
  it('holds at least 30 s of handles at the busiest node rate', () => {
    expect(NATIVE_CROP_REGISTRY_WINDOW_MS).toBe(30_000)
    expect(NATIVE_CROP_REGISTRY_BUSIEST_NODE_HANDLES_PER_S).toBeGreaterThanOrEqual(100)
    expect(DEFAULT_NATIVE_CROP_REGISTRY_CAP).toBeGreaterThanOrEqual(
      (NATIVE_CROP_REGISTRY_WINDOW_MS / 1000) * NATIVE_CROP_REGISTRY_BUSIEST_NODE_HANDLES_PER_S,
    )
  })
})
