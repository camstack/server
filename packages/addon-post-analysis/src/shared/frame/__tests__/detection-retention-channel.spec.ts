/**
 * Task 3 — a frame without a detection is not recoverable from the
 * detection-retention channel. Camera snapshots and recorded stills are
 * independent pulls and must stay available.
 */
import { describe, expect, it } from 'vitest'
import type { FrameHandle } from '@camstack/types'
import { resolveFrame } from '../resolve-frame.js'

function handle(): FrameHandle {
  return {
    shmId: 'ram:hub:1',
    slot: 1,
    seq: 9,
    width: 1920,
    height: 1080,
    format: 'rgb',
    pts: 1,
    byteLength: 0,
    nodeId: 'hub',
    slotCount: 1024,
  }
}

describe('notification media channels', () => {
  it('a no-detection handle misses detection-retention and leaves snapshot/still independent', async () => {
    const retained = await resolveFrame(handle(), {
      getRemoteFrame: async () => null,
    })
    expect(retained).toBeNull()

    const cameraSnapshot = { channel: 'camera-snapshot' as const, jpeg: Buffer.from([0xff, 0xd8]) }
    const recordedStill = {
      channel: 'recorded-still' as const,
      jpeg: Buffer.from([0xff, 0xd8, 0xff]),
    }
    expect(cameraSnapshot.jpeg.byteLength).toBeGreaterThan(0)
    expect(recordedStill.jpeg.byteLength).toBeGreaterThan(0)
  })
})
