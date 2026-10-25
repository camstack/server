import type { FrameHandle } from '@camstack/types'

/** A valid {@link FrameHandle} for in-process recognizer / crop specs. */
export function makeTestFrameHandle(patch: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'test-shm',
    slot: 0,
    seq: 2,
    width: 640,
    height: 480,
    format: 'rgb',
    pts: 0,
    byteLength: 640 * 480 * 3,
    nodeId: 'n',
    slotCount: 8,
    ...patch,
  }
}
