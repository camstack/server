import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'
import { ScrubFragmentCache } from '../scrub-fragment-cache'
import { DemuxPathTally } from '../demux-path-tally'

/**
 * The scrub instrumentation, phase by phase (D68 tuning). The load-bearing
 * assertion of this file is a COUNT, not a content match: a drag produces
 * exactly ONE aggregate line and NOT one line per pushed frame. A flood is the
 * failure mode — on a hub measured at 70–95% main thread, an instrument that
 * logs per tick is worse than no instrument.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})

const flush = () => new Promise<void>((r) => setTimeout(r, 5))

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

function instrumentedDeps(overrides: { locateDelayMs?: number } = {}) {
  const logs: LogLine[] = []
  const pushed: number[] = []
  const locate = vi.fn(async ({ epochMs }: { epochMs: number }) => {
    if (overrides.locateDelayMs) {
      await new Promise<void>((r) => setTimeout(r, overrides.locateDelayMs))
    }
    return {
      kind: 'segment',
      startMs: Math.floor(epochMs / 1000) * 1000,
      durMs: 1000,
      bytes: 3,
    } as const
  })
  const readGop = vi.fn(async ({ epochMs }: { epochMs: number }) => ({
    gopStartMs: Math.floor(epochMs / 1000) * 1000,
    gopDurMs: 1000,
    bytes: new Uint8Array(41_000),
  }))
  const demux = vi.fn(async () => [AU(0, true), AU(40), AU(80)])
  const deps = {
    deviceId: 102,
    profile: 'low',
    locate,
    // The scrub unit for `low` is the whole segment (D163), so this is the
    // door the drag reads through; 41 000 B keeps the per-phase byte
    // assertions below comparable with what they measured before.
    readBytes: vi.fn(async () => new Uint8Array(41_000)),
    readGop,
    demux,
    sink: {
      pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushed.push(ts),
    },
    onState: () => {},
    onPosition: () => {},
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
  }
  return { deps, logs, pushed, locate, readGop, demux }
}

const linesOf = (logs: readonly LogLine[], msg: string) => logs.filter((l) => l.msg === msg)

/** Drive `n` jump ticks (targets far apart), acking each so credit never parks.
 *  `settleMs` must exceed whatever the fake I/O costs, or a tick is still in
 *  flight when the drag ends and its phase sample never lands. */
async function driveJumpDrag(
  feeder: RecordedFeeder,
  n: number,
  base = 100_000,
  settleMs = 5,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    feeder.scrubTo(base + i * 10_000, { mode: 'coarse', velocityPxPerS: 600 })
    await new Promise<void>((r) => setTimeout(r, settleMs))
    feeder.scrubAck()
  }
}

describe('scrub instrumentation — one aggregate per drag, never one per frame', () => {
  it('a 10-tick drag emits EXACTLY ONE drag-end line, and FEWER push lines than pushes', async () => {
    const { deps, logs, pushed } = instrumentedDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    await driveJumpDrag(feeder, 10)
    await feeder.seek(200_000)

    expect(linesOf(logs, 'scrub-feeder:drag-end').length).toBe(1)
    expect(pushed.length).toBeGreaterThanOrEqual(10)
    // The per-tick line is SAMPLED: a whole fast drag must not produce a line
    // per PUSH (10 ticks), let alone per FRAME (pushed.length AUs).
    const pushLines = linesOf(logs, 'scrub-feeder:pushed').length
    expect(pushLines).toBeLessThan(10)
    expect(pushLines).toBeLessThan(pushed.length)
    // …and the whole drag stays inside a handful of lines, whatever it did.
    expect(logs.length).toBeLessThanOrEqual(5)
    feeder.dispose()
    // The commit already ended the drag — disposing must not double-count it.
    expect(linesOf(logs, 'scrub-feeder:drag-end').length).toBe(1)
  })

  it('the aggregate carries every phase: mapping, locate, fetch, demux, push, ack', async () => {
    const { deps, logs } = instrumentedDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    await driveJumpDrag(feeder, 4)
    await feeder.seek(200_000)

    const end = linesOf(logs, 'scrub-feeder:drag-end')[0]
    expect(end).toBeDefined()
    const f = end!.data
    expect(f.ticks).toBe(4)
    expect(f.jumps).toBe(4)
    expect(f.mapCoarse).toBe(4)
    expect(f.velPxPerSMax).toBe(600)
    // Four jumps, four cold fragments, four locates: a drag that speculates
    // nothing pays for exactly what it asked for and no more.
    //
    // This used to read 3 misses / 1 cache hit / 1 prefetch hit, and the comment
    // called that asymmetry "the whole point of the prefetch". It was the point;
    // the predictor just could not hit it on a real gesture (3 hits in 25 reads
    // in the field) and the reads it lost were queued ahead of the one the
    // finger was waiting on. The census keeps the speculation counters at zero
    // so a future attempt is measured from its first drag.
    expect(f.coverMiss).toBe(4)
    expect(f.coverCache).toBe(0)
    expect(f.prefetchHits).toBe(0)
    expect(f.prefetchReads).toBe(0)
    expect(f.prefetchBytes).toBe(0)
    expect(f.locateCalls).toBe(4)
    expect(f.wholeReads).toBe(4)
    expect(f.gopReads).toBe(0)
    expect(f.readBytes).toBe(4 * 41_000)
    expect(f.demuxCalls).toBe(4)
    expect(f.acks).toBe(4)
    expect(f.ackMsMax).toBeTypeOf('number')
    expect(f.firstPushMs).toBeTypeOf('number')
    expect(f.dragMs).toBeTypeOf('number')
    feeder.dispose()
  })

  it('MAPPING: the client hint is what makes fine-vs-coarse readable at all', async () => {
    const { deps, logs } = instrumentedDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    feeder.scrubTo(100_000, { mode: 'fine', velocityPxPerS: 40 })
    await flush()
    feeder.scrubAck()
    feeder.scrubTo(101_500, { mode: 'fine', velocityPxPerS: 55 })
    await flush()
    feeder.scrubAck()
    // A client that predates the hint leaves the mapping UNKNOWN — never
    // silently attributed to a mode it did not report.
    feeder.scrubTo(160_000)
    await flush()
    await feeder.seek(160_000)

    const f = linesOf(logs, 'scrub-feeder:drag-end')[0]!.data
    expect(f.mapFine).toBe(2)
    expect(f.mapUnknown).toBe(1)
    expect(f.velPxPerSP50).toBe(40)
    feeder.dispose()
  })

  it('LOCATE: a warm coverage hit is counted as a hit and pays NO locate RPC', async () => {
    const { deps, logs } = instrumentedDeps()
    const cache = new ScrubFragmentCache()
    cache.put('low', {
      startMs: 100_000,
      durMs: 1000,
      aus: [AU(0, true), AU(40), AU(80)],
    })
    const feeder = new RecordedFeeder({ ...deps, fragmentCache: cache })
    feeder.beginScrub()
    feeder.scrubTo(100_200, { mode: 'fine', velocityPxPerS: 30 })
    await flush()
    await feeder.seek(100_200)

    // The claim is about the DRAG PATH, not the background prefetch: the tick
    // itself made no `locate` call at all — the 1–8 s RPC left the warm path.
    const f = linesOf(logs, 'scrub-feeder:drag-end')[0]!.data
    expect(f.coverCache).toBe(1)
    expect(f.locateCalls).toBe(0)
    expect(f.locateMsP50).toBeNull()
    feeder.dispose()
  })

  it('LOCATE: a slow locate gets its own line, THROTTLED — not one per tick', async () => {
    const { deps, logs } = instrumentedDeps({ locateDelayMs: 60 })
    const feeder = new RecordedFeeder({ ...deps, slowLocateMs: 20 })
    feeder.beginScrub()
    await driveJumpDrag(feeder, 3, 100_000, 100)
    await feeder.seek(200_000)

    const slow = linesOf(logs, 'scrub-feeder:slow-locate')
    expect(slow.length).toBe(1)
    expect(slow[0]!.data.locateMs).toBeTypeOf('number')
    const f = linesOf(logs, 'scrub-feeder:drag-end')[0]!.data
    expect(f.locateMsMax).toBeGreaterThanOrEqual(20)
    feeder.dispose()
  })

  it('DEMUX: the aggregate reports in-process vs ffmpeg-fallback counts and the reason', async () => {
    const { deps, logs } = instrumentedDeps()
    const tally = new DemuxPathTally()
    let call = 0
    const demux = vi.fn(async () => {
      call += 1
      tally.record(
        call === 2 ? { path: 'ffmpeg', reason: 'mp4box parse threw: x' } : { path: 'js' },
        call,
      )
      return [AU(0, true), AU(40), AU(80)]
    })
    const feeder = new RecordedFeeder({ ...deps, demux, demuxTally: tally })
    feeder.beginScrub()
    await driveJumpDrag(feeder, 3)
    await feeder.seek(200_000)

    const f = linesOf(logs, 'scrub-feeder:drag-end')[0]!.data
    // BOTH paths are counted over the drag window — the drag's own ticks AND
    // the background prefetches whose fragments it goes on to use. (The window
    // closes at the commit, so a prefetch still in flight is not counted; the
    // FALLBACK count, which is the number being asked about, is exact.)
    expect(f.demuxFfmpeg).toBe(1)
    expect(f.demuxJs).toBeGreaterThanOrEqual(2)
    expect(Number(f.demuxJs) + Number(f.demuxFfmpeg)).toBeLessThanOrEqual(demux.mock.calls.length)
    expect(f.demuxFallback).toBe('mp4box parse threw: x')
    feeder.dispose()
  })

  it('PUSH: a park on zero credit logs ONCE per drag but is counted every time', async () => {
    const { deps, logs } = instrumentedDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    // Spend both credits without acking, then keep dragging: every further
    // tick parks.
    feeder.scrubTo(100_000)
    await flush()
    feeder.scrubTo(120_000)
    await flush()
    for (let i = 0; i < 5; i++) {
      feeder.scrubTo(140_000 + i * 10_000)
      await flush()
    }
    await feeder.seek(200_000)

    expect(linesOf(logs, 'scrub-feeder:parked').length).toBe(1)
    const f = linesOf(logs, 'scrub-feeder:drag-end')[0]!.data
    expect(f.parks).toBeGreaterThanOrEqual(5)
    expect(f.creditEndedAt).toBe(0)
    feeder.dispose()
  })

  it('a drag abandoned by dispose (goLive mid-drag) still emits its one aggregate', async () => {
    const { deps, logs } = instrumentedDeps()
    const feeder = new RecordedFeeder(deps)
    feeder.beginScrub()
    await driveJumpDrag(feeder, 2)
    feeder.dispose()
    expect(linesOf(logs, 'scrub-feeder:drag-end').length).toBe(1)
    expect(linesOf(logs, 'scrub-feeder:drag-end')[0]!.data.ticks).toBe(2)
  })
})
