import { describe, expect, it } from 'vitest'
import type { EncodedPacket } from '@camstack/types'
import { EncodedRingBuffer } from '../encoded-ring-buffer.js'

function vpkt(pts: number, keyframe = false): EncodedPacket {
  return { type: 'video', data: Buffer.alloc(1000), pts, dts: pts, keyframe, codec: 'h264' }
}

describe('EncodedRingBuffer eviction under non-monotonic pts', () => {
  it('stays bounded when pts jumps backwards (RTSP redial re-bases the RTP timestamp)', () => {
    const buf = new EncodedRingBuffer(1) // 1s retention window

    // Epoch 1: a large RTP timestamp base — 200 packets @40ms spanning 8s.
    // Monotonic, so normal eviction trims to roughly the last second.
    for (let i = 0; i < 200; i++) buf.push(vpkt(1_000_000 + i * 40, i === 0))

    // Epoch 2: an RTSP/rfc4571 redial re-bases the RTP timestamp to a LOWER
    // random value (RFC 3550). Every subsequent packet has a pts far below the
    // stale epoch-1 head, so purely-pts-relative eviction stalls forever.
    for (let i = 0; i < 200; i++) buf.push(vpkt(5_000 + i * 40, i === 0))

    // A 1s window at 40ms is ~25 packets. The buffer must NOT retain the whole
    // 400-packet cross-epoch history (that is the ~200MB/min native leak).
    expect(buf.getPacketCount()).toBeLessThan(60)
  })

  it('still evicts a monotonic stream down to the retention window (no regression)', () => {
    const buf = new EncodedRingBuffer(1) // 1s window
    for (let i = 0; i < 100; i++) buf.push(vpkt(i * 40, i === 0)) // 4s @40ms, monotonic
    // ~1s worth retained, and the whole history is not kept.
    expect(buf.getPacketCount()).toBeGreaterThan(15)
    expect(buf.getPacketCount()).toBeLessThan(40)
  })
})
