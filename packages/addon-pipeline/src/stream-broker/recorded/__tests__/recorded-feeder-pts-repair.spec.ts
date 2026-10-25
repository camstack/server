import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder, type LocateResult } from '../recorded-feeder'

/**
 * Device 4374 ("Robot piano terra Camera"), 2026-09-06 20:36:28: playback
 * landed, announced `playing`, and then showed one frozen frame until the
 * player was torn down 16 s later. The segments this camera wrote between
 * 20:31:20 and 20:38:35 carry their first (key) frame at PTS 0 and every
 * following frame 53–101 s "later" inside a window the recorder measured at
 * ~10 s. `paceSegment` slept the fabricated 65 s out in silence.
 *
 * These are the two shapes the advance loop must survive: a segment whose media
 * timeline does not fit its declared window, and a range whose segments are not
 * contiguous (the lazy robot stream leaves ~1 s cracks — 1788719780000+9955 vs
 * the next segment at 1788719791000).
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x25 : 0x01]),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

/** The real 4374 shape: IDR at 0, then 149 frames at 73 494 ms + 65 ms steps. */
function brokenSegmentAus(): ReturnType<typeof AU>[] {
  const aus = [AU(0, true)]
  for (let i = 0; i < 149; i++) aus.push(AU(73_494 + i * 65))
  return aus
}

describe('RecordedFeeder — a segment whose PTS do not fit its declared window', () => {
  it('paces the frames instead of sleeping out the fabricated gap', async () => {
    const pushed: number[] = []
    const positions: number[] = []
    const logs: { msg: string; data: Record<string, unknown> }[] = []
    const feeder = new RecordedFeeder({
      deviceId: 4374,
      profile: 'low',
      locate: async ({ epochMs }): Promise<LocateResult> =>
        epochMs < 1788719789955
          ? { kind: 'segment', startMs: 1788719780000, durMs: 9955, bytes: 1259868 }
          : { kind: 'gap', nearestEdgeMs: null, prevEndMs: 1788719789955 },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => brokenSegmentAus(),
      sink: { pushAccessUnit: (_d, rtpTs) => pushed.push(rtpTs) },
      onState: () => {},
      onPosition: (epochMs) => positions.push(epochMs),
      onLog: (msg, data) => logs.push({ msg, data }),
    })

    await feeder.seek(1788719788356)
    // Within a second of real time the paced remainder (cursor → segment end)
    // must have reached the wire. Before the repair the first paced AU was due
    // 65 s after the landing and NOTHING moved.
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(5), { timeout: 3000 })
    // And the playhead moves with them: the census that opened this case
    // carried `cursorMs=1788719788356` — the seek target, untouched.
    await vi.waitFor(() => expect(positions.some((p) => p > 1788719788356)).toBe(true), {
      timeout: 3000,
    })
    feeder.dispose()

    const repair = logs.find((l) => l.msg === 'recorded:segment-pts-repaired')
    expect(repair).toBeDefined()
    expect(repair?.data.startMs).toBe(1788719780000)
    expect(repair?.data.discontinuities).toBe(1)
  })

  it('crosses a real crack between two segments instead of ending playback', async () => {
    const pushedStarts: number[] = []
    const states: string[] = []
    const segments = new Map<number, number>([
      [1788719780000, 9955],
      [1788719791000, 9000],
    ])
    const feeder = new RecordedFeeder({
      deviceId: 4374,
      profile: 'low',
      locate: async ({ epochMs }): Promise<LocateResult> => {
        for (const [startMs, durMs] of segments) {
          if (epochMs >= startMs && epochMs < startMs + durMs)
            return { kind: 'segment', startMs, durMs, bytes: 10 }
        }
        // The 1 045 ms crack, and the end of the range past the last segment.
        const next = [...segments.keys()].find((s) => s > epochMs)
        return { kind: 'gap', nearestEdgeMs: next ?? null, prevEndMs: null }
      },
      readBytes: async ({ startMs }) => new Uint8Array([startMs % 251]),
      demux: async (bytes) => {
        pushedStarts.push(bytes[0] ?? -1)
        return [AU(0, true), AU(40), AU(80)]
      },
      sink: { pushAccessUnit: () => {} },
      onState: (s) => states.push(s.to),
      onPosition: () => {},
    })

    await feeder.seek(1788719789900)
    await vi.waitFor(() => expect(pushedStarts).toContain(1788719791000 % 251), { timeout: 3000 })
    expect(states).not.toContain('ended')
    feeder.dispose()
  })

  it('plays a segment still being written — a short read is footage, not the end', async () => {
    // The recorder's index reports the window it has measured so far; the file
    // on disk holds only part of it. The loop must pace what landed and then
    // ask again, never declare the range over.
    const states: string[] = []
    const pushed: number[] = []
    const feeder = new RecordedFeeder({
      deviceId: 4374,
      profile: 'low',
      locate: async ({ epochMs }): Promise<LocateResult> =>
        epochMs < 1788719800000
          ? { kind: 'segment', startMs: 1788719791000, durMs: 9000, bytes: 400 }
          : { kind: 'gap', nearestEdgeMs: null, prevEndMs: 1788719800000 },
      readBytes: async () => new Uint8Array([7]),
      // Only 3 AUs for a 9 s window: the writer has not flushed the rest.
      demux: async () => [AU(0, true), AU(40), AU(80)],
      sink: { pushAccessUnit: (_d, rtpTs) => pushed.push(rtpTs) },
      onState: (s) => states.push(s.to),
      onPosition: () => {},
    })

    await feeder.seek(1788719791100)
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(1), { timeout: 3000 })
    expect(states).not.toContain('error')
    feeder.dispose()
  })
})
