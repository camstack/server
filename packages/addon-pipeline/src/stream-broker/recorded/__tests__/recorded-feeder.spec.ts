import { describe, it, expect, vi } from 'vitest'
import type {
  FeederStateTransition,
  LocateResult,
  ReadGopFn,
  RecordedFeederDeps,
} from '../recorded-feeder.js'
import { RecordedFeeder } from '../recorded-feeder.js'
import { ScrubFragmentCache } from '../scrub-fragment-cache.js'

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})

function makeDeps() {
  const pushed: number[] = []
  const states: string[] = []
  const positions: number[] = []
  return {
    pushed,
    states,
    positions,
    locate: vi.fn(
      async (args: {
        deviceId: number
        profile: string
        epochMs: number
      }): Promise<LocateResult> =>
        args.epochMs < 9000
          ? { kind: 'segment', startMs: 5000, durMs: 4000, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
    ),
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    demux: vi.fn(async () => [AU(5000, true), AU(5040), AU(5080)]),
    sink: {
      pushAccessUnit: (_data: Uint8Array, rtpTs: number, _codec: 'H264' | 'H265') =>
        pushed.push(rtpTs),
    },
    onState: (s: FeederStateTransition) => {
      states.push(s.to)
    },
    onPosition: (epochMs: number) => positions.push(epochMs),
  }
}

describe('RecordedFeeder.seek', () => {
  it('paints from the target GOP before the full segment resolves and hands frame-step to the full segment', async () => {
    const pushed: number[] = []
    const states: string[] = []
    let fullReadStarted = false
    let releaseFull!: () => void
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 4000, bytes: 3 }),
      readGop: async () => ({
        gopStartMs: 6000,
        gopDurMs: 4000,
        bytes: new Uint8Array([2]),
      }),
      readBytes: async () => {
        fullReadStarted = true
        return await new Promise((resolve) => {
          releaseFull = () => resolve(new Uint8Array([1]))
        })
      },
      demux: async (bytes) =>
        bytes[0] === 2 ? [AU(0, true), AU(40)] : [AU(0, true), AU(1000), AU(1040)],
      sink: {
        pushAccessUnit: (_data, rtpTs) => pushed.push(rtpTs),
      },
      onState: (state) => states.push(state.to),
      onPosition: () => {},
    })
    feeder.setRate(0)

    const seek = feeder.seek(6000)
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    expect(fullReadStarted).toBe(true)
    expect(states.at(-1)).toBe('paused')
    releaseFull()
    await seek

    feeder.stepFrame(1)
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    expect(pushed[1]).toBe(2970)
    feeder.dispose()
  })

  it('does not let the full-segment read contend with target-GOP first paint', async () => {
    const order: string[] = []
    let releaseGop!: () => void
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 4000, bytes: 3 }),
      readGop: async () =>
        await new Promise((resolve) => {
          releaseGop = () => {
            order.push('gop-read')
            resolve({ gopStartMs: 5000, gopDurMs: 4000, bytes: new Uint8Array([2]) })
          }
        }),
      readBytes: async () => {
        order.push('full-read')
        return new Uint8Array([1])
      },
      demux: async (bytes) => {
        order.push(bytes[0] === 2 ? 'gop-demux' : 'full-demux')
        return [AU(0, true), AU(40)]
      },
      sink: {
        pushAccessUnit: () => order.push('paint'),
      },
      onState: () => {},
      onPosition: () => {},
    })

    const seek = feeder.seek(6000)
    await vi.waitFor(() => expect(releaseGop).toBeTypeOf('function'))
    expect(order).not.toContain('full-read')
    releaseGop()
    await seek

    expect(order.indexOf('paint')).toBeLessThan(order.indexOf('full-read'))
    feeder.dispose()
  })

  it('low playback attach reads the segment file ONCE — the prefix is the whole file', async () => {
    // Live 2026-08-22 hall 104: recorded:seek-ready firstFrameMs 533–3142
    // then loadMs another 1–3 s. profile=low uses the whole-segment prefix
    // (readsWholeSegment) and then loadAus read the SAME .m4s again before
    // startAdvance. Attach felt like "seconds" because FUSE paid twice.
    const bytesFromRead = new Uint8Array([1, 2, 3])
    const readBytes = vi.fn(async () => bytesFromRead)
    const demuxAudio = vi.fn(async () => [{ data: new Uint8Array([9]), ptsMs: 0 }])
    const feeder = new RecordedFeeder({
      deviceId: 104,
      profile: 'low',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 10_000, bytes: 180_000 }),
      readGop: async () => ({
        gopStartMs: 5000,
        gopDurMs: 4000,
        bytes: new Uint8Array([9]),
      }),
      readBytes,
      demux: async () => [AU(0, true), AU(40), AU(80)],
      demuxAudio,
      sink: { pushAccessUnit: () => {}, pushAudioPcmu: () => {} },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(5200)
    expect(readBytes).toHaveBeenCalledTimes(1)
    expect(demuxAudio).toHaveBeenCalledTimes(1)
    expect(demuxAudio).toHaveBeenCalledWith(bytesFromRead)
    feeder.dispose()
  })

  it('a hung recorded-audio demux does not freeze the picture, and it SAYS so', async () => {
    // Live hub 8/24-8/25: 4 of 9 `recorded:seek-ready` lines landed at
    // `loadMs - firstFrameMs = 8000 +/- 1 ms`. That await sits between the
    // painted video prefix and `startAdvance`, so the operator saw the first
    // frame at ~2.3 s and then a still image for eight more seconds. It was
    // `SEGMENT_TIMEOUT_MS` with a `.catch(() => [])` on it, and it emitted
    // NOTHING — the freeze had to be found by subtracting two census fields.
    //
    // The wait bought nothing: it ends in `[]` either way. Bounded now, and
    // the drop is logged.
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const feeder = new RecordedFeeder({
      deviceId: 104,
      profile: 'low',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 10_000, bytes: 180_000 }),
      readGop: async () => ({ gopStartMs: 5000, gopDurMs: 4000, bytes: new Uint8Array([9]) }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
      demux: async () => [AU(0, true), AU(40), AU(80)],
      // Never settles — the shape of a stuck ffmpeg/mp4box audio pass.
      demuxAudio: () => new Promise(() => {}),
      sink: { pushAccessUnit: () => {}, pushAudioPcmu: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    const startedAt = Date.now()
    await feeder.seek(5200)
    const elapsed = Date.now() - startedAt
    // The point of the change: nowhere near the 8 s segment deadline.
    expect(elapsed).toBeLessThan(4000)
    const dropped = logs.find((l) => l.msg === 'recorded:seek-audio-dropped')
    expect(dropped?.data).toMatchObject({ budgetMs: 1500 })
    // Still a successful seek — video plays, audio is simply absent.
    expect(logs.find((l) => l.msg === 'recorded:seek-ready')?.data).toMatchObject({
      state: 'playing',
      reusedWhole: true,
    })
    feeder.dispose()
  })

  it('seek-ready names the prefix source and the FUSE vs demux split', async () => {
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const feeder = new RecordedFeeder({
      deviceId: 104,
      profile: 'low',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 10_000, bytes: 180_000 }),
      readGop: async () => ({
        gopStartMs: 5000,
        gopDurMs: 4000,
        bytes: new Uint8Array([9]),
      }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
      demux: async () => [AU(0, true), AU(40), AU(80)],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    await feeder.seek(5200)
    const ready = logs.find((l) => l.msg === 'recorded:seek-ready')
    expect(ready?.data).toMatchObject({
      state: 'playing',
      prefixSource: 'whole',
      reusedWhole: true,
    })
    expect(ready?.data.loadAusMs).toBe(0)
    feeder.dispose()
  })

  it('a cache-hit land still re-reads the file — the 8 s playback stall', async () => {
    // After a drag the session cache holds demuxed AUs, not the raw .m4s.
    // seek() paints from the cache (firstFrame ~hundreds of ms) then loadAus
    // reads the whole file again. Live 2026-08-24: firstFrameMs 135–1040,
    // loadAusMs clustered at ~8000.
    const cache = new ScrubFragmentCache()
    cache.put('low', {
      startMs: 5000,
      durMs: 10_000,
      aus: [AU(0, true), AU(40), AU(80)],
    })
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const feeder = new RecordedFeeder({
      deviceId: 104,
      profile: 'low',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 10_000, bytes: 180_000 }),
      readGop: async () => ({
        gopStartMs: 5000,
        gopDurMs: 4000,
        bytes: new Uint8Array([9]),
      }),
      readBytes,
      fragmentCache: cache,
      demux: async () => [AU(0, true), AU(40), AU(80)],
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg, data) => logs.push({ msg, data }),
    })
    await feeder.seek(5200)
    expect(readBytes).toHaveBeenCalledTimes(1)
    const ready = logs.find((l) => l.msg === 'recorded:seek-ready')
    expect(ready?.data).toMatchObject({
      prefixSource: 'cache',
      reusedWhole: false,
    })
    expect(Number(ready?.data.loadAusMs)).toBeGreaterThanOrEqual(0)
    feeder.dispose()
  })

  it('seek to covered time: emits loading then playing and pushes the segment AUs starting at rtp ts 0', async () => {
    const d = makeDeps()
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: d.locate,
      readBytes: d.readBytes,
      demux: d.demux,
      sink: d.sink,
      onState: d.onState,
      onPosition: d.onPosition,
    })
    await feeder.seek(6000)
    expect(d.states).toContain('loading')
    expect(d.states).toContain('playing')
    expect(d.pushed.length).toBe(3)
    expect(d.pushed[0]).toBe(0)
    feeder.dispose()
  })
  it('seek into a gap: emits gap and pushes nothing', async () => {
    const d = makeDeps()
    d.locate.mockImplementation(
      async (): Promise<LocateResult> => ({
        kind: 'gap',
        nearestEdgeMs: 20_000,
      }),
    )
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: d.locate,
      readBytes: d.readBytes,
      demux: d.demux,
      sink: d.sink,
      onState: d.onState,
      onPosition: d.onPosition,
    })
    await feeder.seek(12000)
    expect(d.states).toContain('gap')
    expect(d.pushed.length).toBe(0)
    feeder.dispose()
  })
})

describe('RecordedFeeder.setRate', () => {
  it('rate 0 pauses; emits paused', async () => {
    const d = makeDeps()
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: d.locate,
      readBytes: d.readBytes,
      demux: d.demux,
      sink: d.sink,
      onState: d.onState,
      onPosition: d.onPosition,
    })
    await feeder.seek(6000)
    feeder.setRate(0)
    expect(d.states).toContain('paused')
    feeder.dispose()
  })
})

describe('RecordedFeeder advance single-flight', () => {
  it('redundant setRate(1) does not start a second advance loop (no double pulls)', async () => {
    vi.useFakeTimers()
    try {
      let locates = 0
      const pushed: number[] = []
      const deps = {
        deviceId: 99,
        profile: 'mid',
        locate: vi.fn(async ({ epochMs }: { epochMs: number }) => {
          locates++
          return {
            kind: 'segment',
            startMs: Math.floor(epochMs / 100) * 100,
            durMs: 100,
            bytes: 3,
          } as const
        }),
        readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
        demux: vi.fn(async () => [
          {
            data: new Uint8Array([0, 0, 0, 1, 0x26]),
            ptsMs: 0,
            keyframe: true,
            codec: 'H265' as const,
          },
        ]),
        sink: {
          pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
        },
        onState: () => {},
        onPosition: () => {},
      }
      const feeder = new RecordedFeeder(deps)
      await feeder.seek(0)
      feeder.setRate(1) // redundant resume — already playing
      feeder.setRate(1) // again
      await vi.advanceTimersByTimeAsync(350) // ~3-4 segments of pacing
      const pushesA = pushed.length
      feeder.dispose()
      // Lower bounds: the loop must actually advance (catches a stalled/crashed loop
      // that would silently pass an upper-bound-only assertion).
      expect(pushesA).toBeGreaterThanOrEqual(2)
      expect(locates).toBeGreaterThanOrEqual(3)
      // Sanity: a single steady loop over 350ms of 100ms segments yields a bounded count (~4-5), NOT doubled.
      expect(pushesA).toBeLessThanOrEqual(6)
      expect(locates).toBeLessThanOrEqual(6)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RecordedFeeder advance forward-only (overlapping segments)', () => {
  it('skips a segment that starts BEHIND the frontier instead of replaying it', async () => {
    vi.useFakeTimers()
    try {
      const reads: number[] = []
      // Overlapping/corrupted store: after the seek segment [5000,9000), the
      // next locate returns an OVERLAPPING segment starting at 6000 (behind the
      // 9000 frontier) — feeding it would replay 6000-9000. A forward segment
      // at 10000 follows. The fixed feeder must skip 6000 and play 10000.
      const locate = vi.fn(async ({ epochMs }: { epochMs: number }) => {
        if (epochMs <= 9000)
          return {
            kind: 'segment',
            startMs: 5000,
            durMs: 4000,
            bytes: 3,
          } as const
        if (epochMs <= 10000)
          return {
            kind: 'segment',
            startMs: 6000,
            durMs: 4000,
            bytes: 3,
          } as const
        if (epochMs <= 14000)
          return {
            kind: 'segment',
            startMs: 10000,
            durMs: 4000,
            bytes: 3,
          } as const
        return { kind: 'gap', nearestEdgeMs: null } as const
      })
      const feeder = new RecordedFeeder({
        deviceId: 99,
        profile: 'mid',
        locate,
        readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
          reads.push(startMs)
          return new Uint8Array([1])
        }),
        demux: vi.fn(async () => [
          {
            data: new Uint8Array([0, 0, 0, 1, 0x26]),
            ptsMs: 0,
            keyframe: true,
            codec: 'H265' as const,
          },
        ]),
        sink: { pushAccessUnit: () => {} },
        onState: () => {},
        onPosition: () => {},
      })
      await feeder.seek(5000)
      await vi.advanceTimersByTimeAsync(9000)
      feeder.dispose()
      // The overlapping segment (6000) must NEVER be read; forward ones (5000,10000) are.
      expect(reads).toContain(5000)
      expect(reads).toContain(10000)
      expect(reads).not.toContain(6000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RecordedFeeder prefetch (no segment-boundary stall)', () => {
  it('reads the NEXT segment while pacing the current one (not after the wait)', async () => {
    vi.useFakeTimers()
    try {
      const reads: number[] = []
      const feeder = new RecordedFeeder({
        deviceId: 99,
        profile: 'mid',
        locate: vi.fn(
          async ({ epochMs }: { epochMs: number }) =>
            ({
              kind: 'segment',
              startMs: Math.floor(epochMs / 1000) * 1000,
              durMs: 1000,
              bytes: 3,
            }) as const,
        ),
        readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
          reads.push(startMs)
          return new Uint8Array([1])
        }),
        demux: vi.fn(async () => [
          {
            data: new Uint8Array([0, 0, 0, 1, 0x26]),
            ptsMs: 0,
            keyframe: true,
            codec: 'H265' as const,
          },
        ]),
        sink: { pushAccessUnit: () => {} },
        onState: () => {},
        onPosition: () => {},
      })
      await feeder.seek(0) // prefix of seg [0,1000); advance paces its remainder
      // Only 100ms into the ~1000ms remaining-window pacing of seg [0,1000):
      // the NEXT segment (1000) must ALREADY be prefetched — without prefetch
      // it is read only after the full wait.
      await vi.advanceTimersByTimeAsync(100)
      expect(reads).toContain(1000)
      expect(reads).not.toContain(2000) // not yet — two segments ahead
      // Into the pacing of seg [1000,2000): its successor (2000) prefetches.
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads).toContain(2000)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RecordedFeeder per-segment clock re-anchor', () => {
  it('timestamps advance strictly across segment boundaries (not just keyframes)', async () => {
    vi.useFakeTimers()
    try {
      const pushed: number[] = []
      // Two 4s segments; each carries a RESET timeline (PTS 0,40,80) like the
      // recorder's -reset_timestamps output.
      const locate = vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 4000) * 4000,
            durMs: 4000,
            bytes: 3,
          }) as const,
      )
      const demux = vi.fn(async () => [
        {
          data: new Uint8Array([0, 0, 0, 1, 0x26]),
          ptsMs: 0,
          keyframe: true,
          codec: 'H265' as const,
        },
        {
          data: new Uint8Array([0, 0, 0, 1, 0x02]),
          ptsMs: 40,
          keyframe: false,
          codec: 'H265' as const,
        },
        {
          data: new Uint8Array([0, 0, 0, 1, 0x02]),
          ptsMs: 80,
          keyframe: false,
          codec: 'H265' as const,
        },
      ])
      const feeder = new RecordedFeeder({
        deviceId: 99,
        profile: 'mid',
        locate,
        readBytes: async () => new Uint8Array([1]),
        demux,
        sink: {
          pushAccessUnit: (_d: Uint8Array, ts: number) => pushed.push(ts),
        },
        onState: () => {},
        onPosition: () => {},
      })
      await feeder.seek(0)
      await vi.advanceTimersByTimeAsync(4200) // advance into the 2nd segment
      feeder.dispose()
      // Without per-segment re-anchor, the 2nd segment's reset PTS would clamp to
      // the 1st segment's last timestamp → duplicates → only the keyframe shows.
      expect(pushed.length).toBeGreaterThanOrEqual(6)
      for (let i = 1; i < pushed.length; i++) {
        expect(pushed[i]!).toBeGreaterThan(pushed[i - 1]!)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RecordedFeeder audio (PCMU) push', () => {
  it('paints the seek frame without waiting for slow audio demux', async () => {
    const pushed: number[] = []
    let releaseAudio!: () => void
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({ kind: 'segment', startMs: 5000, durMs: 4000, bytes: 3 }),
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [AU(0, true)],
      demuxAudio: async () =>
        await new Promise((resolve) => {
          releaseAudio = () => resolve([])
        }),
      sink: {
        pushAccessUnit: () => pushed.push(1),
        pushAudioPcmu: () => {},
      },
      onState: () => {},
      onPosition: () => {},
    })

    const seek = feeder.seek(5000)
    await vi.waitFor(() => expect(pushed).toHaveLength(1))
    let settled = false
    void seek.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseAudio()
    await seek
    feeder.dispose()
  })

  it('pushes transcoded PCMU audio on the 8 kHz clock alongside video (paced remainder)', async () => {
    // Audio is paced with the covering segment's remainder (the seek prefix is
    // video-only decode priming) — wait out the short pace window.
    const pushedAudio: number[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) =>
        epochMs <= 5200
          ? { kind: 'segment', startMs: 5000, durMs: 200, bytes: 3 }
          : { kind: 'gap', nearestEdgeMs: null },
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [AU(0, true)],
      demuxAudio: async () => [
        { data: new Uint8Array(160).fill(0xff), ptsMs: 20 },
        { data: new Uint8Array(160).fill(0xff), ptsMs: 40 },
      ],
      sink: {
        pushAccessUnit: () => {},
        pushAudioPcmu: (_d: Uint8Array, rtpTs8k: number) => pushedAudio.push(rtpTs8k),
      },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(5000)
    await new Promise((r) => setTimeout(r, 150)) // audio at pts 20/40 paced in
    feeder.dispose()
    // 8 kHz, and both tracks share ONE origin (`FeedOrigin`): audio is
    // measured from the VIDEO's anchor, not from its own first sample. The
    // keyframe is at pts 0 and the first audio AU at pts 20, so that 20 ms
    // survives as 160 ticks instead of being flattened to 0 — the offset
    // between the tracks is the whole of lip sync, and per-track anchoring
    // erased it at the start and again at every seek.
    //
    // The ABSOLUTE value never reaches the peer: `writeRecordedAudio` rebases
    // the first recorded frame onto the live stream's continuity, once, at
    // the live→recorded switch. The SPACING is what travels.
    expect(pushedAudio.length).toBeGreaterThanOrEqual(2)
    expect(pushedAudio[0]).toBe(160)
    expect(pushedAudio[1]).toBe(320)
    expect(pushedAudio[1]! - pushedAudio[0]!).toBe(160)
  })

  it('a video-only sink (no pushAudioPcmu) ignores audio without error', async () => {
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({
        kind: 'segment',
        startMs: 5000,
        durMs: 4000,
        bytes: 3,
      }),
      readBytes: async () => new Uint8Array([1]),
      demux: async () => [AU(0, true)],
      demuxAudio: async () => {
        throw new Error('should not be called')
      },
      sink: { pushAccessUnit: () => {} },
      onState: () => {},
      onPosition: () => {},
    })
    await expect(feeder.seek(5000)).resolves.toBeUndefined()
    feeder.dispose()
  })
})

describe('RecordedFeeder per-frame pacing (no burst)', () => {
  it('drips an advance-paced segment over its window instead of dumping it at once', async () => {
    // Real timers: the FIRST segment is fed by seek() (unchanged burst); the
    // advance loop PACES the SECOND segment [1000,1200) with 5 AUs at 40 ms
    // spacing (~25 fps). The 5th AU (PTS 160) must land meaningfully later than
    // the 1st — proving per-PTS pacing replaced the per-segment burst.
    const arrivals: number[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) => {
        if (epochMs < 30) return { kind: 'segment', startMs: 0, durMs: 30, bytes: 3 }
        if (epochMs < 1200) return { kind: 'segment', startMs: 1000, durMs: 200, bytes: 3 }
        return { kind: 'gap', nearestEdgeMs: null }
      },
      readBytes: async ({ startMs }) => new Uint8Array([startMs === 0 ? 1 : 2]),
      demux: async (bytes) =>
        bytes[0] === 1 ? [AU(0, true)] : [AU(0, true), AU(40), AU(80), AU(120), AU(160)],
      sink: { pushAccessUnit: () => arrivals.push(performance.now()) },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(0)
    // Wait out the paced segment window plus slack.
    await new Promise((r) => setTimeout(r, 320))
    feeder.dispose()
    // seek() bursts the first segment (1 AU, unchanged path); the advance loop
    // PACES the second segment (5 AUs). Measure only the paced tail.
    const paced = arrivals.slice(-5)
    const spread = paced.map((t) => t - paced[0]!)
    expect(arrivals.length).toBe(6) // 1 (seek burst) + 5 (paced)
    // Not a burst: the 5th AU (PTS 160 ms) must arrive well after the 1st.
    expect(spread[4]! - spread[0]!).toBeGreaterThanOrEqual(120)
    // Spread is monotonically increasing (drip, not dump).
    for (let i = 1; i < spread.length; i++) {
      expect(spread[i]!).toBeGreaterThanOrEqual(spread[i - 1]!)
    }
  })

  it('interleaves audio with video by PTS within an advance-paced segment (merged schedule)', async () => {
    // The FIRST segment is fed by seek() (unchanged burst path); the advance loop
    // PACES the SECOND segment. We assert interleaving on that second segment:
    // video at PTS 0/100 and audio at PTS 20/40/60/80 must arrive in PTS order.
    // Segment 0 = [0,30) tiny (seek burst); segment 1 = [1000,1200) paced.
    const order: string[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) => {
        if (epochMs < 30) return { kind: 'segment', startMs: 0, durMs: 30, bytes: 3 }
        if (epochMs < 1200) return { kind: 'segment', startMs: 1000, durMs: 200, bytes: 3 }
        return { kind: 'gap', nearestEdgeMs: null }
      },
      readBytes: async ({ startMs }) => new Uint8Array([startMs === 0 ? 1 : 2]),
      // Seek segment: a single AU. Paced (second) segment: 2 video + 4 audio.
      demux: async (bytes) => (bytes[0] === 1 ? [AU(0, true)] : [AU(0, true), AU(100)]),
      demuxAudio: async (bytes) =>
        bytes[0] === 1
          ? []
          : [
              { data: new Uint8Array(160).fill(0xff), ptsMs: 20 },
              { data: new Uint8Array(160).fill(0xff), ptsMs: 40 },
              { data: new Uint8Array(160).fill(0xff), ptsMs: 60 },
              { data: new Uint8Array(160).fill(0xff), ptsMs: 80 },
            ],
      sink: {
        // Only record the paced (second) segment's data (video AU(0)/AU(100) carry
        // byte 0x02; the seek segment's lone AU also carries 0x02 but is filtered
        // by recording AFTER the first audio frame appears).
        pushAccessUnit: () => order.push('v'),
        pushAudioPcmu: () => order.push('a'),
      },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(0)
    await new Promise((r) => setTimeout(r, 360))
    feeder.dispose()
    // Drop the leading seek-segment video (the first 'v' with no audio around it):
    // the paced window is the contiguous v a a a a v tail.
    const firstAudio = order.indexOf('a')
    const paced = order.slice(firstAudio - 1) // include the video right before audio
    expect(paced).toEqual(['v', 'a', 'a', 'a', 'a', 'v'])
  })

  it('aborts pacing promptly on a superseding seek (advance segment tail never lands)', async () => {
    // Seek segment 0 = tiny [0,30). The advance loop then PACES segment [1000,X)
    // with a far-future AU (PTS 5000) so it is still mid-pacing when a newer seek
    // arrives. That abandoned tail must NOT be pushed.
    const tags: string[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async ({ epochMs }) => {
        if (epochMs < 30) return { kind: 'segment', startMs: 0, durMs: 30, bytes: 3 }
        if (epochMs < 9000) return { kind: 'segment', startMs: 1000, durMs: 8000, bytes: 3 }
        return { kind: 'segment', startMs: epochMs, durMs: 8000, bytes: 3 }
      },
      readBytes: async ({ startMs }) =>
        new Uint8Array([startMs === 0 ? 1 : startMs === 1000 ? 3 : 2]),
      demux: async (bytes) => {
        if (bytes[0] === 1)
          return [
            {
              data: new Uint8Array([1]),
              ptsMs: 0,
              keyframe: true,
              codec: 'H265' as const,
            },
          ]
        if (bytes[0] === 3) {
          // Paced segment: an immediate first AU + a far-future tail AU.
          return [
            {
              data: new Uint8Array([3]),
              ptsMs: 0,
              keyframe: true,
              codec: 'H265' as const,
            },
            {
              data: new Uint8Array([9]),
              ptsMs: 5000,
              keyframe: false,
              codec: 'H265' as const,
            },
          ]
        }
        return [
          {
            data: new Uint8Array([2]),
            ptsMs: 0,
            keyframe: true,
            codec: 'H265' as const,
          },
        ]
      },
      sink: {
        pushAccessUnit: (data) =>
          tags.push(
            data[0] === 9
              ? 'paced-late'
              : data[0] === 3
                ? 'paced-first'
                : data[0] === 2
                  ? 'seek2'
                  : 'seek1',
          ),
      },
      onState: () => {},
      onPosition: () => {},
    })
    await feeder.seek(0) // seek seg#0 burst; advance starts pacing seg [1000,9000)
    await new Promise((r) => setTimeout(r, 60))
    await feeder.seek(20000) // supersede while seg [1000,..) PTS-5000 AU is still pending
    await new Promise((r) => setTimeout(r, 60))
    feeder.dispose()
    expect(tags).toContain('paced-first')
    expect(tags).toContain('seek2')
    expect(tags).not.toContain('paced-late') // abandoned advance-segment tail never landed
  })
})

describe('RecordedFeeder error path', () => {
  it('emits error (and does not reject) when a segment read fails', async () => {
    const states: string[] = []
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      locate: async () => ({
        kind: 'segment',
        startMs: 5000,
        durMs: 4000,
        bytes: 3,
      }),
      readBytes: async () => {
        throw new Error('disk fail')
      },
      demux: async () => [],
      sink: { pushAccessUnit: () => {} },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: () => {},
    })
    await expect(feeder.seek(6000)).resolves.toBeUndefined() // does not reject
    expect(states).toContain('error')
    feeder.dispose()
  })
})

describe('RecordedFeeder seek abandonment (latest-wins)', () => {
  it('drops an in-flight seek when a newer seek supersedes it', async () => {
    const states: string[] = []
    const pushedTags: string[] = []
    // seek#1's read never resolves; seek#2 resolves fast. Latest-wins must
    // abandon seek#1's feed so only seek#2's AU lands, and seek#1 must NOT
    // surface an 'error' from its abandoned path. Dispatch is keyed on the
    // located startMs (deterministic, independent of read-call ordering).
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'mid',
      // Park playback on a very long segment so the advance loop does not race
      // more reads into this assertion window.
      locate: async ({ epochMs }) => ({
        kind: 'segment',
        startMs: epochMs,
        durMs: 1_000_000,
        bytes: 3,
      }),
      readBytes: async ({ startMs }) => {
        if (startMs === 6000) return new Promise<Uint8Array>(() => {}) // seek#1: hang forever
        return new Uint8Array([2]) // seek#2
      },
      demux: async (bytes) => [{ data: bytes, ptsMs: 0, keyframe: true, codec: 'H265' as const }],
      sink: {
        pushAccessUnit: (data) => pushedTags.push(data[0] === 2 ? 'two' : 'one'),
      },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: () => {},
    })

    void feeder.seek(6000) // seek#1 — will hang on its read
    await Promise.resolve()
    await feeder.seek(7000) // seek#2 — supersedes; resolves

    expect(pushedTags).toEqual(['two']) // only seek#2's AU landed
    expect(states).not.toContain('error') // abandoned seek#1 stayed silent
    expect(states).toContain('playing')
    feeder.dispose()
  })
})

/**
 * Two adjacent 4s segments with 4 video AUs each (1s apart, keyframe-led),
 * driving the paused-partial-feed + stepFrame suites. Segment 1 = [5000,9000),
 * segment 2 = [9000,13000); PTS are segment-relative (recorder resets them).
 */
function twoSegmentDeps(opts?: { midKeyframe?: boolean }) {
  const pushed: number[] = []
  const states: string[] = []
  const positions: number[] = []
  const mkAus = () => [
    AU(0, true),
    AU(1000),
    { ...AU(2000), keyframe: opts?.midKeyframe === true },
    AU(3000),
  ]
  return {
    pushed,
    states,
    positions,
    deviceId: 99,
    profile: 'mid',
    locate: vi.fn(async ({ epochMs }: { epochMs: number }) => {
      if (epochMs < 5000) return { kind: 'gap', nearestEdgeMs: 5000 } as const
      if (epochMs < 9000)
        return {
          kind: 'segment',
          startMs: 5000,
          durMs: 4000,
          bytes: 3,
        } as const
      if (epochMs < 13000)
        return {
          kind: 'segment',
          startMs: 9000,
          durMs: 4000,
          bytes: 3,
        } as const
      return { kind: 'gap', nearestEdgeMs: null } as const
    }),
    readBytes: vi.fn(async () => new Uint8Array([1])),
    demux: vi.fn(async () => mkAus()),
    sink: {
      pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
    },
    onState: (s: FeederStateTransition) => {
      states.push(s.to)
    },
    onPosition: (epochMs: number) => positions.push(epochMs),
  }
}

const stepTick = () => new Promise<void>((r) => setTimeout(r, 10))

describe('RecordedFeeder paused-seek partial feed', () => {
  it('feeds only the AUs up to the requested epoch and parks the cursor AT it', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(6500) // offset 1500 into [5000,9000) → AUs at pts 0 and 1000 only
    expect(d.pushed.length).toBe(2)
    expect(d.states).toContain('paused')
    expect(d.positions).toContain(6500) // cursor = requested epoch, not segment start/end
    feeder.dispose()
  })

  it('an epoch before/at the first AU still feeds at least the first IDR (never empty)', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(5000)
    expect(d.pushed.length).toBe(1)
    expect(d.positions).toContain(5000)
    feeder.dispose()
  })

  it('an epoch past the last AU feeds the whole segment; cursor stays at the epoch', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(8999) // offset 3999 ≥ last pts 3000 → all 4 AUs
    expect(d.pushed.length).toBe(4)
    expect(d.positions).toContain(8999)
    feeder.dispose()
  })
})

describe('RecordedFeeder stepFrame', () => {
  it('forward within a segment feeds exactly the NEXT AU and reports its position', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(6500) // last fed = pts 1000 (idx 1)
    feeder.stepFrame(1)
    await stepTick()
    expect(d.pushed.length).toBe(3) // exactly one more AU (pts 2000)
    expect(d.positions).toContain(7000) // 5000 + 2000
    feeder.dispose()
  })

  it('queues rapid forward taps instead of dropping all but the first', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(5000)
    feeder.stepFrame(1)
    feeder.stepFrame(1)
    await stepTick()
    expect(d.positions).toContain(6000)
    expect(d.positions).toContain(7000)
    feeder.dispose()
  })

  it('forward at the segment tail crosses into the next segment (first AU, exact position)', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(8999) // all 4 of segment 1 fed
    feeder.stepFrame(1)
    await stepTick()
    expect(d.pushed.length).toBe(5) // + first AU of segment 2
    expect(d.positions).toContain(9000)
    feeder.dispose()
  })

  it('backward within a segment re-feeds from the segment keyframe up to the previous AU', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(8999) // 4 pushes, cursor on pts 3000 (idx 3)
    feeder.stepFrame(-1)
    await stepTick()
    // Target idx 2 (pts 2000); only keyframe is idx 0 → re-feed idx 0..2 (3 pushes).
    expect(d.pushed.length).toBe(7)
    expect(d.positions).toContain(7000)
    feeder.dispose()
  })

  it('backward uses the NEAREST keyframe at-or-before the target (mid-GOP keyframe)', async () => {
    const d = twoSegmentDeps({ midKeyframe: true }) // idx 2 (pts 2000) is a keyframe
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(8999) // 4 pushes, idx 3
    feeder.stepFrame(-1)
    await stepTick()
    expect(d.pushed.length).toBe(5) // target idx 2 IS a keyframe → single re-fed AU
    expect(d.positions).toContain(7000)
    feeder.dispose()
  })

  it('backward at the segment head lands on the LAST frame of the previous segment', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(9000) // segment 2, offset 0 → 1 AU fed (idx 0)
    expect(d.pushed.length).toBe(1)
    feeder.stepFrame(-1)
    await stepTick()
    // Previous segment [5000,9000): re-feed keyframe 0 → target idx 3 (4 pushes).
    expect(d.pushed.length).toBe(5)
    expect(d.positions).toContain(8000) // 5000 + 3000
    feeder.dispose()
  })

  it('forward past the end of the recording is a no-op (stays on the last frame)', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(12999) // last segment, all 4 fed
    const before = d.pushed.length
    feeder.stepFrame(1) // prepareNext → gap(null) → 'ended' → no push
    await stepTick()
    expect(d.pushed.length).toBe(before)
    expect(d.states).not.toContain('error')
    feeder.dispose()
  })

  it('backward into a gap behind the first segment is a no-op', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(5000) // first AU of the FIRST segment
    const before = d.pushed.length
    feeder.stepFrame(-1) // locate(4999) → gap → stay
    await stepTick()
    expect(d.pushed.length).toBe(before)
    feeder.dispose()
  })

  it('atomically pauses playback and advances one frame', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    await feeder.seek(6500)
    const before = d.pushed.length
    feeder.stepFrame(1)
    await stepTick()
    expect(d.states).toContain('paused')
    expect(d.pushed.length).toBe(before + 1)
    expect(d.positions).toContain(7000)
    feeder.dispose()
  })
})

/**
 * Fixture modelling REAL recorder output: consecutive segments have a small
 * inter-segment crack (measured live: 11–17 ms — `durMs` from the muxer is
 * slightly shorter than the gap to the next `startMs`). Segment A = [5000,8990),
 * crack [8990,9007), segment B = [9007,12997). Gap locates report the backward
 * covered edge (`prevEndMs`) alongside the forward one. `tailAu` adds a last AU
 * to segment A whose pts lands AT/PAST `durMs` (real frames can outlive the
 * muxed duration), so the un-clamped cursor would fall into the crack.
 */
function crackDeps(opts?: { tailAu?: boolean }) {
  const pushed: number[] = []
  const states: string[] = []
  const positions: number[] = []
  const mkAus = () => {
    const aus = [AU(0, true), AU(1000), AU(2000), AU(3000)]
    if (opts?.tailAu === true) aus.push(AU(3995))
    return aus
  }
  return {
    pushed,
    states,
    positions,
    deviceId: 99,
    profile: 'mid',
    locate: vi.fn(async ({ epochMs }: { epochMs: number }) => {
      if (epochMs < 5000) return { kind: 'gap', nearestEdgeMs: 5000, prevEndMs: null } as const
      if (epochMs < 8990)
        return {
          kind: 'segment',
          startMs: 5000,
          durMs: 3990,
          bytes: 3,
        } as const
      if (epochMs < 9007) return { kind: 'gap', nearestEdgeMs: 9007, prevEndMs: 8990 } as const
      if (epochMs < 12997)
        return {
          kind: 'segment',
          startMs: 9007,
          durMs: 3990,
          bytes: 3,
        } as const
      return { kind: 'gap', nearestEdgeMs: null, prevEndMs: 12997 } as const
    }),
    readBytes: vi.fn(async () => new Uint8Array([1])),
    demux: vi.fn(async () => mkAus()),
    sink: {
      pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
    },
    onState: (s: FeederStateTransition) => {
      states.push(s.to)
    },
    onPosition: (epochMs: number) => positions.push(epochMs),
  }
}

describe('RecordedFeeder stepFrame across inter-segment cracks', () => {
  it('backward at a segment head crosses the crack via prevEndMs and lands on the previous last frame', async () => {
    const d = crackDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(9007) // segment B head → 1 AU fed
    expect(d.pushed.length).toBe(1)
    feeder.stepFrame(-1)
    await stepTick()
    // locate(9006) is a CRACK gap — the step must hop it via prevEndMs and
    // re-feed segment A keyframe→last (4 pushes), not silently no-op.
    expect(d.pushed.length).toBe(5)
    expect(d.positions).toContain(8000) // 5000 + 3000
    feeder.dispose()
  })

  it('backward with no footage behind (prevEndMs null) stays a clean no-op', async () => {
    const d = crackDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(5000)
    const before = d.pushed.length
    feeder.stepFrame(-1) // locate(4999) → gap { prevEndMs: null } → stay
    await stepTick()
    expect(d.pushed.length).toBe(before)
    expect(d.states).not.toContain('error')
    feeder.dispose()
  })

  it('stepping onto a tail AU clamps the cursor inside coverage so play resumes (no gap freeze)', async () => {
    const d = crackDeps({ tailAu: true })
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(8989) // offset 3989 → AUs pts 0..3000 fed (4)
    expect(d.pushed.length).toBe(4)
    feeder.stepFrame(1) // feeds pts 3995 → un-clamped cursor would be 8995 (in the crack)
    await stepTick()
    expect(d.pushed.length).toBe(5)
    // Cursor must stay inside [startMs, startMs+durMs) — the last covered ms.
    expect(d.positions).toContain(8989)
    expect(d.positions).not.toContain(8995)
    // Play after the step: seek(cursor) must find segment A, not the crack gap.
    feeder.setRate(1)
    await stepTick()
    expect(d.states).toContain('playing')
    expect(d.states).not.toContain('gap')
    feeder.dispose()
  })

  it('backward at a stranded mid-segment GOP head lands on the previous AU, not the segment tail', async () => {
    // Seek paints the target GOP first; the full-segment upgrade then FAILS and
    // leaves that GOP window as currentSegment (startMs = gopStart, idx 0).
    // The old step-back probed seg.startMs−1, loaded the covering segment, and
    // re-fed its LAST AU — a forward jump that looked like a frame-back loop.
    // Probe cursor−1 and land on the last AU strictly before the cursor.
    const pushed: number[] = []
    const positions: number[] = []
    let fullLoadCount = 0
    const feeder = new RecordedFeeder({
      deviceId: 99,
      profile: 'high',
      locate: async ({ epochMs }: { epochMs: number }) => {
        if (epochMs < 5000) return { kind: 'gap', nearestEdgeMs: 5000, prevEndMs: null } as const
        if (epochMs < 17_000)
          return { kind: 'segment', startMs: 5000, durMs: 12_000, bytes: 3 } as const
        return { kind: 'gap', nearestEdgeMs: null, prevEndMs: 17_000 } as const
      },
      readGop: async () => ({
        gopStartMs: 9000,
        gopDurMs: 4000,
        bytes: new Uint8Array([2]),
      }),
      readBytes: async () => {
        fullLoadCount += 1
        if (fullLoadCount === 1) throw new Error('full-segment unavailable')
        return new Uint8Array([1])
      },
      demux: async (bytes: Uint8Array) => {
        if (bytes[0] === 2) return [AU(0, true), AU(1000), AU(2000), AU(3000)]
        return Array.from({ length: 12 }, (_, i) => AU(i * 1000, i === 0))
      },
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number) => {
          pushed.push(ts)
        },
      },
      onState: () => {},
      onPosition: (epochMs: number) => {
        positions.push(epochMs)
      },
    })
    feeder.setRate(0)
    await feeder.seek(9000)
    expect(positions.at(-1)).toBe(9000)
    feeder.stepFrame(-1)
    await stepTick()
    expect(positions.at(-1)).toBe(8000)
    expect(positions).not.toContain(16_000)
    feeder.dispose()
  })
})

describe('RecordedFeeder float-rate pacing', () => {
  /** segA [0,30) 1 AU (seek burst); segB [1000,1800) paced with AUs at pts 0/400. */
  function rateDeps() {
    const pushed: number[] = []
    return {
      pushed,
      deps: {
        deviceId: 99,
        profile: 'mid',
        locate: vi.fn(async ({ epochMs }: { epochMs: number }) => {
          if (epochMs < 30)
            return {
              kind: 'segment',
              startMs: 0,
              durMs: 30,
              bytes: 3,
            } as const
          if (epochMs < 1800)
            return {
              kind: 'segment',
              startMs: 1000,
              durMs: 800,
              bytes: 3,
            } as const
          if (epochMs < 2800)
            return {
              kind: 'segment',
              startMs: 2000,
              durMs: 800,
              bytes: 3,
            } as const
          return { kind: 'gap', nearestEdgeMs: null } as const
        }),
        readBytes: vi.fn(async ({ startMs }: { startMs: number }) =>
          startMs === 0 ? new Uint8Array([1]) : new Uint8Array([2]),
        ),
        demux: vi.fn(async (bytes: Uint8Array) =>
          bytes[0] === 1 ? [AU(0, true)] : [AU(0, true), AU(400)],
        ),
        sink: {
          pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
        },
        onState: () => {},
        onPosition: () => {},
      },
    }
  }

  it('at 2x the paced delivery delay is halved (AU at pts 400 lands at ~200ms wall)', async () => {
    vi.useFakeTimers()
    try {
      const { pushed, deps } = rateDeps()
      const feeder = new RecordedFeeder(deps)
      feeder.setRate(2) // re-enters via seek(0)
      await vi.advanceTimersByTimeAsync(0) // burst segA + start pacing segB (AU pts 0)
      await vi.advanceTimersByTimeAsync(150)
      expect(pushed.length).toBe(2) // AU(400) not due yet (due at ~200ms)
      await vi.advanceTimersByTimeAsync(110) // t ≈ 260ms
      expect(pushed.length).toBe(3)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('at 1x the same AU lands only after ~400ms (control for the 2x case)', async () => {
    vi.useFakeTimers()
    try {
      const { pushed, deps } = rateDeps()
      const feeder = new RecordedFeeder(deps)
      await feeder.seek(0)
      await vi.advanceTimersByTimeAsync(260)
      expect(pushed.length).toBe(2) // AU(400) still pending at 1x
      await vi.advanceTimersByTimeAsync(200) // t ≈ 460ms
      expect(pushed.length).toBe(3)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a mid-play rate change aborts pacing and re-enters from the cursor (seek machinery)', async () => {
    vi.useFakeTimers()
    try {
      const { pushed, deps } = rateDeps()
      const states: string[] = []
      const feeder = new RecordedFeeder({
        ...deps,
        onState: (s: FeederStateTransition) => {
          states.push(s.to)
        },
      })
      await feeder.seek(0)
      await vi.advanceTimersByTimeAsync(100) // mid-pacing of segB
      const loadingCount = states.filter((s) => s === 'loading').length
      feeder.setRate(2)
      await vi.advanceTimersByTimeAsync(50)
      // Re-entry emitted a fresh loading → playing cycle and playback continues.
      expect(states.filter((s) => s === 'loading').length).toBe(loadingCount + 1)
      expect(states.at(-1)).toBe('playing')
      expect(pushed.length).toBeGreaterThan(0)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops audio at rate !== 1 and resumes it on returning to 1x', async () => {
    vi.useFakeTimers()
    try {
      const pushedAudio: number[] = []
      let videoPushes = 0
      const feeder = new RecordedFeeder({
        deviceId: 99,
        profile: 'mid',
        locate: async ({ epochMs }) =>
          epochMs <= 4000
            ? ({ kind: 'segment', startMs: 0, durMs: 4000, bytes: 3 } as const)
            : ({ kind: 'gap', nearestEdgeMs: null } as const),
        readBytes: async () => new Uint8Array([1]),
        demux: async () => [AU(0, true)],
        demuxAudio: async () => [
          { data: new Uint8Array(160).fill(0xff), ptsMs: 0 },
          { data: new Uint8Array(160).fill(0xff), ptsMs: 20 },
        ],
        sink: {
          pushAccessUnit: () => {
            videoPushes++
          },
          pushAudioPcmu: (_d: Uint8Array, ts: number) => pushedAudio.push(ts),
        },
        onState: () => {},
        onPosition: () => {},
      })
      feeder.setRate(2) // → seek(0): burst video, audio DROPPED at 2x
      await vi.advanceTimersByTimeAsync(50)
      expect(videoPushes).toBeGreaterThan(0)
      expect(pushedAudio.length).toBe(0)
      feeder.setRate(1) // → re-seek: audio resumes at 1x
      await vi.advanceTimersByTimeAsync(50)
      expect(pushedAudio.length).toBeGreaterThan(0)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resume after pause continues from the CURSOR, not the segment end (mid-segment)', async () => {
    vi.useFakeTimers()
    try {
      const d = twoSegmentDeps()
      const feeder = new RecordedFeeder(d)
      feeder.setRate(0)
      await feeder.seek(6500) // prefix: pts 0 + 1000 (2 pushes), cursor 6500
      feeder.setRate(1) // resume → seek(6500)
      await vi.advanceTimersByTimeAsync(0)
      // Re-prime prefix only (2 more pushes) — NO whole-segment jump-to-end.
      expect(d.pushed.length).toBe(4)
      expect(d.positions).toContain(6500) // resume point reported immediately
      expect(d.positions).not.toContain(9000) // never the segment end
      // Remainder paced from the cursor: pts 2000 lands ~1s after resume.
      await vi.advanceTimersByTimeAsync(900)
      expect(d.pushed.length).toBe(4)
      await vi.advanceTimersByTimeAsync(200) // t ≈ 1100
      expect(d.pushed.length).toBe(5)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resume exactly at the segment HEAD paces the whole segment from its first frame', async () => {
    vi.useFakeTimers()
    try {
      const d = twoSegmentDeps()
      const feeder = new RecordedFeeder(d)
      feeder.setRate(0)
      await feeder.seek(5000) // prefix: first AU only
      feeder.setRate(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(d.pushed.length).toBe(2) // paused prefix + resume prefix
      expect(d.positions).toContain(5000)
      await vi.advanceTimersByTimeAsync(1100) // pts 1000 paced at ~1s
      expect(d.pushed.length).toBe(3)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resume at the segment TAIL holds the remaining window then crosses to the next segment', async () => {
    vi.useFakeTimers()
    try {
      const d = twoSegmentDeps()
      const feeder = new RecordedFeeder(d)
      feeder.setRate(0)
      await feeder.seek(8999) // prefix: all 4 AUs, cursor 8999 (pts 3000 fed)
      feeder.setRate(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(d.pushed.length).toBe(8) // paused prefix + resume prefix (4+4)
      // Remaining window = durMs 4000 − consumed 3000 = 1000ms; nothing more
      // until segment 2 starts pacing at ~1s.
      await vi.advanceTimersByTimeAsync(900)
      expect(d.pushed.length).toBe(8)
      await vi.advanceTimersByTimeAsync(300) // t ≈ 1200 → seg2 first AU
      expect(d.pushed.length).toBe(9)
      await vi.advanceTimersByTimeAsync(1000) // position interval reports seg2 media time
      expect(d.positions.some((p) => p >= 9000 && p < 13000)).toBe(true)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resume at 2x paces the remainder at half the wall-clock spacing', async () => {
    vi.useFakeTimers()
    try {
      const d = twoSegmentDeps()
      const feeder = new RecordedFeeder(d)
      feeder.setRate(0)
      await feeder.seek(6500) // prefix: 2 pushes, cursor 6500
      feeder.setRate(2) // resume at 2x → remainder pts 2000 due at ~500ms
      await vi.advanceTimersByTimeAsync(0)
      expect(d.pushed.length).toBe(4)
      await vi.advanceTimersByTimeAsync(400)
      expect(d.pushed.length).toBe(4)
      await vi.advanceTimersByTimeAsync(200) // t ≈ 600
      expect(d.pushed.length).toBe(5)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a seek stamps a ≥250ms RTP discontinuity so stale in-flight AUs cannot look contiguous', async () => {
    const d = twoSegmentDeps()
    const feeder = new RecordedFeeder(d)
    feeder.setRate(0)
    await feeder.seek(6500) // pushes ts for pts 0 and 1000
    const lastOldTs = d.pushed.at(-1)!
    await feeder.seek(9000) // scrub commit to another position
    const firstNewTs = d.pushed[2]!
    expect(firstNewTs - lastOldTs).toBeGreaterThanOrEqual(250 * 90)
    feeder.dispose()
  })

  it('position reports track MEDIA time (fed PTS), not segment boundaries', async () => {
    vi.useFakeTimers()
    try {
      const positions: number[] = []
      const feeder = new RecordedFeeder({
        deviceId: 99,
        profile: 'mid',
        locate: async ({ epochMs }) => {
          if (epochMs < 30)
            return {
              kind: 'segment',
              startMs: 0,
              durMs: 30,
              bytes: 3,
            } as const
          if (epochMs < 2200)
            return {
              kind: 'segment',
              startMs: 1000,
              durMs: 1200,
              bytes: 3,
            } as const
          return { kind: 'gap', nearestEdgeMs: null } as const
        },
        readBytes: async ({ startMs }) =>
          startMs === 0 ? new Uint8Array([1]) : new Uint8Array([2]),
        demux: async (bytes) => (bytes[0] === 1 ? [AU(0, true)] : [AU(0, true), AU(500)]),
        sink: { pushAccessUnit: () => {} },
        onState: () => {},
        onPosition: (epochMs) => positions.push(epochMs),
      })
      await feeder.seek(0)
      // Pacing segB [1000,2200): AU(0) at ~0ms, AU(500) at ~500ms. The 1s position
      // tick must report the FED frame's media time (1500), not a boundary.
      await vi.advanceTimersByTimeAsync(1050)
      expect(positions).toContain(1500)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RecordedFeeder feeder-scrub (experimental Task 1 spike)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function scrubDeps() {
    const pushed: number[] = []
    const audioPushed: number[] = []
    const positions: number[] = []
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 1000) * 1000,
            durMs: 1000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      demuxAudio: vi.fn(async () => [{ data: new Uint8Array([9]), ptsMs: 0 }]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
        pushAudioPcmu: (_d: Uint8Array, ts: number) => audioPushed.push(ts),
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    return { deps, pushed, audioPushed, positions }
  }

  it('scrubTo without a prior beginScrub is a no-op', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.scrubTo(6500)
    await flush()
    expect(pushed.length).toBe(0)
    feeder.dispose()
  })

  it('beginScrub + scrubTo pushes exactly one keyframe AU and reports the drag position', async () => {
    const { deps, pushed, positions } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6500)
    await flush()
    expect(pushed.length).toBe(1)
    expect(positions.at(-1)).toBe(6500)
    feeder.dispose()
  })

  it('never pushes audio during scrub (video-only; wantAudio=false skips the transcode)', async () => {
    const { deps, audioPushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6500)
    await flush()
    expect(audioPushed.length).toBe(0)
    expect(deps.demuxAudio).not.toHaveBeenCalled()
    feeder.dispose()
  })

  it('latest-wins: rapid scrubTo collapses to a single push of the latest target', async () => {
    const { deps, pushed, positions } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6500)
    feeder.scrubTo(7500)
    await flush()
    expect(pushed.length).toBe(1)
    expect(positions.at(-1)).toBe(7500)
    feeder.dispose()
  })

  it('stamps a ≥250ms RTP discontinuity before a scrub push once the clock has advanced', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0)
    await feeder.seek(6500) // advances the output clock (paused prefix push)
    const lastOldTs = pushed.at(-1)!
    feeder.beginScrub()
    feeder.scrubTo(9500) // jump to another fragment
    await flush()
    const firstScrubTs = pushed.at(-1)!
    expect(firstScrubTs - lastOldTs).toBeGreaterThanOrEqual(250 * 90)
    feeder.dispose()
  })

  it('a commit seek clears scrub mode — a later scrubTo is a no-op', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0)
    feeder.beginScrub()
    await feeder.seek(6500) // commit: exits scrub via the top-of-seek guard
    const afterCommit = pushed.length
    feeder.scrubTo(7500)
    await flush()
    expect(pushed.length).toBe(afterCommit)
    feeder.dispose()
  })

  it('beginScrub aborts an in-flight advance loop (no further paced pushes)', async () => {
    vi.useFakeTimers()
    try {
      const { deps, pushed } = scrubDeps()
      const feeder = new RecordedFeeder(deps)
      await feeder.seek(6000) // rate 1 → advance loop started
      const afterSeek = pushed.length
      feeder.beginScrub()
      await vi.advanceTimersByTimeAsync(600)
      expect(pushed.length).toBe(afterSeek)
      feeder.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose clears scrub mode — a later scrubTo is a no-op', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.dispose()
    feeder.scrubTo(6500)
    await flush()
    expect(pushed.length).toBe(0)
  })
})

describe('RecordedFeeder feeder-scrub coalescing + same-fragment memo (Task 3)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  /** As `scrubDeps` but captures the pushed AU marker byte so keyframe selection
   *  can be asserted, and the demux fixture is overridable per test. */
  function memoDeps(
    demuxAus?: () => ReadonlyArray<ReturnType<typeof AU>>,
    locateFn?: RecordedFeederDeps['locate'],
  ) {
    const pushed: number[] = []
    const pushedMarkers: number[] = []
    const positions: number[] = []
    const states: string[] = []
    const demux = vi.fn(async () => (demuxAus ? [...demuxAus()] : [AU(0, true), AU(40), AU(80)]))
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const locate: RecordedFeederDeps['locate'] = vi.fn(
      locateFn ??
        (async (args: {
          deviceId: number
          profile: string
          epochMs: number
        }): Promise<LocateResult> => ({
          kind: 'segment',
          startMs: Math.floor(args.epochMs / 1000) * 1000,
          durMs: 1000,
          bytes: 3,
        })),
    )
    const deps: RecordedFeederDeps = {
      deviceId: 99,
      profile: 'mid',
      locate,
      readBytes,
      demux,
      sink: {
        pushAccessUnit: (d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => {
          pushed.push(ts)
          pushedMarkers.push(d[4] ?? -1)
        },
      },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    return {
      deps,
      pushed,
      pushedMarkers,
      positions,
      states,
      demux,
      readBytes,
      locate,
    }
  }

  it('same-fragment memo: consecutive targets in one fragment call locate/readBytes/demux once', async () => {
    const d = memoDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // fragment [6000,7000)
    await flush()
    feeder.scrubTo(6900) // SAME fragment — memo hit; forward → SWEEP (delta AUs)
    await flush()
    expect(d.pushed.length).toBe(3) // jump IDR, then the 2 predicted frames swept
    expect(d.demux).toHaveBeenCalledTimes(1) // demux only once
    expect(d.readBytes).toHaveBeenCalledTimes(1) // readBytes only once
    // Coverage of a demuxed fragment IS proof of footage — the warm tick must
    // not pay the locate RPC (measured at 1–8 s on the saturated hub) at all.
    expect(d.locate).toHaveBeenCalledTimes(1)
    feeder.dispose()
  })

  it('crossing into a NEW fragment re-reads + re-demuxes (memo invalidated)', async () => {
    const d = memoDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // fragment [6000,7000)
    await flush()
    feeder.scrubTo(8100) // DIFFERENT fragment [8000,9000)
    await flush()
    expect(d.pushed.length).toBe(2)
    expect(d.demux).toHaveBeenCalledTimes(2)
    expect(d.readBytes).toHaveBeenCalledTimes(2)
    feeder.dispose()
  })

  it('latest-wins: three rapid scrubTo within the window push only the latest target once', async () => {
    const d = memoDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6100)
    feeder.scrubTo(6500)
    feeder.scrubTo(6900)
    await flush()
    expect(d.pushed.length).toBe(1)
    expect(d.positions.at(-1)).toBe(6900) // clamped drag target of the LATEST move
    expect(d.demux).toHaveBeenCalledTimes(1)
    feeder.dispose()
  })

  it('picks the nearest keyframe ≤ target (not always the fragment IDR)', async () => {
    // Fragment AUs: idx0 IDR (pts0), idx1 delta (pts40), idx2 keyframe (pts80).
    // A target with offset ≥ 80 ms must push idx2, not idx0.
    const d = memoDeps(() => [
      {
        data: new Uint8Array([0, 0, 0, 1, 10]),
        ptsMs: 0,
        keyframe: true,
        codec: 'H265' as const,
      },
      {
        data: new Uint8Array([0, 0, 0, 1, 11]),
        ptsMs: 40,
        keyframe: false,
        codec: 'H265' as const,
      },
      {
        data: new Uint8Array([0, 0, 0, 1, 12]),
        ptsMs: 80,
        keyframe: true,
        codec: 'H265' as const,
      },
    ])
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6500) // offset 500 ≥ 80 → nearest keyframe at-or-before = idx2
    await flush()
    expect(d.pushedMarkers).toEqual([12]) // idx2's marker byte
    feeder.dispose()
  })

  it('a keyframe-selection target before the mid-GOP keyframe still pushes the IDR (idx0)', async () => {
    const d = memoDeps(() => [
      {
        data: new Uint8Array([0, 0, 0, 1, 10]),
        ptsMs: 0,
        keyframe: true,
        codec: 'H265' as const,
      },
      {
        data: new Uint8Array([0, 0, 0, 1, 11]),
        ptsMs: 40,
        keyframe: false,
        codec: 'H265' as const,
      },
      {
        data: new Uint8Array([0, 0, 0, 1, 12]),
        ptsMs: 80,
        keyframe: true,
        codec: 'H265' as const,
      },
    ])
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6050) // offset 50 < 80 → mid-GOP keyframe not yet reached → idx0
    await flush()
    expect(d.pushedMarkers).toEqual([10])
    feeder.dispose()
  })

  it('a gap target holds the last frame (no push, no error state)', async () => {
    const d = memoDeps(undefined, async ({ epochMs }: { epochMs: number }) =>
      epochMs >= 8000
        ? ({ kind: 'gap', nearestEdgeMs: null } as const)
        : ({ kind: 'segment', startMs: 6000, durMs: 1000, bytes: 3 } as const),
    )
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // real fragment → one push
    await flush()
    feeder.scrubTo(9000) // gap → hold
    await flush()
    expect(d.pushed.length).toBe(1) // gap target added no push
    expect(d.states).not.toContain('error')
    feeder.dispose()
  })

  it('stamps a ≥250ms discontinuity before EACH scrub push once the clock has advanced', async () => {
    const d = memoDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.setRate(0)
    await feeder.seek(6500) // advances the output clock (paused prefix push)
    const lastSeek = d.pushed.at(-1)!
    feeder.beginScrub()
    feeder.scrubTo(9100) // fragment [9000,10000)
    await flush()
    const scrubA = d.pushed.at(-1)!
    feeder.scrubTo(11100) // fragment [11000,12000) — a distinct push
    await flush()
    const scrubB = d.pushed.at(-1)!
    expect(scrubA - lastSeek).toBeGreaterThanOrEqual(250 * 90)
    expect(scrubB - scrubA).toBeGreaterThanOrEqual(250 * 90)
    feeder.dispose()
  })

  it('bounds concurrency: moves during one in-flight tick do not each spawn a demux (latest-wins)', async () => {
    // Model real ffmpeg latency with a demux the test releases manually. While
    // one tick's load is in flight, additional moves must only update the pending
    // target — never start a parallel demux (the review-HIGH property).
    let releaseDemux: (aus: ReadonlyArray<ReturnType<typeof AU>>) => void = () => {}
    const gate = new Promise<ReadonlyArray<ReturnType<typeof AU>>>((r) => {
      releaseDemux = (aus) => r(aus)
    })
    const pushed: number[] = []
    const positions: number[] = []
    const demux = vi.fn(async (): Promise<ReturnType<typeof AU>[]> => [...(await gate)])
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate: async (args: { deviceId: number; profile: string; epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: Math.floor(args.epochMs / 1000) * 1000,
          durMs: 1000,
          bytes: 3,
        }) as const,
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux,
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // leading-edge tick starts, hangs on the gated demux
    await flush()
    expect(demux).toHaveBeenCalledTimes(1)
    feeder.scrubTo(6200) // arrives DURING the in-flight load → coalesce only
    feeder.scrubTo(6300)
    await flush()
    expect(demux).toHaveBeenCalledTimes(1) // no parallel demux spawned
    expect(pushed.length).toBe(0) // nothing pushed until the load resolves
    releaseDemux([AU(0, true)])
    await flush()
    expect(pushed.length).toBe(1) // the single in-flight tick pushed once
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub commit / exit (Task 4)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function scrubDeps() {
    const pushed: number[] = []
    const states: string[] = []
    const positions: number[] = []
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 1000) * 1000,
            durMs: 1000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    return { deps, pushed, states, positions }
  }

  it('scrubCommit: seek() during scrub clears scrub state and resumes at the preserved rate (rate 0 → paused)', async () => {
    const { deps, states } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0) // rate preserved across the drag
    feeder.beginScrub()
    feeder.scrubTo(6100)
    await flush()
    await feeder.seek(6500) // commit
    expect(states).toContain('paused') // resumed at the preserved rate 0
    const before = deps.readBytes.mock.calls.length
    feeder.scrubTo(7100) // scrub is cleared → no-op
    await flush()
    expect(deps.readBytes.mock.calls.length).toBe(before)
    feeder.dispose()
  })

  it('seek() during scrub aborts a pending scrubTick (no scrub push after commit)', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0)
    feeder.beginScrub()
    feeder.scrubTo(6100) // arms the leading-edge (0ms) tick
    await feeder.seek(9500) // commit BEFORE the tick fires — must cancel it
    await flush()
    // Only the commit seek's paused prefix landed; the aborted scrub tick pushed
    // nothing (its 0ms timer was cleared by seek()).
    expect(deps.locate.mock.calls.some(([a]) => a.epochMs === 6100)).toBe(false)
    expect(pushed.length).toBeGreaterThan(0) // the commit seek fed its prefix
    feeder.dispose()
  })

  it('setRate mid-scrub re-enters via seek, clears scrub, and resumes playing', async () => {
    const { deps, states } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub() // rate defaults to 1
    feeder.scrubTo(6100)
    await flush()
    feeder.setRate(2) // re-enters via seek(cursor) → clears scrub, paces at 2x
    await flush()
    expect(states).toContain('playing')
    const before = deps.readBytes.mock.calls.length
    feeder.scrubTo(7100) // scrub cleared → no-op
    await flush()
    expect(deps.readBytes.mock.calls.length).toBe(before)
    feeder.dispose()
  })

  it('stepFrame is ignored while scrubbing (the drag owns the track)', async () => {
    const { deps, pushed } = scrubDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0)
    feeder.beginScrub()
    const before = pushed.length
    feeder.stepFrame(1)
    feeder.stepFrame(-1)
    await flush()
    expect(pushed.length).toBe(before)
    feeder.dispose()
  })

  it('re-entrant beginScrub mid-demux is a NO-OP: the in-flight tick completes and the queued move is served (no aborted work)', async () => {
    // AMENDED (scrub-ux fix): `beginScrub` while already scrubbing is now a NO-OP
    // (the app may re-send `scrubStart` mid-gesture; aborting in-flight keyframe
    // work on each re-send was the stutter root cause). So a re-entrant beginScrub
    // no longer bumps the generation or reclaims the timer slot — the in-flight
    // tick keeps ownership, pushes its frame, and re-arms for the queued move.
    // The ORIGINAL test asserted the OPPOSITE (re-entry = a new drag that aborts
    // the stale tick); under the new semantics a genuinely new drag is always
    // preceded by a commit `seek()` (mode exit), so back-to-back beginScrub is
    // ONLY ever a within-drag re-send, which must NOT abort work.
    let releaseDemux: (aus: ReadonlyArray<ReturnType<typeof AU>>) => void = () => {}
    const gate = new Promise<ReadonlyArray<ReturnType<typeof AU>>>((r) => {
      releaseDemux = (aus) => r(aus)
    })
    let gated = true
    const pushed: number[] = []
    const demux = vi.fn(async (): Promise<ReturnType<typeof AU>[]> => {
      if (gated) return [...(await gate)]
      return [AU(0, true), AU(500), AU(900)]
    })
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate: async (args: { deviceId: number; profile: string; epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: Math.floor(args.epochMs / 1000) * 1000,
          durMs: 1000,
          bytes: 3,
        }) as const,
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux,
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: () => {},
      onPosition: () => {},
    }
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // tick A starts, hangs on the gated demux
    await flush()
    expect(demux).toHaveBeenCalledTimes(1)
    gated = false
    feeder.beginScrub() // re-entrant scrubStart WITHIN the drag → NO-OP (no token bump)
    feeder.scrubTo(7100) // queues onto the in-flight tick's slot (latest-wins)
    await flush()
    releaseDemux([AU(0, true)]) // tick A resolves → pushes 6100
    await flush()
    await new Promise((r) => setTimeout(r, 150)) // > SCRUB_COALESCE_MS window
    await flush()
    // The tick was NOT superseded: it pushed its own frame AND re-armed for the
    // queued 7100 move — both targets demuxed + pushed, none aborted.
    expect(demux).toHaveBeenCalledTimes(2)
    expect(pushed.length).toBe(2)
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub keyframe demux + cache + prefetch (frequency)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  /**
   * Scrub deps over the FULL demux (the scrub path demuxes the whole GOP for
   * sweep mode). `readBytes` encodes the fragment `startMs` (LE) so the demux
   * can gate a specific fragment for the teardown race; it returns a single
   * keyframe AU (the real keyframe-only demux contract).
   */
  function freqDeps() {
    const pushed: number[] = []
    const positions: number[] = []
    let gateRelease: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      gateRelease = () => r()
    })
    let gatedStart: number | null = null // arm gating for exactly this fragment
    const decodeStart = (b: Uint8Array) =>
      (b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24)
    // The FULL demux — also the scrub path's seam since sweep mode.
    const demux = vi.fn(async (b: Uint8Array) => {
      if (gatedStart !== null && decodeStart(b) === gatedStart) {
        gatedStart = null // one-shot: only the first call to this fragment hangs
        await gate
      }
      return [AU(0, true)]
    })
    const readBytes = vi.fn(
      async ({ startMs }: { startMs: number }) =>
        new Uint8Array([
          startMs & 0xff,
          (startMs >> 8) & 0xff,
          (startMs >> 16) & 0xff,
          (startMs >> 24) & 0xff,
        ]),
    )
    const locate = vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: Math.floor(epochMs / 1000) * 1000,
          durMs: 1000,
          bytes: 4,
        }) as const,
    )
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate,
      readBytes,
      demux,
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    return {
      deps,
      pushed,
      positions,
      demux,
      readBytes,
      locate,
      armGate: (startMs: number) => {
        gatedStart = startMs
      },
      releaseGate: () => gateRelease?.(),
    }
  }

  it('the scrub path uses the FULL demux — sweep mode pushes predicted frames, so the whole GOP is demuxed', async () => {
    const d = freqDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6500)
    await flush()
    expect(d.demux).toHaveBeenCalledTimes(1)
    expect(d.pushed.length).toBe(1)
    feeder.dispose()
  })

  it('cache hit: revisiting a fragment pushes without re-demuxing it', async () => {
    const d = freqDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(6100) // fragment 6000 — demux (miss)
    await flush()
    feeder.scrubAck() // renderer keeps up: each pushed frame is acknowledged
    feeder.scrubTo(8100) // fragment 8000 — demux (miss); moves memo off 6000
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(6100) // fragment 6000 REVISIT — LRU cache hit, no re-demux
    await flush()
    expect(d.pushed.length).toBe(3) // every move pushed a keyframe
    expect(d.demux).toHaveBeenCalledTimes(2) // only 6000 + 8000; revisit cached
    feeder.dispose()
  })

  /*
   * REMOVED: 'direction-aware prefetch fills the cache WITHOUT pushing; crossing
   * in is a cache hit'. The directional prefetch is gone (2026-08-26) — see the
   * tombstone in `recorded-feeder.ts` and the field numbers in
   * `scrub-prefetch.spec.ts`. Nothing to fill the cache without pushing, because
   * nothing speculates during a drag any more.
   */

  it('a re-entrant beginScrub mid-drag is a NO-OP — the drag and its warm cache survive', async () => {
    // `beginScrub` while already scrubbing must not tear the drag down. A real
    // teardown is a commit `seek()` or `dispose()`.
    //
    // This used to be pinned through the directional prefetch: arm a gate on a
    // speculative demux, re-enter `beginScrub` mid-flight, and check the
    // speculation still landed. With speculation gone the vehicle is gone, but
    // the RULE is not — so it is pinned directly, on the thing an operator would
    // actually notice: the fragments this drag already paid for are still warm
    // on the other side of the re-entrant call.
    const d = freqDeps()
    const demuxCountFor = (startMs: number) =>
      d.demux.mock.calls.filter(([b]) => {
        const u = b as Uint8Array
        return (
          ((u[0] ?? 0) | ((u[1] ?? 0) << 8) | ((u[2] ?? 0) << 16) | ((u[3] ?? 0) << 24)) === startMs
        )
      }).length
    const feeder = new RecordedFeeder(d.deps)
    feeder.beginScrub()
    feeder.scrubTo(1100)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(2100)
    await flush()
    feeder.scrubAck()
    expect(demuxCountFor(1000)).toBe(1)

    feeder.beginScrub() // re-entrant, WITHIN the drag → no-op

    // Revisiting fragment 1000 re-pushes from cache: no second demux. Had the
    // re-entrant call torn the drag down, the cache would have gone with it.
    feeder.scrubTo(1100)
    await flush()
    expect(demuxCountFor(1000)).toBe(1)
    expect(d.pushed.length).toBeGreaterThan(2)
    feeder.dispose()
  })

  it('the fragment cache SURVIVES a commit seek — a later revisit re-pushes with zero re-demux', async () => {
    // Footage is immutable and the next drag routinely revisits the committed
    // moment; clearing on commit used to throw away exactly the fragments the
    // timeline warm-up paid for. Only the LRU bound evicts now.
    const d = freqDeps()
    const feeder = new RecordedFeeder(d.deps)
    feeder.setRate(0)
    feeder.beginScrub()
    feeder.scrubTo(6100) // frag 6000 cached
    await flush()
    await feeder.seek(9000) // commit — the cache is kept
    const beforeRevisit = d.demux.mock.calls.length
    feeder.beginScrub()
    feeder.scrubTo(6100) // frag 6000 — a coverage hit, no re-demux
    await flush()
    expect(d.demux.mock.calls.length).toBe(beforeRevisit)
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub — GOP byte-range reads + session cache (warm-up)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  /** 12 s segments of three 4 s GOPs; `readGop` answers the covering GOP by
   *  byte range. 8 AUs per GOP at 500 ms, IDR first.
   *
   *  Pinned to a NON-scrub profile on purpose. D31's targeted GOP read is still
   *  the contract everywhere the segment is too big to be a scrub unit — a
   *  `high` segment is ~5 MB — and this suite is what holds it. The scrub
   *  profile took the opposite trade in D163 (one sequential whole-segment read
   *  that serves every tick inside those ten seconds), and `scrub-segment-unit`
   *  holds THAT. Both are true; the profile is the fork. */
  function gopDeps(fragmentCache?: ScrubFragmentCache) {
    const pushed: number[] = []
    const positions: number[] = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const GOP_AUS = Array.from({ length: 8 }, (_, i) => AU(i * 500, i === 0))
    const locate = vi.fn(
      async (_args: {
        deviceId: number
        profile: string
        epochMs: number
      }): Promise<LocateResult> => ({
        kind: 'segment',
        startMs: Math.floor(_args.epochMs / 12_000) * 12_000,
        durMs: 12_000,
        bytes: 3,
      }),
    )
    const readGop = vi.fn<ReadGopFn>(async ({ segmentStartMs, epochMs }) => {
      const gopIdx = Math.floor((epochMs - segmentStartMs) / 4_000)
      return {
        gopStartMs: segmentStartMs + gopIdx * 4_000,
        gopDurMs: 4_000,
        bytes: new Uint8Array([gopIdx]),
      }
    })
    const readBytes = vi.fn(
      async (_args: { deviceId: number; profile: string; startMs: number }) =>
        new Uint8Array([9, 9, 9]),
    )
    const demux = vi.fn(async (_segmentBytes: Uint8Array) => GOP_AUS)
    const deps = {
      deviceId: 101,
      profile: 'high',
      locate,
      readBytes,
      readGop,
      fragmentCache,
      demux,
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    } satisfies RecordedFeederDeps
    return { deps, pushed, positions, logs, locate, readGop, readBytes, demux, GOP_AUS }
  }

  it('a scrub tick reads ONE GOP by byte range — the whole-segment read never runs', async () => {
    const h = gopDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_005_200) // segment [996 000), GOP [1 004 000, 1 008 000)
    await flush()
    expect(h.pushed.length).toBe(1)
    expect(h.readGop).toHaveBeenCalledTimes(1)
    expect(h.readGop.mock.calls[0]![0]).toMatchObject({ epochMs: 1_005_200 })
    // D31's letter on this path: no whole-segment fetch behind the GOP read.
    expect(h.readBytes).not.toHaveBeenCalled()
    // The demux consumed the GOP's bytes, not segment bytes.
    expect(h.demux.mock.calls[0]![0]).toEqual(new Uint8Array([2]))
    // Position lands inside the GOP window.
    expect(h.positions.at(-1)).toBeGreaterThanOrEqual(1_004_000)
    expect(h.positions.at(-1)).toBeLessThan(1_008_000)
    feeder.dispose()
  })

  it('high play/seek never warms a low window — GOP + one full high read, then stop', async () => {
    const h = gopDeps()
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(1_005_200)
    await flush()
    expect(h.readGop).toHaveBeenCalled()
    expect(h.readGop.mock.calls.every((c) => c[0].profile === 'high')).toBe(true)
    expect(h.readBytes.mock.calls.every((c) => !c[0] || c[0].profile === 'high')).toBe(true)
    expect(h.readBytes.mock.calls.length).toBeLessThan(5)
    expect(h.logs.filter((l) => l.msg === 'scrub-feeder:warm-start')).toHaveLength(0)
    feeder.dispose()
  })

  it('consecutive targets inside a warm fragment skip locate ENTIRELY (the 1–8 s RPC leaves the drag path)', async () => {
    const h = gopDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_004_200)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(1_005_700) // same GOP — coverage is proof, no locate
    await flush()
    expect(h.pushed.length).toBeGreaterThan(1)
    expect(h.locate).toHaveBeenCalledTimes(1)
    expect(h.readGop).toHaveBeenCalledTimes(1)
    feeder.dispose()
  })

  it('a pre-warmed session cache serves the FIRST drag tick with zero RPCs', async () => {
    const cache = new ScrubFragmentCache()
    const h = gopDeps(cache)
    cache.put('high', { startMs: 1_004_000, durMs: 4_000, aus: h.GOP_AUS })
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_005_200)
    await flush()
    expect(h.pushed.length).toBe(1)
    expect(h.locate).not.toHaveBeenCalled()
    expect(h.readGop).not.toHaveBeenCalled()
    expect(h.demux).not.toHaveBeenCalled()
    feeder.dispose()
  })

  it('the fragment cache SURVIVES the commit — the next drag revisits without a re-read', async () => {
    const cache = new ScrubFragmentCache()
    const h = gopDeps(cache)
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    feeder.beginScrub()
    feeder.scrubTo(1_005_200)
    await flush()
    expect(h.readGop).toHaveBeenCalledTimes(1)
    await feeder.seek(1_005_200) // the commit tears scrub down…
    feeder.beginScrub() // …and the NEXT drag revisits the same moment
    feeder.scrubTo(1_005_400)
    await flush()
    expect(h.readGop).toHaveBeenCalledTimes(1) // still one — served from the session cache
    feeder.dispose()
  })
})

describe('RecordedFeeder — seek travel animation (bounded by BUDGET, lands exact)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  /** 12 s segments of three 4 s GOPs served by readGop; 8 AUs per GOP, IDR
   *  first. Fast test budgets via the seekAnimation seam. */
  // `readGopDelayMs` names the slow FETCH, whichever read serves it: the scrub
  // unit is the whole segment on `low` (D163), so the delay has to sit on both.
  function travelDeps(over: { readGopDelayMs?: number; budgetMs?: number; tickMs?: number } = {}) {
    const pushed: Array<{ ts: number; sync: boolean }> = []
    const positions: number[] = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const GOP_AUS = Array.from({ length: 8 }, (_, i) => AU(i * 500, i === 0))
    const readGop = vi.fn(
      async ({ segmentStartMs, epochMs }: { segmentStartMs: number; epochMs: number }) => {
        if (over.readGopDelayMs) await new Promise((r) => setTimeout(r, over.readGopDelayMs))
        const gopIdx = Math.floor((epochMs - segmentStartMs) / 4_000)
        return {
          gopStartMs: segmentStartMs + gopIdx * 4_000,
          gopDurMs: 4_000,
          bytes: new Uint8Array([gopIdx]),
        }
      },
    )
    const deps = {
      deviceId: 101,
      profile: 'low',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 12_000) * 12_000,
            durMs: 12_000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => {
        if (over.readGopDelayMs) await new Promise((r) => setTimeout(r, over.readGopDelayMs))
        return new Uint8Array([9])
      }),
      readGop,
      demux: vi.fn(async () => GOP_AUS),
      seekAnimation: {
        budgetMs: over.budgetMs ?? 150,
        tickMs: over.tickMs ?? 10,
        maxStills: 16,
        minDistanceMs: 8_000,
      },
      sink: {
        pushAccessUnit: (d: Uint8Array, ts: number, _c: 'H264' | 'H265') =>
          pushed.push({ ts, sync: (d[4] ?? 0) === 0x26 }),
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, pushed, positions, logs, readGop }
  }

  it('THE test: a long seek produces more than one displayed frame, and the LAST position is exactly the target', async () => {
    const h = travelDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000) // primes the screen
    const before = h.pushed.length
    await feeder.seek(1_100_000) // 100 s away — must travel, not teleport
    const landed = h.pushed.slice(before)
    // Landing alone would be ≤ 8 AUs (one demuxed fragment). More proves the
    // travel stills went on the wire; each is an independently-decodable IDR.
    expect(landed.length).toBeGreaterThan(8)
    // Intermediate positions travel from → to, monotonically forward…
    const travelPositions = h.positions.filter((p) => p > 1_000_000 && p < 1_100_000)
    expect(travelPositions.length).toBeGreaterThan(0)
    for (let i = 1; i < travelPositions.length; i++) {
      expect(travelPositions[i]!).toBeGreaterThanOrEqual(travelPositions[i - 1]!)
    }
    // …and the animation did not drift: the LAST position is the exact target.
    expect(h.positions.at(-1)).toBe(1_100_000)
    const line = h.logs.find((l) => l.msg === 'recorded:seek-travel')
    expect(line?.data).toMatchObject({ fromMs: 1_000_000, toMs: 1_100_000 })
    feeder.dispose()
  })

  it('bounded by BUDGET, not distance: a 4-hour seek pushes at most maxStills and lands inside the budget', async () => {
    const h = travelDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000)
    const t0 = performance.now()
    await feeder.seek(1_000_000 + 4 * 3_600_000)
    const elapsed = performance.now() - t0
    const line = h.logs.find((l) => l.msg === 'recorded:seek-travel')
    expect(line).toBeDefined()
    expect(line!.data.stills as number).toBeLessThanOrEqual(16)
    expect(elapsed).toBeLessThan(1_000) // 150 ms budget + landing, with slack
    expect(h.positions.at(-1)).toBe(1_000_000 + 4 * 3_600_000)
    feeder.dispose()
  })

  it('a short seek (≤ 2 GOPs) does not animate — there is nothing between to show', async () => {
    const h = travelDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000)
    const before = h.pushed.length
    await feeder.seek(1_004_000) // one GOP over — sub-threshold
    expect(h.pushed.length - before).toBeLessThanOrEqual(8) // the landing only
    expect(h.logs.some((l) => l.msg === 'recorded:seek-travel')).toBe(false)
    feeder.dispose()
  })

  it('the FIRST seek of a fresh feeder never animates (no travel-from exists)', async () => {
    const h = travelDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_100_000)
    expect(h.logs.some((l) => l.msg === 'recorded:seek-travel')).toBe(false)
    expect(h.positions.at(-1)).toBe(1_100_000)
    feeder.dispose()
  })

  it('a newer seek abandons the in-flight animation immediately and owns the landing', async () => {
    const h = travelDeps({ budgetMs: 300, tickMs: 20 })
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000)
    const seekA = feeder.seek(2_000_000) // long travel — will be superseded
    await new Promise((r) => setTimeout(r, 60))
    await feeder.seek(1_500_000) // the operator changed their mind
    await seekA
    await flush()
    expect(h.positions.at(-1)).toBe(1_500_000)
    feeder.dispose()
  })

  it('slow fetches SHORTEN the animation — it lands early instead of queueing', async () => {
    const h = travelDeps({ readGopDelayMs: 60, budgetMs: 150, tickMs: 10 })
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000)
    await feeder.seek(1_100_000)
    const line = h.logs.find((l) => l.msg === 'recorded:seek-travel')
    // ~60 ms per fetch inside a 150 ms budget ⇒ at most 2 stills made it.
    if (line) expect(line.data.stills as number).toBeLessThanOrEqual(2)
    expect(h.positions.at(-1)).toBe(1_100_000) // landing is never optional
    feeder.dispose()
  })

  it('a scrub-commit seek does NOT animate — the drag already showed the travel', async () => {
    const h = travelDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(1_000_000)
    feeder.beginScrub()
    feeder.scrubTo(1_002_000)
    await flush()
    await feeder.seek(1_100_000) // the commit
    expect(h.logs.some((l) => l.msg === 'recorded:seek-travel')).toBe(false)
    expect(h.positions.at(-1)).toBe(1_100_000)
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub — jump travel from the WARM cache (drag flings)', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function jumpTravelDeps(cache: ScrubFragmentCache) {
    const pushed: Array<{ sync: boolean }> = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    // Every read the feeder issues, whichever API serves it: the scrub unit is
    // the whole segment on `low` (D163), and this suite is about what travel
    // costs, not about which call makes it.
    const reads = { count: 0 }
    const GOP_AUS = Array.from({ length: 8 }, (_, i) => AU(i * 500, i === 0))
    const readGop = vi.fn(
      async ({ segmentStartMs, epochMs }: { segmentStartMs: number; epochMs: number }) => {
        const gopIdx = Math.floor((epochMs - segmentStartMs) / 4_000)
        return {
          gopStartMs: segmentStartMs + gopIdx * 4_000,
          gopDurMs: 4_000,
          bytes: new Uint8Array([gopIdx]),
        }
      },
    )
    const deps = {
      deviceId: 101,
      profile: 'low',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 12_000) * 12_000,
            durMs: 12_000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => {
        reads.count += 1
        return new Uint8Array([9])
      }),
      readGop,
      fragmentCache: cache,
      demux: vi.fn(async () => GOP_AUS),
      sink: {
        pushAccessUnit: (d: Uint8Array, _ts: number, _c: 'H264' | 'H265') =>
          pushed.push({ sync: (d[4] ?? 0) === 0x26 }),
      },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, pushed, logs, readGop, reads, GOP_AUS }
  }

  it('a fling over WARM footage paints intermediate keyframes on its way — zero extra I/O', async () => {
    const cache = new ScrubFragmentCache()
    const h = jumpTravelDeps(cache)
    // Warm the interval the fling will cross.
    for (const startMs of [1_008_000, 1_012_000, 1_016_000]) {
      cache.put('low', { startMs, durMs: 4_000, aus: h.GOP_AUS })
    }
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_005_000) // landing — one fetch
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(1_021_000) // +16 s fling → JUMP, crossing the warm GOPs
    await flush()
    // Travel stills are IDRs, pushed BEFORE the target keyframe.
    expect(h.pushed.slice(1).every((p) => p.sync)).toBe(true)
    // Cache-only: the fling paid exactly TWO fetches (its landing + target).
    expect(h.reads.count).toBe(2)
    feeder.dispose()
    // The per-tick line is sampled, so the drag AGGREGATE is where travel is
    // asserted — it is also the surface an operator reads in Loki.
    const end = h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')
    expect(end?.data).toMatchObject({ jumps: 2 })
    expect(end!.data.travel as number).toBeGreaterThan(0) // stills went along
  })

  it('a fling over COLD footage stays a single keyframe — travel must never fight the hub', async () => {
    const cache = new ScrubFragmentCache()
    const h = jumpTravelDeps(cache)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_005_000)
    await flush()
    feeder.scrubAck()
    const before = h.pushed.length
    feeder.scrubTo(1_045_000) // +40 s fling, nothing warm in between
    await flush()
    expect(h.pushed.length).toBe(before + 1) // exactly the target keyframe
    expect(h.reads.count).toBe(2) // no intermediate fetches
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub — receiver-credit pacing', () => {
  // Backpressure is the RECEIVER'S: a scrub push spends one credit, a rendered
  // frame acknowledged by the viewer (`scrubAck`) restores one, and with zero
  // credit the newest target PARKS instead of being pushed onto a link that has
  // not drained. A timer never releases work — only the receiver does.
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function creditDeps() {
    const pushed: number[] = []
    const positions: number[] = []
    const deps = {
      deviceId: 99,
      profile: 'low',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 1000) * 1000,
            durMs: 1000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      demuxAudio: vi.fn(async () => [{ data: new Uint8Array([9]), ptsMs: 0 }]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _codec: 'H264' | 'H265') => pushed.push(ts),
        pushAudioPcmu: (_d: Uint8Array, _ts: number) => {},
      },
      onState: () => {},
      onPosition: (e: number) => {
        positions.push(e)
      },
    }
    return { deps, pushed, positions }
  }

  it('pushes at most the credit cap without an ack — the newest target PARKS, it is not dropped', async () => {
    const { deps, pushed } = creditDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6_500)
    await flush()
    feeder.scrubTo(16_500) // far jumps — the sweep window has its own tests
    await flush()
    feeder.scrubTo(26_500) // third push would exceed the outstanding cap of 2
    await flush()
    expect(pushed.length).toBe(2)
    feeder.dispose()
  })

  it('a receiver ack releases the parked target — no timer involved', async () => {
    const { deps, pushed, positions } = creditDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(6_500)
    await flush()
    feeder.scrubTo(16_500)
    await flush()
    feeder.scrubTo(26_500)
    await flush()
    expect(pushed.length).toBe(2) // parked
    feeder.scrubAck()
    await flush()
    expect(pushed.length).toBe(3)
    expect(positions.at(-1)).toBe(26_500)
    feeder.dispose()
  })

  it('acks never bank credit above the cap', async () => {
    const { deps, pushed } = creditDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    for (let i = 0; i < 5; i++) feeder.scrubAck() // over-acking must not open the floodgate
    feeder.scrubTo(6_500)
    await flush()
    feeder.scrubTo(16_500)
    await flush()
    feeder.scrubTo(26_500)
    await flush()
    expect(pushed.length).toBe(2)
    feeder.dispose()
  })

  it('a fresh drag restores full credit', async () => {
    const { deps, pushed } = creditDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.setRate(0)
    feeder.beginScrub()
    feeder.scrubTo(6_500)
    await flush()
    feeder.scrubTo(16_500)
    await flush()
    feeder.scrubTo(26_500)
    await flush()
    expect(pushed.length).toBe(2) // exhausted
    await feeder.seek(9_000) // commit — exits scrub mode
    const afterCommit = pushed.length
    feeder.beginScrub() // NEW drag
    feeder.scrubTo(6_500)
    await flush()
    expect(pushed.length).toBe(afterCommit + 1)
    feeder.dispose()
  })
})

describe('RecordedFeeder.seek — snap to the nearest footage instead of reporting a false gap', () => {
  // Production 2026-08-02: every commit into a crack or past the archive edge
  // reported `gap`, which the viewer renders as "No footage" — for footage
  // that existed seconds away. The locate result CARRIES the nearest edge;
  // the seek threw it away. The playback machine on the viewer was built for
  // a snapping feeder all along (its straggler logic adopts the server's
  // landing position as the truth).
  function snapDeps(locate: ReturnType<typeof vi.fn>) {
    const pushed: number[] = []
    const states: string[] = []
    const positions: number[] = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate,
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: (e: number) => {
        positions.push(e)
      },
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, pushed, states, positions, logs }
  }

  it('a gap with footage AHEAD snaps forward and plays — never a gap state', async () => {
    const locate = vi.fn(async ({ epochMs }: { epochMs: number }) =>
      epochMs < 20_000
        ? ({ kind: 'gap', nearestEdgeMs: 20_000, prevEndMs: null } as const)
        : ({
            kind: 'segment',
            startMs: 20_000,
            durMs: 8000,
            bytes: 3,
          } as const),
    )
    const h = snapDeps(locate)
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(5_000) // 15 s before the archive edge
    expect(h.states).not.toContain('gap')
    expect(h.pushed.length).toBeGreaterThan(0)
    const snapped = h.logs.find((l) => l.msg === 'recorded:seek-snapped')
    expect(snapped?.data).toMatchObject({
      requestedMs: 5_000,
      snappedMs: 20_000,
    })
    feeder.dispose()
  })

  it('a gap with footage only BEHIND snaps backward via prevEndMs', async () => {
    const locate = vi.fn(async ({ epochMs }: { epochMs: number }) =>
      epochMs >= 28_000
        ? ({ kind: 'gap', nearestEdgeMs: null, prevEndMs: 28_000 } as const)
        : ({
            kind: 'segment',
            startMs: 20_000,
            durMs: 8000,
            bytes: 3,
          } as const),
    )
    const h = snapDeps(locate)
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(50_000) // past the end of the archive
    expect(h.states).not.toContain('gap')
    expect(h.pushed.length).toBeGreaterThan(0)
    feeder.dispose()
  })

  it('NO footage in either direction is the only true gap — and it logs', async () => {
    const locate = vi.fn(
      async () => ({ kind: 'gap', nearestEdgeMs: null, prevEndMs: null }) as const,
    )
    const h = snapDeps(locate)
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(5_000)
    expect(h.states).toContain('gap')
    expect(h.pushed.length).toBe(0)
    expect(h.logs.some((l) => l.msg === 'recorded:seek-no-footage')).toBe(true)
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub — gap snapping and the silent branches', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function gapScrubDeps(locate: ReturnType<typeof vi.fn>) {
    const pushed: number[] = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const deps = {
      deviceId: 99,
      profile: 'low',
      locate,
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: () => {},
      onPosition: () => {},
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, pushed, logs }
  }

  it('a drag target in a dead stretch paints the NEAREST footage (pull-ladder parity), logged', async () => {
    const locate = vi.fn(async ({ epochMs }: { epochMs: number }) =>
      epochMs < 20_000
        ? ({ kind: 'gap', nearestEdgeMs: 20_000, prevEndMs: null } as const)
        : ({
            kind: 'segment',
            startMs: 20_000,
            durMs: 8000,
            bytes: 3,
          } as const),
    )
    const h = gapScrubDeps(locate)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(5_000)
    await flush()
    expect(h.pushed.length).toBe(1)
    expect(h.logs.some((l) => l.msg === 'scrub-feeder:snapped')).toBe(true)
    feeder.dispose()
  })

  it('a drag target with NO footage anywhere logs — a quiet feeder must never be silent', async () => {
    const locate = vi.fn(
      async () => ({ kind: 'gap', nearestEdgeMs: null, prevEndMs: null }) as const,
    )
    const h = gapScrubDeps(locate)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(5_000)
    await flush()
    expect(h.pushed.length).toBe(0)
    expect(h.logs.some((l) => l.msg === 'scrub-feeder:no-footage')).toBe(true)
    feeder.dispose()
  })
})

describe('RecordedFeeder feeder-scrub — SWEEP mode (predicted frames on steady forward drags)', () => {
  // A drag moving steadily forward is playback with a moving target: once a
  // keyframe is decoded, the predicted frames after it in the same GOP decode
  // in sequence and cost a fraction of an IDR. Only a JUMP (backward, over the
  // window, or non-adjacent) needs an independently-decodable keyframe.
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  function sweepDeps() {
    const pushed: Array<{ ts: number; sync: boolean }> = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    // Every position a scrub push emits carries the push `seq` the viewer
    // echoes on `scrubAck` — the tests ack the way the client does.
    const positions: Array<{ epochMs: number; seq: number | undefined }> = []
    // 8 s fragments; full-GOP AUs every 500 ms, IDR first.
    const AUS = Array.from({ length: 16 }, (_, i) => AU(i * 500, i === 0))
    const deps = {
      deviceId: 99,
      profile: 'low',
      locate: vi.fn(
        async ({ epochMs }: { epochMs: number }) =>
          ({
            kind: 'segment',
            startMs: Math.floor(epochMs / 8000) * 8000,
            durMs: 8000,
            bytes: 3,
          }) as const,
      ),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => AUS),
      sink: {
        pushAccessUnit: (d: Uint8Array, ts: number, _c: 'H264' | 'H265') =>
          pushed.push({ ts, sync: (d[4] ?? 0) === 0x26 }),
      },
      onState: () => {},
      onPosition: (epochMs: number, seq?: number) => positions.push({ epochMs, seq }),
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, pushed, logs, positions }
  }

  it('a small forward move pushes the predicted frames up to the target — frame-granular, one credit', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(8_100) // first landing → JUMP: the fragment IDR
    await flush()
    expect(h.pushed.length).toBe(1)
    expect(h.pushed[0]!.sync).toBe(true)
    feeder.scrubAck()
    feeder.scrubTo(9_600) // forward inside the same GOP → SWEEP: pts 500..1500
    await flush()
    expect(h.pushed.length).toBe(4) // + AUs at rel 500, 1000, 1500
    expect(h.pushed.slice(1).every((p) => !p.sync)).toBe(true)
    feeder.dispose()
    // One landing JUMP (1 AU) + one forward SWEEP (3 AUs), on the aggregate.
    expect(h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')?.data).toMatchObject({
      jumps: 1,
      sweeps: 1,
      backSweeps: 0,
      aus: 4,
    })
  })

  it('a BACKWARD move within the window is a SWEEP — IDR + P-prefix to the exact frame', async () => {
    // With the camera GOP fixed at 4 s, P-frame stepping is the ONLY mechanism
    // that can land a backward drag between keyframes. The step pays a GOP walk
    // (covering IDR + every P up to the target) — that asymmetry vs the cheap
    // forward step is permanent and by design.
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(9_600) // first landing → JUMP: the fragment IDR (idx 0)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(8_700) // backward 900 ms → SWEEP back: IDR + P at rel 500
    await flush()
    expect(h.pushed.length).toBe(3) // jump IDR, then the 2-AU backward run
    expect(h.pushed[1]!.sync).toBe(true) // the run leads with the covering IDR
    expect(h.pushed[2]!.sync).toBe(false) // …and STOPS at the exact frame
    feeder.dispose()
    // Counted as a BACK sweep, apart from forward sweeps: its per-step cost is
    // a whole GOP walk, and the aggregate is where that asymmetry is read.
    expect(h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')?.data).toMatchObject({
      jumps: 1,
      sweeps: 0,
      backSweeps: 1,
      aus: 3,
    })
  })

  it('a backward step stamps a seek-sized discontinuity (it is a PTS rewind)', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(11_600) // jump → IDR (idx 0), cursor at idx 0
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(10_600) // −1000 ms → backward run to rel 2500 (idx 5)
    await flush()
    // The full run is on the wire: IDR + 5 P-frames (a jump would push one).
    expect(h.pushed.length).toBe(7)
    // The backward run re-feeds pts 0..2500 — already-emitted source times. The
    // output clock must not clamp them into one instant: a discontinuity stamp
    // re-anchors, so every AU of the run advances strictly.
    const runTs = h.pushed.slice(1).map((p) => p.ts)
    for (let i = 1; i < runTs.length; i++) expect(runTs[i]!).toBeGreaterThan(runTs[i - 1]!)
    expect(runTs[0]! - h.pushed[0]!.ts).toBeGreaterThanOrEqual(250 * 90)
    feeder.dispose()
  })

  it('a sustained slow backward drag SWEEPS every step, each run charged one credit', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(12_100) // jump lands the fragment IDR
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(11_100) // −1000 ms → back sweep to rel 3000 (idx 6)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(10_100) // −1000 ms → back sweep to rel 2000 (idx 4)
    await flush()
    // Every backward run re-pays the covering IDR: it must LEAD each run.
    expect(h.pushed[1]!.sync).toBe(true)
    expect(h.pushed.at(-1 - 4)!.sync).toBe(true) // second run: IDR + 4 P-frames
    feeder.dispose()
    // The landing jump, then TWO backward sweeps — one credit each.
    expect(h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')?.data).toMatchObject({
      jumps: 1,
      sweeps: 0,
      backSweeps: 2,
    })
  })

  it('a backward delta beyond the window degrades to a JUMP — keyframe granularity, documented not silent', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(15_600)
    await flush()
    feeder.scrubAck()
    const before = h.pushed.length
    feeder.scrubTo(8_900) // −6.7 s in one move — beyond the sweep window
    await flush()
    expect(h.pushed.length).toBe(before + 1) // one keyframe, no GOP walk
    expect(h.pushed.at(-1)!.sync).toBe(true)
    feeder.dispose()
    // The degradation is documented on the aggregate, not silent: a BACKWARD
    // jump is counted apart from a forward one.
    expect(h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')?.data).toMatchObject({
      jumps: 2,
      jumpsBack: 1,
      backSweeps: 0,
    })
  })

  it('a backward micro-move inside one frame pushes nothing (position only)', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(9_600)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(8_100) // back to the IDR the cursor already sits on (idx 0)
    await flush()
    expect(h.pushed.length).toBe(1) // nothing new on the wire
    feeder.dispose()
  })

  it('a delta beyond the sweep window is a jump, not a giant burst', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(8_100)
    await flush()
    feeder.scrubAck()
    const before = h.pushed.length
    feeder.scrubTo(14_000) // +5.9 s of timeline in one move — over the window
    await flush()
    expect(h.pushed.length).toBe(before + 1) // one keyframe, no burst
    expect(h.pushed.at(-1)!.sync).toBe(true)
    feeder.dispose()
  })

  it('crossing into the ADJACENT forward fragment continues the flow from its IDR — contiguous timestamps', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(15_600) // frag 8000, rel 7600 → IDR jump lands near the tail
    await flush()
    feeder.scrubAck()
    const beforeTs = h.pushed.at(-1)!.ts
    feeder.scrubTo(16_900) // adjacent frag 16000, rel 900 → sweep across: IDR + pts 500
    await flush()
    // TWO AUs crossed (the new fragment's IDR, then its first predicted frame)
    // — a jump would have pushed one.
    expect(h.pushed.length).toBe(3)
    expect(h.pushed[1]!.sync).toBe(true) // the new fragment's IDR leads
    expect(h.pushed[2]!.sync).toBe(false)
    // Contiguous flow: no seek-sized discontinuity was stamped across the edge.
    expect(h.pushed[1]!.ts - beforeTs).toBeLessThan(250 * 90)
    // …but the clock must still ADVANCE. `ptsMs` is FRAGMENT-relative — every
    // recorded fragment carries its own `moov` and restarts at 0 (measured on
    // four consecutive real low-tier fragments: 0 → 11943 ms, every one of
    // them). Crossing the edge therefore hands the clock a ~fragment-length
    // REWIND, and MonotonicClock.stamp clamps a rewind to `lastOutMs` — so
    // without a boundary mark every AU of the new fragment is stamped at the
    // SAME instant and the receiver sees time stop. Asserting only "no big
    // jump" is satisfied by exactly that stall, which is how this passed while
    // the flow was frozen.
    expect(h.pushed[1]!.ts).toBeGreaterThan(beforeTs)
    expect(h.pushed[2]!.ts).toBeGreaterThan(h.pushed[1]!.ts)
    feeder.dispose()
  })

  it('a sweep costs ONE credit and one ack repays it — the gate closes at two pushes, not two frames', async () => {
    // The credit gate is the ONLY backpressure on the scrub train, and its unit
    // is the PUSH. A sweep puts N access units on the wire under ONE position
    // message, so a viewer without `requestVideoFrameCallback` can send exactly
    // ONE ack for it; the earlier per-FRAME settle waited for N and the drag
    // parked for the rest of the gesture the moment the operator slowed down
    // (`mode=sweep aus=26 creditLeft=1`, then nothing, ever). Backpressure is
    // preserved by the CAP: two pushes in flight and the next target parks.
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(8_100) // JUMP: 1 AU
    await flush()
    expect(h.pushed.length).toBe(1)
    feeder.scrubAck(h.positions[h.positions.length - 1]?.seq) // the jump is paid for
    feeder.scrubTo(9_600) // SWEEP: 3 AUs (rel 500, 1000, 1500)
    await flush()
    expect(h.pushed.length).toBe(4)
    const sweepSeq = h.positions[h.positions.length - 1]?.seq
    feeder.scrubTo(11_100) // SWEEP: 3 more (rel 2000, 2500, 3000) — credit spent
    await flush()
    expect(h.pushed.length).toBe(7)
    // Two pushes are outstanding, so the next target parks — the gate still
    // closes, it just counts pushes.
    feeder.scrubTo(12_600)
    await flush()
    expect(h.pushed.length).toBe(7)
    expect(h.logs.some((l) => l.msg === 'scrub-feeder:parked')).toBe(true)
    // An ack naming a push that is ALREADY settled repays nothing — this is the
    // surplus an rvfc viewer sends, one per rendered frame of the same sweep.
    feeder.scrubAck(sweepSeq)
    await flush()
    const afterFirstAck = h.pushed.length
    feeder.scrubAck(sweepSeq)
    feeder.scrubAck(sweepSeq)
    await flush()
    // The single credit the first ack returned served the parked target, and
    // the surplus acks added nothing on top of it.
    expect(afterFirstAck).toBeGreaterThan(7)
    expect(h.pushed.length).toBe(afterFirstAck)
    feeder.dispose()
  })

  it('the drag summary logs jumps, sweeps and AUs when the drag commits', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    feeder.beginScrub()
    feeder.scrubTo(8_100)
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(9_600)
    await flush()
    await feeder.seek(9_600) // the commit
    const summary = h.logs.find((l) => l.msg === 'scrub-feeder:drag-end')
    expect(summary?.data).toMatchObject({ jumps: 1, sweeps: 1, aus: 4 })
    feeder.dispose()
  })
})

/**
 * PLAYBACK through the snap branch — the coverage gap that let a commit which
 * killed playback in production ship green.
 *
 * The only pre-existing `seek()`-into-a-gap test ("emits gap and pushes
 * nothing") uses a locate that answers `gap` for EVERY epoch, so the snapped
 * re-locate also answers `gap` and the feeder short-circuits on
 * `seek-no-footage`. The branch where a snap SUCCEEDS — and the segment load it
 * newly performs — was therefore never executed by any test, on the surface the
 * operator actually uses.
 *
 * Production 2026-08-02 (verified in the hub's own logs): the recorder addon had
 * restarted 9 minutes earlier, so its in-memory index had only walked the
 * footage written since. `locateSegment` answered `gap` for essentially the
 * whole timeline, carrying a `nearestEdgeMs` 6 minutes to 23 HOURS away from the
 * requested moment. Every seek snapped to that distant edge, loaded a segment
 * from the addon that was busy re-walking the archive, blew the 8 s budget, and
 * surfaced as the TERMINAL `error` state — `loading → seek-snapped → error`, on
 * every seek, on both cameras. The pre-snap behaviour (`gap`) was cheap and
 * recoverable; the snap made an unhydrated index fatal.
 */
describe('RecordedFeeder.seek — snapping is a nearby correction, never a search', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 5))

  /** Footage covering [20000, 24000) only; everything else is a gap whose
   *  forward edge is that segment's start. `edgeMs` moves the footage so a test
   *  can put it near the requested epoch or hours away from it. */
  function snapDeps(edgeMs: number) {
    const states: string[] = []
    const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
    const pushed: number[] = []
    const deps = {
      deviceId: 99,
      profile: 'mid',
      locate: vi.fn(async ({ epochMs }: { epochMs: number }) =>
        epochMs >= edgeMs && epochMs < edgeMs + 4000
          ? ({
              kind: 'segment',
              startMs: edgeMs,
              durMs: 4000,
              bytes: 3,
            } as const)
          : ({ kind: 'gap', nearestEdgeMs: edgeMs, prevEndMs: null } as const),
      ),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      demux: vi.fn(async () => [AU(0, true), AU(40), AU(80)]),
      sink: {
        pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
      },
      onState: (s: FeederStateTransition) => {
        states.push(s.to)
      },
      onPosition: () => {},
      onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    }
    return { deps, states, logs, pushed }
  }

  it('snaps onto footage a moment away and PLAYS (the case the snap exists for)', async () => {
    // Requested 19_000; footage starts 1 s later at 20_000 — a dead band edge.
    const h = snapDeps(20_000)
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(19_000)
    expect(h.logs.some((l) => l.msg === 'recorded:seek-snapped')).toBe(true)
    expect(h.states).toContain('playing')
    expect(h.states).not.toContain('error')
    expect(h.pushed.length).toBeGreaterThan(0)
    feeder.dispose()
  })

  it('does NOT snap to distant footage — and reads not one byte to find that out', async () => {
    // Requested 19_000; the nearest edge the index admits to is 6 hours later.
    // That is not a crack next to the playhead, it is an index that has not
    // walked the archive yet. Answering it costs a segment load against the very
    // addon that is busy walking — the production failure.
    const h = snapDeps(19_000 + 6 * 3_600_000)
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(19_000)
    expect(h.states).toContain('gap')
    expect(h.states).not.toContain('error')
    expect(h.deps.readBytes).not.toHaveBeenCalled()
    expect(h.deps.demux).not.toHaveBeenCalled()
    expect(h.logs.some((l) => l.msg === 'recorded:snap-too-far')).toBe(true)
    feeder.dispose()
  })

  it('a snapped seek whose load fails degrades to gap — never the terminal error state', async () => {
    // `gap` is recoverable: the client renders "no footage" and the operator can
    // seek again. `error` is terminal and nothing retries it — which is why one
    // slow read left playback dead for the rest of the session.
    const h = snapDeps(20_000)
    h.deps.readBytes.mockRejectedValue(new Error('segment read timeout'))
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(19_000)
    await flush()
    expect(h.states).toContain('gap')
    expect(h.states).not.toContain('error')
    expect(h.logs.some((l) => l.msg === 'recorded:seek-snap-load-failed')).toBe(true)
    feeder.dispose()
  })

  it('an UNSNAPPED seek whose load fails still reports error (the real failure keeps its state)', async () => {
    const h = snapDeps(20_000)
    h.deps.readBytes.mockRejectedValue(new Error('segment read timeout'))
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(21_000) // lands directly on footage — no snap involved
    await flush()
    expect(h.states).toContain('error')
    feeder.dispose()
  })

  it('a drag whose nearest footage is distant holds, loading nothing (same bound as seek)', async () => {
    const h = snapDeps(19_000 + 6 * 3_600_000)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(19_000)
    await flush()
    expect(h.pushed.length).toBe(0)
    expect(h.deps.readBytes).not.toHaveBeenCalled()
    expect(h.logs.some((l) => l.msg === 'scrub-feeder:snap-too-far')).toBe(true)
    feeder.dispose()
  })
})
