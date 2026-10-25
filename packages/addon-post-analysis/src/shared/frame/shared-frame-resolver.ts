/**
 * `createSharedFrameResolver` — a single-slot memo so the object / face / plate
 * crops of the SAME frame share ONE full-frame decode (Step 5).
 *
 * The native-crop path is per-bbox (the owning runner crops the ROI server-side
 * and returns only that crop). The DETECTION-frame fallback, however, resolves
 * the WHOLE frame and crops locally — so when several crops fall back on the
 * same handle in one live-frame window, resolving it once narrows the shm-recycle
 * window and avoids redundant decodes.
 *
 * The cache key is the frame's FULL identity `nodeId:shmId:slot:seq`. `seq` is
 * the seqlock committed sequence number, unique per publish — so a recycled slot
 * (same shmId+slot, new seq) is a DIFFERENT key and never serves stale pixels.
 * A single slot is enough: frames are processed roughly in order, so the next
 * frame simply replaces the entry.
 */

import type { FrameHandle } from '@camstack/types'

export function frameHandleKey(h: FrameHandle): string {
  return `${h.nodeId}:${h.shmId}:${h.slot}:${h.seq}`
}

export function createSharedFrameResolver<T>(
  resolve: (handle: FrameHandle) => Promise<T>,
): (handle: FrameHandle) => Promise<T> {
  let cache: { key: string; value: Promise<T> } | null = null
  return (handle) => {
    const key = frameHandleKey(handle)
    if (cache === null || cache.key !== key) {
      cache = { key, value: resolve(handle) }
    }
    return cache.value
  }
}
