/**
 * Slab-backed owned packets (D868).
 *
 * `copyOwned` used to `Buffer.allocUnsafeSlow` PER PACKET: on the hub that is
 * 12.2k allocations/s of ~1.2 KB, 14.6 MB/s of fresh external memory. V8 starts
 * a mark-compact every time external memory grows 64 MB (one every ~4 s, 22-30 %
 * of a core) and the retained fraction fragments the glibc brk arena.
 *
 * A {@link PacketSlabPool} (one per broker, i.e. per stream) copies packets
 * into large owned slabs and hands out `Buffer` views of them. A slab is
 * recycled when the broker's rings let go of it, so the steady state allocates
 * no new ArrayBuffer at all.
 *
 * Lifetime, in one paragraph. A slab is ACTIVE while it is the bump target.
 * When the next packet does not fit it is SEALED. Whatever keeps a packet
 * calls {@link holdPacket} and, when done, {@link releasePacket}; a sealed slab
 * with no holds enters QUARANTINE. After {@link SLAB_QUARANTINE_MS} it is
 * recycled: its backing store is MOVED into a fresh ArrayBuffer
 * (`ArrayBuffer.prototype.transfer`, zero-copy) and the old ArrayBuffer is
 * DETACHED. THE RULE: any consumer that keeps a view past the synchronous call
 * must HOLD it or COPY it. The fence only turns a violation from silent
 * aliasing into an empty view for JS readers; native code that already took a
 * pointer (a queued `socket.write`, libuv) still reads the recycled memory, and
 * Node's `writableLength` bookkeeping reads the detached length (0). Holders:
 * the source-RTP ring and the restreamer keyframe cache; the session's NACK
 * window (`HeldPacketWindow`); every socket write (`writeHeld`). Copiers:
 * codec parameter sets in the repacketizers, the audio-codec session, the G.711
 * fan-out payload, and general retention (`detachFromPool` copies a slab view).
 *
 * Caps. {@link backingStoreBytes} charges a slab view its own length (slabs
 * are densely packed); the diagnostic {@link BackingTally} keeps summing the
 * distinct ArrayBuffers, so a slab pinned by one packet still shows up as the
 * whole slab there.
 */

import { recordCopyOwned } from './broker-mem-probe.js'

/** Bytes per slab. Chosen by `scripts/bench-slab-packets.ts` (see D868). */
export const SLAB_BYTES = 64 * 1024

/** A packet larger than this fraction of a slab gets its own buffer. */
export const SLAB_MAX_PACKET_BYTES = SLAB_BYTES >> 2

/**
 * How long a slab with no holds waits before its memory is reused. It covers
 * the short asynchronous tails of a packet's life (a paced join replay is
 * ~300 ms, a join snapshot is taken from the ring up to one GOP before the
 * ring lets go of it) and is deliberately short: the quarantined bytes of every
 * stream add up (14.6 MB/s on the hub is 29 MB per two seconds). A holder that
 * lives longer takes {@link holdPacket}.
 */
export const SLAB_QUARANTINE_MS = 2_000

/** Recycled slabs kept ready per pool; more are left to the GC. */
export const SLAB_MAX_FREE = 2

interface Transferable {
  transfer(): ArrayBuffer
}

function isTransferable(buf: ArrayBuffer): buf is ArrayBuffer & Transferable {
  return typeof Reflect.get(buf, 'transfer') === 'function'
}

type SlabState = 'active' | 'held' | 'quarantined' | 'free'

class Slab {
  buffer: ArrayBuffer
  offset = 0
  holds = 0
  state: SlabState = 'active'
  releasedAt = 0

  constructor(
    buffer: ArrayBuffer,
    readonly now: () => number,
  ) {
    this.buffer = buffer
  }
}

/** ArrayBuffer -> slab, for every slab ArrayBuffer currently in service. */
const slabOf = new WeakMap<ArrayBufferLike, Slab>()

// Process-wide counters for the `[broker-mem]` line: O(1) per event.
let slabsLive = 0
let slabsFree = 0
let slabAllocs = 0
let slabRecycles = 0

export interface SlabTotals {
  /** Slabs in service (active, held or quarantined). */
  readonly live: number
  /** Recycled slabs waiting for the next bump. */
  readonly free: number
  /** ArrayBuffers allocated since process start. */
  readonly allocs: number
  /** Slabs returned to service from quarantine since process start. */
  readonly recycles: number
}

export function readSlabTotals(): SlabTotals {
  return { live: slabsLive, free: slabsFree, allocs: slabAllocs, recycles: slabRecycles }
}

/** True when `buf` is a view of a pool slab. */
export function isSlabView(buf: Uint8Array): boolean {
  return slabOf.has(buf.buffer)
}

/** A retaining structure keeps `buf`: its slab cannot be recycled until released. */
export function holdPacket(buf: Uint8Array): void {
  const slab = slabOf.get(buf.buffer)
  if (slab === undefined) return
  slab.holds += 1
  if (slab.state === 'quarantined') slab.state = 'held'
}

/** The matching drop. Safe on a non-slab buffer and on a stale (recycled) view. */
export function releasePacket(buf: Uint8Array): void {
  const slab = slabOf.get(buf.buffer)
  if (slab === undefined || slab.holds === 0) return
  slab.holds -= 1
  if (slab.holds === 0 && slab.state === 'held') {
    slab.state = 'quarantined'
    slab.releasedAt = slab.now()
  }
}

export function holdPackets(bufs: readonly Uint8Array[]): void {
  for (const b of bufs) holdPacket(b)
}

export function releasePackets(bufs: readonly Uint8Array[]): void {
  for (const b of bufs) releasePacket(b)
}

/**
 * A consumer's own hold on the last `limit` packets it forwarded.
 *
 * werift keeps the last RTP_HISTORY_SIZE (4096) packets of each sender for NACK
 * retransmission, and those packets' payloads are views of the broker's slabs.
 * The session mirrors that window here: each forwarded packet is held, and
 * the one falling out of the window is released, so a retransmit asked for
 * within the history is served from bytes nobody has recycled.
 */
export class HeldPacketWindow {
  private readonly slots: Array<Uint8Array | undefined>
  private next = 0

  constructor(readonly limit: number) {
    this.slots = new Array<Uint8Array | undefined>(limit).fill(undefined)
  }

  hold(buf: Uint8Array): void {
    holdPacket(buf)
    const evicted = this.slots[this.next]
    if (evicted !== undefined) releasePacket(evicted)
    this.slots[this.next] = buf
    this.next = (this.next + 1) % this.limit
  }

  releaseAll(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const held = this.slots[i]
      if (held !== undefined) releasePacket(held)
      this.slots[i] = undefined
    }
    this.next = 0
  }
}

export interface PacketSlabPoolOptions {
  readonly slabBytes?: number
  readonly quarantineMs?: number
  readonly maxFree?: number
  readonly now?: () => number
}

export interface PacketSlabPoolStats {
  readonly live: number
  readonly free: number
  readonly allocs: number
  readonly recycles: number
  readonly ownBuffers: number
}

export class PacketSlabPool {
  private readonly slabBytes: number
  private readonly maxPacket: number
  private readonly quarantineMs: number
  private readonly maxFree: number
  private readonly now: () => number

  private active: Slab | null = null
  /** Sealed slabs, oldest first; entries may have been re-held since. */
  private sealed: Slab[] = []
  private free: Slab[] = []
  private allocs = 0
  private recycles = 0
  private ownBuffers = 0

  constructor(options: PacketSlabPoolOptions = {}) {
    this.slabBytes = options.slabBytes ?? SLAB_BYTES
    this.maxPacket = this.slabBytes >> 2
    this.quarantineMs = options.quarantineMs ?? SLAB_QUARANTINE_MS
    this.maxFree = options.maxFree ?? SLAB_MAX_FREE
    this.now = options.now ?? Date.now
  }

  /**
   * A copy of `src[start, end)` in this pool's active slab. An oversized
   * packet gets its own buffer (it owns its ArrayBuffer, like the old
   * `copyOwned`).
   */
  copy(src: Buffer, start: number, end: number): Buffer {
    const length = end - start
    recordCopyOwned(length)
    if (length > this.maxPacket) {
      this.ownBuffers += 1
      const own = Buffer.allocUnsafeSlow(length)
      src.copy(own, 0, start, end)
      return own
    }
    let slab = this.active
    if (slab === null || slab.offset + length > this.slabBytes) {
      slab = this.rotate()
    }
    const view = Buffer.from(slab.buffer, slab.offset, length)
    src.copy(view, 0, start, end)
    slab.offset += length
    return view
  }

  /**
   * `buf` itself when it is already owned (a slab view or a whole-ArrayBuffer
   * buffer), else a copy in the active slab. Used for packets that arrive from
   * paths that do not cut through {@link copy} (push-rtp).
   */
  adopt(buf: Buffer): Buffer {
    if (isSlabView(buf)) return buf
    if (buf.byteOffset === 0 && buf.buffer.byteLength === buf.length) return buf
    return this.copy(buf, 0, buf.length)
  }

  stats(): PacketSlabPoolStats {
    return {
      live: this.sealed.length + (this.active === null ? 0 : 1),
      free: this.free.length,
      allocs: this.allocs,
      recycles: this.recycles,
      ownBuffers: this.ownBuffers,
    }
  }

  /** Drop every slab of this pool from the process counters (stream torn down). */
  dispose(): void {
    const live = this.sealed.length + (this.active === null ? 0 : 1)
    slabsLive -= live
    slabsFree -= this.free.length
    this.sealed = []
    this.free = []
    this.active = null
  }

  private rotate(): Slab {
    const previous = this.active
    if (previous !== null) {
      this.sealed.push(previous)
      if (previous.holds === 0) {
        previous.state = 'quarantined'
        previous.releasedAt = this.now()
      } else {
        previous.state = 'held'
      }
    }
    this.reclaim()
    const next = this.free.pop() ?? this.allocate()
    if (next.state === 'free') {
      slabsFree -= 1
      slabsLive += 1
    }
    next.state = 'active'
    next.offset = 0
    next.holds = 0
    this.active = next
    return next
  }

  private allocate(): Slab {
    this.allocs += 1
    slabAllocs += 1
    slabsLive += 1
    const slab = new Slab(new ArrayBuffer(this.slabBytes), this.now)
    slabOf.set(slab.buffer, slab)
    return slab
  }

  /** Move quarantined slabs whose time is up to the free list. */
  private reclaim(): void {
    if (this.sealed.length === 0) return
    const cutoff = this.now() - this.quarantineMs
    const keep: Slab[] = []
    for (const slab of this.sealed) {
      if (slab.state === 'quarantined' && slab.releasedAt <= cutoff) {
        this.recycle(slab)
      } else {
        keep.push(slab)
      }
    }
    this.sealed = keep
  }

  private recycle(slab: Slab): void {
    slabsLive -= 1
    if (this.free.length >= this.maxFree) {
      // Past the free list: leave it to the GC. Stale views still read it.
      slabOf.delete(slab.buffer)
      slab.state = 'free'
      return
    }
    const old = slab.buffer
    slabOf.delete(old)
    slab.buffer = isTransferable(old) ? old.transfer() : new ArrayBuffer(this.slabBytes)
    if (!isTransferable(old)) {
      this.allocs += 1
      slabAllocs += 1
    }
    slabOf.set(slab.buffer, slab)
    slab.state = 'free'
    slab.offset = 0
    slab.holds = 0
    this.free.push(slab)
    slabsFree += 1
    this.recycles += 1
    slabRecycles += 1
  }
}
