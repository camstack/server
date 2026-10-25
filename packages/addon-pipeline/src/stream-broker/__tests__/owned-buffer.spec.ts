/**
 * `detachFromPool` is the ONE place a ring entry leaves the Buffer pool, and
 * `backingStoreBytes` is what a ring budget charges for it. Pinned here
 * because the two assumptions it rests on are Node's, not ours: allocations
 * under 4 KiB share 8 KiB slabs, allocations at or above it do not.
 */
import { describe, expect, it } from 'vitest'

import {
  backingStoreBytes,
  detachFromPool,
  ownsBackingStore,
} from '../stream-broker/owned-buffer.js'

describe('ownsBackingStore', () => {
  it('a small allocUnsafe / from / concat is a view of a shared slab', () => {
    expect(ownsBackingStore(Buffer.allocUnsafe(600))).toBe(false)
    expect(ownsBackingStore(Buffer.from(Buffer.alloc(1300).subarray(0, 1300)))).toBe(false)
    expect(ownsBackingStore(Buffer.concat([Buffer.alloc(12), Buffer.alloc(1288)]))).toBe(false)
  })

  it('an allocUnsafeSlow owns its ArrayBuffer, whatever its size', () => {
    // Whether a plain allocUnsafe of >= 4 KiB is pooled is a Node runtime
    // detail (it differed between this Mac and the CI runner), so only an
    // explicitly unpooled allocation is asserted as owned.
    expect(ownsBackingStore(Buffer.allocUnsafeSlow(600))).toBe(true)
    expect(ownsBackingStore(Buffer.allocUnsafeSlow(8192))).toBe(true)
    expect(ownsBackingStore(Buffer.alloc(0))).toBe(true)
  })

  it('a sub-view of an owned buffer does not own it', () => {
    const owned = Buffer.allocUnsafeSlow(1000)
    expect(ownsBackingStore(owned.subarray(10, 20))).toBe(false)
    expect(ownsBackingStore(owned.subarray(0, 20))).toBe(false)
  })
})

describe('backingStoreBytes', () => {
  it('charges the whole slab for a pooled view and the length for an owned one', () => {
    const pooledBuf = Buffer.allocUnsafe(600)
    expect(backingStoreBytes(pooledBuf)).toBe(pooledBuf.buffer.byteLength)
    expect(backingStoreBytes(pooledBuf)).toBeGreaterThan(600)
    expect(backingStoreBytes(Buffer.allocUnsafeSlow(600))).toBe(600)
  })
})

describe('detachFromPool', () => {
  it('copies a pooled buffer into its own allocation, byte for byte', () => {
    const pooledBuf = Buffer.allocUnsafe(600)
    pooledBuf.fill(0xab)
    const owned = detachFromPool(pooledBuf)
    expect(owned).not.toBe(pooledBuf)
    expect(ownsBackingStore(owned)).toBe(true)
    expect(owned.equals(pooledBuf)).toBe(true)
    // A copy, not a view: writing the original does not reach the ring.
    pooledBuf[0] = 0x00
    expect(owned[0]).toBe(0xab)
  })

  it('returns an already-owned buffer as-is — never a second copy', () => {
    const slow = Buffer.allocUnsafeSlow(600)
    const big = Buffer.allocUnsafeSlow(8192)
    expect(detachFromPool(slow)).toBe(slow)
    expect(detachFromPool(big)).toBe(big)
  })
})
