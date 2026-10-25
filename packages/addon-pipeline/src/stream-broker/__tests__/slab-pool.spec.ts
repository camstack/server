import { describe, expect, it } from 'vitest'
import {
  backingStoreBytes,
  detachFromPool,
  ownsBackingStore,
  pinnedBackingBytes,
} from '../stream-broker/owned-buffer.js'
import {
  HeldPacketWindow,
  holdPacket,
  isSlabView,
  PacketSlabPool,
  readSlabTotals,
  releasePacket,
} from '../stream-broker/slab-pool.js'

/**
 * Slab-backed owned packets (D868). The invariants that matter:
 *  - a packet cut through the pool carries its bytes and is a view of a slab;
 *  - a slab a retaining structure holds is NEVER reused, whatever churns;
 *  - a slab nobody holds is reused only after the quarantine, and the reuse
 *    DETACHES the old ArrayBuffer, so a stale view reads empty, never another
 *    packet;
 *  - steady state allocates no new ArrayBuffer.
 */

const SLAB = 4096
const QUARANTINE = 1000

function makePool(clock: { t: number }, maxFree = 4): PacketSlabPool {
  return new PacketSlabPool({
    slabBytes: SLAB,
    quarantineMs: QUARANTINE,
    maxFree,
    now: () => clock.t,
  })
}

function source(length: number, fill: number): Buffer {
  return Buffer.alloc(length, fill)
}

describe('PacketSlabPool.copy', () => {
  it('copies the requested range into a slab view', () => {
    const pool = makePool({ t: 0 })
    const src = Buffer.from([9, 1, 2, 3, 4, 9])
    const out = pool.copy(src, 1, 5)
    expect([...out]).toEqual([1, 2, 3, 4])
    expect(isSlabView(out)).toBe(true)
    // A slab view is NOT "owned" for general retention: only the broker's holders keep it.
    expect(ownsBackingStore(out)).toBe(false)
  })

  it('packs consecutive packets into one ArrayBuffer and rotates when full', () => {
    const pool = makePool({ t: 0 })
    const a = pool.copy(source(1000, 1), 0, 1000)
    const b = pool.copy(source(1000, 2), 0, 1000)
    expect(b.buffer).toBe(a.buffer)
    expect(b.byteOffset).toBe(1000)
    pool.copy(source(1000, 3), 0, 1000)
    pool.copy(source(1000, 4), 0, 1000) // 4000 used
    const e = pool.copy(source(200, 5), 0, 200) // 4200 > 4096: new slab
    expect(e.buffer).not.toBe(a.buffer)
    expect(pool.stats().allocs).toBe(2)
  })

  it('gives an oversized packet its own buffer', () => {
    const pool = makePool({ t: 0 })
    const big = pool.copy(source(SLAB, 7), 0, SLAB)
    expect(isSlabView(big)).toBe(false)
    expect(big.buffer.byteLength).toBe(SLAB)
    expect(pool.stats().ownBuffers).toBe(1)
    expect(pool.stats().allocs).toBe(0)
  })

  it('adopt keeps an owned packet and copies a pooled one into a slab', () => {
    const pool = makePool({ t: 0 })
    const slabView = pool.copy(source(100, 1), 0, 100)
    expect(pool.adopt(slabView)).toBe(slabView)
    const whole = Buffer.allocUnsafeSlow(100)
    expect(pool.adopt(whole)).toBe(whole)
    const pooled = Buffer.from([1, 2, 3])
    const adopted = pool.adopt(pooled)
    expect(adopted).not.toBe(pooled)
    expect(isSlabView(adopted)).toBe(true)
    expect([...adopted]).toEqual([1, 2, 3])
  })
})

describe('slab lifetime', () => {
  it('never reuses a slab a retaining structure holds, however long the churn', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const kept = pool.copy(source(500, 0xaa), 0, 500)
    holdPacket(kept)
    // Heavy churn far beyond the quarantine: every other slab cycles many times.
    for (let i = 0; i < 2000; i++) {
      clock.t += 100
      const p = pool.copy(source(700, i & 0xff), 0, 700)
      holdPacket(p)
      releasePacket(p)
    }
    expect(kept.length).toBe(500)
    expect(kept.every((b) => b === 0xaa)).toBe(true)
    expect(pool.stats().recycles).toBeGreaterThan(10)
  })

  it('keeps a held packet intact after the holder releases only some of a slab', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const a = pool.copy(source(1000, 0x11), 0, 1000)
    const b = pool.copy(source(1000, 0x22), 0, 1000)
    holdPacket(a)
    holdPacket(b)
    for (let i = 0; i < 100; i++) pool.copy(source(1000, 0x33), 0, 1000)
    releasePacket(a)
    clock.t += 5 * QUARANTINE
    for (let i = 0; i < 100; i++) pool.copy(source(1000, 0x44), 0, 1000)
    // b is still held, so the slab it shares with a cannot have been reused.
    expect(b.every((x) => x === 0x22)).toBe(true)
    expect(b.length).toBe(1000)
  })

  it('waits out the quarantine, then reuses the memory and detaches the stale view', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const first = pool.copy(source(1000, 0x55), 0, 1000)
    holdPacket(first)
    // Fill and seal the slab.
    pool.copy(source(1000, 1), 0, 1000)
    pool.copy(source(1000, 1), 0, 1000)
    pool.copy(source(1000, 1), 0, 1000)
    pool.copy(source(1000, 1), 0, 1000) // rotates
    releasePacket(first)
    const before = pool.stats()

    // Inside the quarantine nothing is reused and the bytes are intact.
    clock.t += QUARANTINE - 1
    for (let i = 0; i < 12; i++) pool.copy(source(1000, 0x66), 0, 1000)
    expect(first.every((b) => b === 0x55)).toBe(true)
    expect(pool.stats().recycles).toBe(before.recycles)

    // Past it the slab is recycled; the old ArrayBuffer is detached.
    clock.t += 10
    for (let i = 0; i < 12; i++) pool.copy(source(1000, 0x66), 0, 1000)
    expect(pool.stats().recycles).toBeGreaterThan(before.recycles)
    expect(first.length).toBe(0)
    expect(Reflect.get(first.buffer, 'detached')).toBe(true)
  })

  it('release of a stale view is a no-op and cannot free a slab early', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const stale = pool.copy(source(1000, 1), 0, 1000)
    for (let i = 0; i < 8; i++) pool.copy(source(1000, 2), 0, 1000)
    clock.t += 10 * QUARANTINE
    for (let i = 0; i < 40; i++) pool.copy(source(1000, 3), 0, 1000)
    const live = pool.copy(source(1000, 0x77), 0, 1000)
    holdPacket(live)
    releasePacket(stale)
    releasePacket(stale)
    for (let i = 0; i < 400; i++) {
      clock.t += 100
      pool.copy(source(1000, 4), 0, 1000)
    }
    expect(live.every((b) => b === 0x77)).toBe(true)
  })

  it('allocates no new ArrayBuffer in steady state', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const ring: Buffer[] = []
    const WINDOW = 30 // packets the "ring" retains
    const PACKET = 600
    for (let i = 0; i < 20_000; i++) {
      clock.t += 10
      const p = pool.copy(source(PACKET, i & 0xff), 0, PACKET)
      holdPacket(p)
      ring.push(p)
      if (ring.length > WINDOW) releasePacket(ring.shift()!)
    }
    const allocsAfterWarmup = pool.stats().allocs
    for (let i = 0; i < 20_000; i++) {
      clock.t += 10
      const p = pool.copy(source(PACKET, i & 0xff), 0, PACKET)
      holdPacket(p)
      ring.push(p)
      if (ring.length > WINDOW) releasePacket(ring.shift()!)
    }
    expect(pool.stats().allocs).toBe(allocsAfterWarmup)
    expect(allocsAfterWarmup).toBeLessThan(40)
    expect(pool.stats().recycles).toBeGreaterThan(100)
    // The ring's packets are intact.
    ring.forEach((p) => expect(p.every((b) => b === p[0])).toBe(true))
  })

  it('process totals follow the pool', () => {
    const base = readSlabTotals()
    const pool = makePool({ t: 0 })
    pool.copy(source(10, 1), 0, 10)
    expect(readSlabTotals().live).toBe(base.live + 1)
    expect(readSlabTotals().allocs).toBe(base.allocs + 1)
    pool.dispose()
    expect(readSlabTotals().live).toBe(base.live)
  })
})

describe('accounting', () => {
  it('charges a slab view its length, and the diagnostic tally the whole slab', () => {
    const pool = makePool({ t: 0 })
    const p = pool.copy(source(700, 1), 0, 700)
    expect(backingStoreBytes(p)).toBe(700)
    expect(pinnedBackingBytes(p)).toBe(SLAB)
    // General retainers still copy a slab view (they do not hold).
    expect(detachFromPool(p)).not.toBe(p)
  })

  it('still charges a pooled 8 KiB view the whole slab', () => {
    const pooled = Buffer.from([1, 2, 3])
    expect(backingStoreBytes(pooled)).toBe(pooled.buffer.byteLength)
  })
})

describe('HeldPacketWindow (a consumer holding what its NACK history may still read)', () => {
  it('holds the last `limit` packets and releases the ones that fall out', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const window = new HeldPacketWindow(8)
    // Each held packet gets a slab of its own (the filler seals the one before).
    const holdOnItsOwnSlab = (fill: number): Buffer => {
      for (let i = 0; i < 4; i++) pool.copy(source(1000, 0), 0, 1000)
      const p = pool.copy(source(500, fill), 0, 500)
      window.hold(p)
      return p
    }
    const first = holdOnItsOwnSlab(0x99)
    for (let i = 0; i < 7; i++) holdOnItsOwnSlab(1)
    for (let i = 0; i < 300; i++) {
      clock.t += 50
      pool.copy(source(900, 2), 0, 900)
    }
    expect(first.every((b) => b === 0x99)).toBe(true)
    // The ninth hold pushes `first` out of the window: released, then free to recycle.
    holdOnItsOwnSlab(3)
    for (let i = 0; i < 300; i++) {
      clock.t += 50
      pool.copy(source(900, 2), 0, 900)
    }
    expect(first.length).toBe(0)
  })

  it('releaseAll lets every slab go', () => {
    const clock = { t: 0 }
    const pool = makePool(clock)
    const window = new HeldPacketWindow(4)
    const held = pool.copy(source(500, 0x77), 0, 500)
    window.hold(held)
    window.releaseAll()
    for (let i = 0; i < 300; i++) {
      clock.t += 50
      pool.copy(source(900, 2), 0, 900)
    }
    expect(held.length).toBe(0)
  })
})
