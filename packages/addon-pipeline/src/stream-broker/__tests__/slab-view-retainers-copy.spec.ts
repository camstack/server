import { describe, expect, it, vi } from 'vitest'
import { H264Repacketizer } from '../webrtc/h264-repacketizer.js'
import { H265Repacketizer } from '../webrtc/h265-repacketizer.js'
import { AudioCodecSession } from '../stream-broker/audio-codec-session.js'
import type { AudioCodecCapApi } from '../stream-broker/audio-codec-proxy.js'
import { PacketSlabPool } from '../stream-broker/slab-pool.js'

/**
 * Whatever keeps a packet's bytes beyond the synchronous call must hold the
 * packet or COPY it (D868): a slab is recycled under a view nobody holds.
 * These are the retainers that copy.
 */

const SLAB = 4096

/** A slab view whose slab is then recycled and overwritten. */
function recycledView(content: Buffer): { view: Buffer; recycle: () => void } {
  const clock = { t: 0 }
  const pool = new PacketSlabPool({ slabBytes: SLAB, quarantineMs: 10, now: () => clock.t })
  const view = pool.copy(content, 0, content.length)
  return {
    view,
    recycle: () => {
      for (let i = 0; i < 100; i++) {
        clock.t += 20
        pool.copy(Buffer.alloc(900, 0xee), 0, 900)
      }
      // The slab is recycled: the ArrayBuffer under `view` is now detached.
    },
  }
}

describe('codec parameter sets outlive the packet they arrived in', () => {
  it('H264Repacketizer copies SPS, PPS and SEI', () => {
    const r = new H264Repacketizer(console, 1200)
    const sps = recycledView(Buffer.from([0x67, 1, 2, 3, 4]))
    const pps = recycledView(Buffer.from([0x68, 5, 6]))
    const sei = recycledView(Buffer.from([0x06, 7, 8]))
    r.updateSps(sps.view)
    r.updatePps(pps.view)
    r.updateSei(sei.view)
    sps.recycle()
    pps.recycle()
    sei.recycle()
    expect([...r.codecInfo!.sps!]).toEqual([0x67, 1, 2, 3, 4])
    expect([...r.codecInfo!.pps!]).toEqual([0x68, 5, 6])
    expect([...r.codecInfo!.sei!]).toEqual([0x06, 7, 8])
  })

  it('H265Repacketizer copies VPS, SPS, PPS and both SEIs', () => {
    const r = new H265Repacketizer(console, 1200)
    const names = ['vps', 'sps', 'pps', 'seiPrefix', 'seiSuffix'] as const
    const views = names.map((_, i) => recycledView(Buffer.from([0x40 + i, i, i, i])))
    r.updateVps(views[0]!.view)
    r.updateSps(views[1]!.view)
    r.updatePps(views[2]!.view)
    r.updateSeiPrefix(views[3]!.view)
    r.updateSeiSuffix(views[4]!.view)
    views.forEach((v) => v.recycle())
    names.forEach((name, i) => {
      expect([...r.codecInfo![name]!]).toEqual([0x40 + i, i, i, i])
    })
  })
})

describe('AudioCodecSession reads the payload after an await', () => {
  it('pushes the bytes that arrived, not what the slab holds later', async () => {
    const pushed: Uint8Array[] = []
    const api = {
      createDecodeSession: vi.fn(async () => ({ sessionId: 's', nodeId: 'n' })),
      pushEncodedFrame: vi.fn(async ({ data }: { data: Uint8Array }) => {
        pushed.push(Uint8Array.from(data))
      }),
      pullPcm: vi.fn(async () => []),
      closeSession: vi.fn(async () => undefined),
    } as unknown as AudioCodecCapApi
    const session = new AudioCodecSession(
      api,
      {
        codec: 'aac',
        sourceSampleRate: 8000,
        sourceChannels: 1,
        targetSampleRate: 16000,
        targetChannels: 1,
      },
      () => {},
    )
    const rtp = Buffer.concat([Buffer.alloc(12, 0x80), Buffer.from([1, 2, 3, 4, 5, 6])])
    const { view, recycle } = recycledView(rtp)
    session.processPacket(view)
    recycle() // before the decode session resolves
    await vi.waitFor(() => expect(pushed.length).toBe(1), { timeout: 500 })
    expect([...pushed[0]!]).toEqual([1, 2, 3, 4, 5, 6])
    await session.close()
  })
})
