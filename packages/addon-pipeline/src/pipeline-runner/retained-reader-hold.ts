import type { FrameHandle } from '@camstack/types'

/** The one thing {@link withRetainedReader} needs from the retained store. */
export interface RetainedReaderSource {
  holdReader(handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>): (() => void) | null
}

/**
 * Run `read` with `handle`'s parked frame held as a CONSUMER for its whole
 * duration (D656).
 *
 * `getNativeCrop` has two rungs: a native crop, then — on a miss — the retained
 * full-frame fallback. Between them nothing is in flight: the crop's reply
 * settles the worker's last pending request in the same turn, and the fallback's
 * `toBuffer` is only sent on a later microtask. A parked frame does not keep a
 * draining worker alive, so without this hold the drain killed the worker in
 * that gap and the fallback was lost. One rule instead of a timing trick: a
 * read in progress is a consumer.
 */
export async function withRetainedReader<T>(
  store: RetainedReaderSource | null | undefined,
  handle: Pick<FrameHandle, 'shmId' | 'slot' | 'seq'>,
  read: () => Promise<T>,
): Promise<T> {
  const release = store?.holdReader(handle) ?? null
  try {
    return await read()
  } finally {
    release?.()
  }
}
