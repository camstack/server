import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'

const KEY_AU = {
  data: new Uint8Array([0, 0, 0, 1, 0x26]),
  ptsMs: 0,
  keyframe: true,
  codec: 'H265' as const,
}

/**
 * The Opus sibling of the "audio (PCMU) push" suite: proves the feeder routes
 * recorded audio through `pushAudioOpus` on the 48 kHz clock when wired for an
 * Opus session (`audioClockRateHz: 48000`), and never touches the PCMU sink.
 */
describe('RecordedFeeder audio (Opus) push', () => {
  it('pushes stored Opus audio on the 48 kHz clock via pushAudioOpus', async () => {
    const pushedOpus: number[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      audioClockRateHz: 48000,
      locate: async ({ epochMs }) =>
        epochMs <= 5200
          ? { kind: 'segment', startMs: 5000, durMs: 200, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [KEY_AU],
      // Two 20 ms Opus AUs (opaque bytes — the feeder only re-stamps them).
      demuxAudio: async () => [
        { data: new Uint8Array([0xfc, 0x01]), ptsMs: 20 },
        { data: new Uint8Array([0xfc, 0x02]), ptsMs: 40 },
      ],
      sink: {
        pushAccessUnit: () => {},
        pushAudioOpus: (_d: Uint8Array, rtpTs48k: number) => pushedOpus.push(rtpTs48k),
      },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(5000)
    await new Promise((r) => setTimeout(r, 150)) // audio at pts 20/40 paced in
    feeder.dispose()
    // 48 kHz, and both tracks now share ONE origin (`FeedOrigin`), so audio
    // is measured from the VIDEO's anchor rather than from its own first
    // sample: the keyframe is at pts 0 and the first audio AU at pts 20, so
    // that 20 ms offset survives as 960 ticks instead of being flattened to
    // 0. That offset is the entire content of lip sync, and per-track
    // anchoring erased it — here at the start and, worse, again at every
    // seek (see `feed-clock.spec.ts`).
    //
    // The ABSOLUTE value never reaches the peer: `writeRecordedAudioOpus`
    // rebases the first recorded frame onto the live stream's continuity
    // (`recordedAudioTsOffset`), once, at the live→recorded switch. What
    // reaches the peer is the SPACING, which is why it is asserted too.
    expect(pushedOpus.length).toBeGreaterThanOrEqual(2)
    expect(pushedOpus[0]).toBe(960)
    expect(pushedOpus[1]).toBe(1920)
    expect(pushedOpus[1]! - pushedOpus[0]!).toBe(960)
  })

  it('prefers pushAudioOpus over pushAudioPcmu when both are present', async () => {
    const opus: number[] = []
    const pcmu: number[] = []
    const feeder = new RecordedFeeder({
      deviceId: 1,
      profile: 'mid',
      audioClockRateHz: 48000,
      locate: async ({ epochMs }) =>
        epochMs <= 5200
          ? { kind: 'segment', startMs: 5000, durMs: 200, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [KEY_AU],
      demuxAudio: async () => [{ data: new Uint8Array([0xfc, 0x03]), ptsMs: 20 }],
      sink: {
        pushAccessUnit: () => {},
        pushAudioOpus: (_d: Uint8Array, ts: number) => opus.push(ts),
        pushAudioPcmu: (_d: Uint8Array, ts: number) => pcmu.push(ts),
      },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(5000)
    await new Promise((r) => setTimeout(r, 150))
    feeder.dispose()
    expect(opus.length).toBeGreaterThanOrEqual(1)
    expect(pcmu.length).toBe(0)
  })

  it('demuxAudio is not invoked for a video-only sink (no audio push fn)', async () => {
    const demuxAudio = vi.fn(async () => [{ data: new Uint8Array([1]), ptsMs: 20 }])
    const feeder = new RecordedFeeder({
      deviceId: 1,
      profile: 'mid',
      audioClockRateHz: 48000,
      locate: async ({ epochMs }) =>
        epochMs <= 5200
          ? { kind: 'segment', startMs: 5000, durMs: 200, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [KEY_AU],
      demuxAudio,
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(5000)
    await new Promise((r) => setTimeout(r, 100))
    feeder.dispose()
    expect(demuxAudio).not.toHaveBeenCalled()
  })
})
