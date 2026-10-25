import type { FrameFormat } from '../types/io.js'

/**
 * A zero-pixel, serialisable reference to a frame in a shared-memory ring.
 *
 * A `FrameHandle` carries everything a consumer needs to locate and validate
 * a frame in a `FrameRing` segment without copying a single pixel byte. It is
 * safe to pass across a process boundary (tRPC / Moleculer) — the receiving
 * side opens the named segment once and performs a seqlock read of `slot`,
 * verifying the committed sequence number still matches `seq` (a mismatch
 * means the slot was recycled and the frame is gone).
 */
export interface FrameHandle {
  /** Name of the OS shared-memory segment holding the ring. */
  readonly shmId: string
  /** Slot index in the ring (`0 <= slot < slotCount`). */
  readonly slot: number
  /** Committed (even) sequence number of the slot at publish time. */
  readonly seq: number
  /** Frame width in pixels. */
  readonly width: number
  /** Frame height in pixels. */
  readonly height: number
  /** Pixel format of the frame data. */
  readonly format: FrameFormat
  /**
   * A **monotonic, process-local** ordering key for the frame — sourced from
   * `performance.now()` at publish time. This is NOT the codec presentation
   * timestamp: the decoder discards the real source PTS upstream. Use `pts`
   * only to order frames within the producing process; it must never be
   * correlated across processes or against any other clock.
   */
  readonly pts: number
  /** Number of valid pixel bytes written into the slot. */
  readonly byteLength: number
  /** Cluster node id whose shared memory holds this segment. */
  readonly nodeId: string
  /** Slot count of the ring (a reader needs it to open the segment). */
  readonly slotCount: number
}
