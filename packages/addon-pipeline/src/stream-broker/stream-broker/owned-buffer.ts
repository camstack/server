/**
 * Buffers that enter a LONG-LIVED ring own their backing store.
 *
 * Node serves `Buffer.from(...)`, `Buffer.allocUnsafe(n)` and `Buffer.concat`
 * below `Buffer.poolSize >>> 1` (4 KiB) as views of shared 8 KiB pool slabs.
 * That is the right choice for the ingest path — a start code, a 4-byte
 * interleave header, a 1.3 KB RTP packet that is fanned out and forgotten
 * within a tick — and the wrong one for anything RETAINED: a 600-byte NAL kept
 * for 60 s in a clip ring pins its whole slab, and with it every short-lived
 * packet that happened to be allocated beside it. On the hub that held
 * 550–980 MB of ArrayBuffers for ~150–250 MB of payload, and the full GCs the
 * pinned slabs caused ran every 0.2–0.5 s at 40–65 % of a core.
 *
 * The ring byte caps counted payload bytes, so they never saw it. Both rings
 * now pass every entry through {@link detachFromPool} on the way in and
 * account it with {@link backingStoreBytes}, so the cap measures what the
 * entry costs. Short-lived traffic stays pooled.
 */

import { recordCopyOwned } from './broker-mem-probe.js'
import { isSlabView } from './slab-pool.js'

/** True when `buf` is the whole of its ArrayBuffer — nothing else shares it. */
export function ownsBackingStore(buf: Uint8Array): boolean {
  return buf.byteOffset === 0 && buf.buffer.byteLength === buf.length
}

/**
 * What retaining `buf` really costs: its own length when it owns its
 * ArrayBuffer (a packet slab is densely packed, so a slab view counts as its
 * own length too), the whole shared slab when it is a view of a pooled one.
 * The diagnostic `BackingTally` still sums the distinct ArrayBuffers.
 */
export function backingStoreBytes(buf: Uint8Array): number {
  return ownsBackingStore(buf) || isSlabView(buf) ? buf.length : buf.buffer.byteLength
}

/**
 * What `buf` PINS: its own length when it is the whole of its ArrayBuffer, the
 * whole ArrayBuffer otherwise — a packet slab view included. This is the
 * diagnostic figure (`BackingTally`); caps charge {@link backingStoreBytes}.
 */
export function pinnedBackingBytes(buf: Uint8Array): number {
  return buf.byteOffset === 0 && buf.buffer.byteLength === buf.length
    ? buf.length
    : buf.buffer.byteLength
}

/**
 * `buf` itself when it already owns its ArrayBuffer (decided by inspecting the
 * buffer, never by its size: whether a large `allocUnsafe` is pooled is a Node
 * runtime detail), else a copy that does. One copy, never two: a buffer that is
 * already unpooled is returned as-is.
 */
export function detachFromPool(buf: Buffer): Buffer {
  if (ownsBackingStore(buf)) return buf
  const owned = Buffer.allocUnsafeSlow(buf.length)
  buf.copy(owned)
  return owned
}

/**
 * A copy of `src[start, end)` that OWNS its backing store — the shape a reader
 * hands out when the packet it cuts from its socket buffer is going to be
 * retained anyway.
 *
 * Every source video packet is: `captureRtpForPreBuffer` keeps it for the life
 * of a GOP, and the restreamer's keyframe cache keeps the keyframe ones. With
 * the readers cutting packets as `Buffer.from(subarray)` — a pooled view — the
 * ring then had to copy each one a second time to own it: two copies of every
 * packet on the ingest path (measured 15.1 + 14.8 MB/s on the hub's load).
 * Cutting the packet owned up front makes the ring's and the cache's
 * `detachFromPool` an identity, so the packet is copied once and shared by the
 * reader's fan-out, the ring, the cache and every session's write queue.
 */
export function copyOwned(src: Buffer, start: number, end: number): Buffer {
  const owned = Buffer.allocUnsafeSlow(end - start)
  src.copy(owned, 0, start, end)
  // Attribution probe (`broker-mem-probe.ts`): two integer adds, no allocation.
  recordCopyOwned(end - start)
  return owned
}

/**
 * Where a reader cuts its packets. The broker passes its own
 * {@link PacketSlabPool}'s `copy`; a reader built without one (standalone use,
 * specs) falls back to {@link copyOwned}.
 */
export type PacketAllocator = (src: Buffer, start: number, end: number) => Buffer
