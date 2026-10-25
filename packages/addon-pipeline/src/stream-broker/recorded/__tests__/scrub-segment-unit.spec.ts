import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'
import { ScrubFragmentCache } from '../scrub-fragment-cache'

/**
 * THE UNIT OF A SCRUB READ IS THE WHOLE `low` SEGMENT.
 *
 * Two phases of measurement got us here. The tick IS the read (D158:
 * `readMsP50 = 263` of a `tickMsP50 = 270`), and the read was a GOP byte range:
 * a 2 KB tail probe for the `mfra` index, the `ftyp`+`moov` head, then the
 * fragment — three random seeks on an array that is also absorbing every
 * camera's writes, for ~135 KB of the ~230 KB the whole 10 s segment weighs at
 * `low`. Paying three seeks to avoid reading 95 KB more is a bad trade on a
 * spindle, and it buys nothing reusable: the next tick in the same segment paid
 * the same three seeks again.
 *
 * The reference design never does this. It reads the low-resolution track
 * only, seeks by byte offset into a file whose framing is self-describing, and
 * keeps the located segment and its index in RAM. We cannot adopt its storage
 * format — ours is fMP4 and that is a
 * deliberate, load-bearing difference (our files are playable) — but the
 * property that makes it fast transfers whole: **one sequential read serves
 * every tick that lands in those ten seconds.**
 *
 * So the scrub reads the segment, demuxes it once, and holds the access units.
 * A drag inside one segment then costs zero I/O and zero demux, and a drag
 * crossing segments costs exactly one sequential read per 10 s of timeline.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array(key ? 800 : 120),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

/** The real `low` shape: 10 s segment files, ~4 s GOPs, 25 fps. */
const SEG_MS = 10_000
/** 250 AUs, an IDR every 4 s — the recorder writes the camera's own cadence. */
const SEG_AUS = Array.from({ length: 250 }, (_, i) => AU(i * 40, i % 100 === 0))
/** ~230 KB, the measured weight of a 10 s `low` segment at ~190 kbps. */
const SEG_BYTES = 230_000

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

interface ReadRecord {
  readonly kind: 'whole' | 'gop'
  readonly startMs: number
}

const segStart = (epochMs: number) => Math.floor(epochMs / SEG_MS) * SEG_MS

function segmentDeps(opts: { readDelayMs?: number; profile?: string; slowReadMs?: number } = {}) {
  const logs: LogLine[] = []
  const reads: ReadRecord[] = []
  const positions: Array<{ epochMs: number; seq: number | undefined }> = []
  let readsInFlight = 0
  let maxReadsInFlight = 0
  const deps = {
    deviceId: 104,
    profile: opts.profile ?? 'low',
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: segStart(epochMs),
          durMs: SEG_MS,
          bytes: SEG_BYTES,
        }) as const,
    ),
    readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
      reads.push({ kind: 'whole', startMs })
      readsInFlight += 1
      maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight)
      try {
        if (opts.readDelayMs) await new Promise<void>((r) => setTimeout(r, opts.readDelayMs))
        return new Uint8Array(SEG_BYTES)
      } finally {
        readsInFlight -= 1
      }
    }),
    readGop: vi.fn(async ({ epochMs }: { epochMs: number }) => {
      reads.push({ kind: 'gop', startMs: segStart(epochMs) })
      if (opts.readDelayMs) await new Promise<void>((r) => setTimeout(r, opts.readDelayMs))
      return {
        gopStartMs: Math.floor(epochMs / 4_000) * 4_000,
        gopDurMs: 4_000,
        bytes: new Uint8Array(134_800),
      }
    }),
    demux: vi.fn(async () => SEG_AUS),
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: (epochMs: number, seq?: number) => positions.push({ epochMs, seq }),
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    fragmentCache: new ScrubFragmentCache(),
    ...(opts.slowReadMs === undefined ? {} : { slowReadMs: opts.slowReadMs }),
  }
  return { deps, logs, reads, positions, maxReadsInFlight: () => maxReadsInFlight }
}

const flush = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms))

function dragEnd(logs: readonly LogLine[]): Record<string, unknown> {
  const line = logs.find((l) => l.msg === 'scrub-feeder:drag-end')
  if (!line) throw new Error('no scrub-feeder:drag-end line')
  return line.data
}

async function driveDrag(
  feeder: RecordedFeeder,
  positions: ReadonlyArray<{ epochMs: number; seq: number | undefined }>,
  opts: { from: number; stepMs: number; ticks: number; settleMs?: number },
): Promise<void> {
  let acked = 0
  let target = opts.from
  for (let i = 0; i < opts.ticks; i++) {
    feeder.scrubTo(target)
    await flush(opts.settleMs ?? 5)
    await flush(opts.settleMs ?? 5)
    while (acked < positions.length) {
      feeder.scrubAck(positions[acked]?.seq)
      acked += 1
    }
    await flush(opts.settleMs ?? 5)
    target += opts.stepMs
  }
}

describe('scrub reads a whole `low` segment and serves every tick inside it from RAM', () => {
  it('a careful drag inside one segment pays ONE read and then nothing at all', async () => {
    const h = segmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    // 1.2 s per tick, 7 ticks — 8.4 s, comfortably inside one 10 s segment.
    await driveDrag(feeder, h.positions, { from: 5_000_100, stepMs: 1_200, ticks: 7 })
    feeder.dispose()

    // ONE sequential read for the segment under the drag, and no GOP
    // byte-ranges at all. (The neighbour may also be read — that is the
    // direction-aware speculation of D158, one horizon for a drag with
    // locality — but the segment being dragged through is never read twice.)
    const whole = h.reads.filter((r) => r.kind === 'whole')
    expect(h.reads.filter((r) => r.kind === 'gop')).toHaveLength(0)
    expect(whole.filter((r) => r.startMs === segStart(5_000_100))).toHaveLength(1)
    expect(whole.length).toBeLessThanOrEqual(2)

    const end = dragEnd(h.logs)
    // Every later tick came out of RAM: no locate, no read, no demux.
    expect(Number(end.ticks)).toBeGreaterThanOrEqual(6)
    expect(Number(end.coverMemo) + Number(end.coverCache)).toBeGreaterThanOrEqual(5)
    expect(Number(end.wholeReads)).toBe(1)
    expect(Number(end.gopReads)).toBe(0)
    // …and the demux ran once PER SEGMENT READ, never once per tick: seven
    // ticks, one demux for the segment they are in (plus one for the neighbour
    // speculation warmed).
    expect(h.deps.demux.mock.calls.length).toBe(whole.length)
  })

  it('a long-step drag pays exactly one sequential read per 10 s of timeline crossed', async () => {
    const h = segmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    // The measured regime: −26 s per tick, 6 ticks — six distinct segments.
    await driveDrag(feeder, h.positions, { from: 6_000_000, stepMs: -26_000, ticks: 6 })
    feeder.dispose()

    // One read per segment touched — never two for the same ten seconds.
    const whole = h.reads.filter((r) => r.kind === 'whole')
    expect(whole.length).toBe(new Set(whole.map((r) => r.startMs)).size)
    expect(Number(dragEnd(h.logs).gopReads)).toBe(0)
  })

  it('a profile that is NOT `low` keeps the GOP byte-range — a 4 Mbps segment is not a scrub unit', async () => {
    const h = segmentDeps({ profile: 'high' })
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    await driveDrag(feeder, h.positions, { from: 7_000_000, stepMs: 1_200, ticks: 3 })
    feeder.dispose()

    expect(h.reads.filter((r) => r.kind === 'whole')).toHaveLength(0)
    expect(h.reads.filter((r) => r.kind === 'gop').length).toBeGreaterThan(0)
  })
})

describe('scrub warm-up — the window the operator is about to drag through', () => {
  it('entering scrub warms a window around the playhead, weighted toward the PAST', async () => {
    const h = segmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    // Land the playhead first: entering scrub from playback is the real path,
    // and the cursor is where the operator's finger goes down.
    await feeder.seek(8_000_000)
    const readsBefore = h.reads.length

    feeder.beginScrub()
    // The warm is asynchronous by contract: it must not gate the first tick.
    // Beyond the old 90 s window: at least a few minutes back of `low`.
    await vi.waitFor(
      () => {
        const warmed = h.reads.slice(readsBefore).map((r) => r.startMs)
        const furthestBack = Math.min(...warmed, 8_000_000)
        expect(8_000_000 - furthestBack).toBeGreaterThan(90_000)
      },
      { timeout: 2_000 },
    )

    const warmed = h.reads.slice(readsBefore).map((r) => r.startMs)
    const centre = segStart(8_000_000)
    const back = warmed.filter((s) => s < centre).length
    const fwd = warmed.filter((s) => s > centre).length
    // Asymmetric on purpose: a drag out of live goes backwards far more often
    // than forwards, so the budget is spent where it will be asked for.
    expect(back).toBeGreaterThan(fwd)
    expect(back).toBeGreaterThanOrEqual(6)
    // Bounded by the 48 MB session budget, not a 6-hour archive prefetch.
    expect(warmed.length).toBeLessThanOrEqual(250)
    feeder.dispose()
  })

  it('a MOVING finger owns the disk — the warm takes nothing until the drag rests', async () => {
    // The failure this pins, measured in production the day the directional
    // prefetch was deleted (2026-08-26): the warm quietly inherited its role.
    // Two drags on camera 104 spent 1.9 MB and 2.4 MB of warm reads against
    // 3.1 MB and 2.9 MB of tick reads — 38-45% of the gesture's I/O, ZERO cache
    // hits, tickMsP50 120-129 ms. The one drag that warmed nothing: 11 ms.
    //
    // `waitForTickReadIdle` was not enough, and could not be: it only avoids
    // overlapping a read already in flight, so the warm still slipped a 230 KB
    // random read into the gap between two ticks, and the NEXT tick queued
    // behind it on the arm.
    const h = segmentDeps({ readDelayMs: 5 })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(8_000_000)
    feeder.beginScrub()
    await flush(60) // the entry warm gets going

    // Now the finger MOVES, steadily, for well over the quiet threshold.
    const before = h.reads.length
    let target = 8_000_000
    for (let i = 0; i < 8; i++) {
      target += 26_000
      feeder.scrubTo(target)
      await flush(60)
    }
    const duringDrag = h.reads.length - before
    // Every read in that stretch belongs to a tick. Eight ticks, at most eight
    // reads — a ninth could only be the warm helping itself.
    expect(duringDrag).toBeLessThanOrEqual(8)

    // …and the warm is NOT disabled: it resumes the moment the finger rests.
    const beforeRest = h.reads.length
    await flush(700)
    expect(h.reads.length).toBeGreaterThan(beforeRest)
    feeder.dispose()
  })

  it('the warm never blocks the first tick — a cold cache still pushes', async () => {
    const h = segmentDeps({ readDelayMs: 30 })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(9_000_000)
    feeder.beginScrub()
    // The tick arrives while the warm is still reading.
    feeder.scrubTo(9_000_100)
    await flush(120)
    expect(h.positions.length).toBeGreaterThan(0)
  })
})

/*
 * REMOVED: 'scrub speculation suspends itself when the disk is the problem'.
 *
 * Two tests pinned a gate that suspended the directional prefetch once reads
 * went slow. Both are gone with the thing they gated (2026-08-26): the drag no
 * longer speculates at all, so there is no longer a slow-disk case in which to
 * stop speculating. The gate was the right answer to the wrong question — the
 * reads it throttled should never have been issued on a fast disk either.
 *
 * See `scrub-prefetch.spec.ts` for the rule that replaced it, and the field
 * numbers (25 speculative reads → 3 hits) that ended the argument.
 */

describe('travel stills come from KEYFRAMES, not from cache entries', () => {
  it('a fling across a warm segment paints every keyframe it crosses, at zero I/O', async () => {
    // When the scrub unit was one GOP, one cache entry held exactly one
    // keyframe and deduping travel by entry was the same as deduping by
    // keyframe. A whole `low` segment holds two or three, so the old dedupe
    // silently collapsed a ten-second fling into a single still — the frames
    // were already demuxed and in RAM, and were being thrown away.
    const h = segmentDeps()
    const cache = h.deps.fragmentCache
    // Warm the ground the fling crosses: one segment, three IDRs inside it.
    cache.put('low', { startMs: 12_010_000, durMs: SEG_MS, aus: SEG_AUS })
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(12_004_000) // landing, in the segment before
    await flush()
    feeder.scrubAck(h.positions.at(-1)?.seq)
    const readsBefore = h.reads.length
    const pushedBefore = h.positions.length
    feeder.scrubTo(12_019_000) // +15 s fling across the warm segment
    await flush()
    feeder.dispose()

    // Several stills went along, and none of them touched the disk.
    expect(Number(dragEnd(h.logs).travel)).toBeGreaterThan(1)
    expect(h.positions.length - pushedBefore).toBeGreaterThan(2)
    expect(h.reads.length - readsBefore).toBeLessThanOrEqual(1)
  })
})

describe('scrub sliding window — recenter around the cursor, never the archive', () => {
  const JUMP_MS = 3 * 3_600_000

  function warmStarts(logs: readonly LogLine[]): number[] {
    return logs
      .filter((l) => l.msg === 'scrub-feeder:warm-start')
      .map((l) => Number(l.data.centreMs))
  }

  it('a jump hours away aborts the live-edge fill and starts a second fill at the landing', async () => {
    const h = segmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(8_000_000)
    feeder.beginScrub()
    await vi.waitFor(() => expect(warmStarts(h.logs)).toContain(8_000_000), { timeout: 500 })

    const landMs = 8_000_000 + JUMP_MS
    feeder.scrubTo(landMs)
    await vi.waitFor(() => expect(warmStarts(h.logs).at(-1)).toBe(landMs), { timeout: 1_000 })

    const liveAfterRecenter = h.reads.filter(
      (r) => Math.abs(r.startMs - 8_000_000) < 120_000,
    ).length
    await flush(40)
    expect(h.reads.filter((r) => Math.abs(r.startMs - 8_000_000) < 120_000).length).toBe(
      liveAfterRecenter,
    )

    await vi.waitFor(
      () => {
        expect(h.reads.some((r) => Math.abs(r.startMs - landMs) < 60_000)).toBe(true)
      },
      { timeout: 1_000 },
    )
    feeder.dispose()
  })

  it('a slow 30 s drag does not re-centre the fill', async () => {
    const h = segmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    // The seek itself may arm an IDLE warm at the landing (same centre); the
    // drag's own entry warm re-arms there too. What this spec pins is that the
    // DRAG adds no further re-centre — every start stays on the entry playhead.
    await feeder.seek(8_000_000)
    feeder.beginScrub()
    await vi.waitFor(() => expect(warmStarts(h.logs).length).toBeGreaterThanOrEqual(1), {
      timeout: 500,
    })
    const startsBeforeDrag = warmStarts(h.logs).length

    await driveDrag(feeder, h.positions, { from: 8_000_000, stepMs: -10_000, ticks: 3 })
    expect(warmStarts(h.logs).length).toBe(startsBeforeDrag)
    expect([...new Set(warmStarts(h.logs))]).toEqual([8_000_000])
    feeder.dispose()
  })

  it('the finger tick and the background fill never issue two readBytes in parallel', async () => {
    const h = segmentDeps({ readDelayMs: 40 })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(9_000_000)
    feeder.beginScrub()
    feeder.scrubTo(9_000_100)
    await flush(250)
    expect(h.maxReadsInFlight()).toBeLessThanOrEqual(2)
    expect(h.positions.length).toBeGreaterThan(0)
    feeder.dispose()
  })

  it('a fling of far jumps does not stack a 15 min fill per tick', async () => {
    // Production 1.2.113: a coarse drag fired fillGen 1→16 in 2 s, each
    // `void warmScrubWindow` enqueued its own USB walk. Play then sat in
    // `loading` for 17 s (loadMs=16652) and several drags pushed ticks=0.
    const h = segmentDeps({ readDelayMs: 25 })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(8_000_000)
    feeder.beginScrub()
    await driveDrag(feeder, h.positions, {
      from: 8_000_000 + JUMP_MS,
      stepMs: JUMP_MS,
      ticks: 8,
      settleMs: 40,
    })
    // 8 stacked 15 min walkers would be hundreds of reads. One retargeted
    // walker plus the demand ticks stays in the dozens.
    expect(h.reads.length).toBeLessThan(80)
    feeder.dispose()
  })

  it('a play seek is not queued behind the sliding-window fill', async () => {
    const h = segmentDeps({ readDelayMs: 50 })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(8_000_000)
    feeder.beginScrub()
    await driveDrag(feeder, h.positions, {
      from: 8_000_000 + JUMP_MS,
      stepMs: JUMP_MS,
      ticks: 8,
      settleMs: 70,
    })
    const t0 = performance.now()
    await feeder.seek(8_020_000)
    expect(performance.now() - t0).toBeLessThan(250)
    feeder.dispose()
  })

  it('high playback seek never warms whole low segments', async () => {
    const h = segmentDeps({ profile: 'high' })
    const feeder = new RecordedFeeder(h.deps)
    await feeder.seek(8_000_000)
    await flush(80)
    expect(warmStarts(h.logs)).toHaveLength(0)
    // Playback may read the covering high file (prefix + continuation). That
    // is not a scrub window: it is a handful of files, all on `high`.
    expect(h.reads.filter((r) => r.kind === 'whole').length).toBeLessThan(5)
    expect(h.deps.readGop).toHaveBeenCalled()
    expect(
      h.deps.readBytes.mock.calls.every((c) => {
        const arg = c.at(0)
        return arg !== undefined && 'profile' in arg && arg.profile === 'high'
      }),
    ).toBe(true)
    feeder.dispose()
  })
})
