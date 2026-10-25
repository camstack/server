/**
 * The mint POLICY: which question is asked first, what the camera's one
 * replay slot is spent on, and what every refusal is called.
 *
 * Every test drives the real `mintClipStill` and asserts what it DID —
 * whether the camera was dialled, whether the lane was held and given back,
 * which code came back. None asserts that a constant exists.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

import { mintClipStill, type MintClipStillDeps } from '../clip-still-mint.js'
import type { AmcrestClipRow } from '../clip-search.js'
import { createClipStillGuard, type ClipStillGuard } from '../clip-still-guard.js'
import { createReplayLane, type ReplayLane } from '../replay-lane.js'

const DEVICE_ID = 3836
const START_MS = Date.UTC(2026, 8, 23, 17, 4, 59)
const END_MS = Date.UTC(2026, 8, 23, 17, 8, 24)
const CLIP_KEY = `${String(START_MS / 1000)}-${String(END_MS / 1000)}`

function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function makeRow(overrides: Partial<AmcrestClipRow> = {}): AmcrestClipRow {
  return {
    clipKey: CLIP_KEY,
    startMs: START_MS,
    endMs: END_MS,
    windowMs: END_MS - START_MS,
    sizeBytes: 56_242_806,
    filePath: '/mnt/sd/2026-09-23/001/dav/19/19.04.59-19.08.24[M][0@0][0].mp4',
    events: ['VideoMotion'],
    flags: ['Event'],
    channel: 0,
    ...overrides,
  }
}

interface Probe {
  readonly deps: MintClipStillDeps
  readonly logger: IScopedLogger
  readonly lane: ReplayLane
  /** Every window a replay URL was built for — the camera reach, recorded. */
  readonly dialled: { startMs: number; endMs: number }[]
  readonly cuts: string[]
  readonly stored: Buffer[]
}

function probe(
  options: {
    readonly camera?: boolean
    readonly row?: AmcrestClipRow | undefined
    readonly url?: Awaited<ReturnType<MintClipStillDeps['replayUrlFor']>>
    readonly cut?: Awaited<ReturnType<MintClipStillDeps['cut']>>
    readonly lane?: ReplayLane
    readonly guard?: ClipStillGuard
    readonly rowFor?: MintClipStillDeps['rowFor']
    readonly cutFor?: (url: string) => Awaited<ReturnType<MintClipStillDeps['cut']>>
    readonly readCached?: MintClipStillDeps['readCached']
  } = {},
): Probe {
  const logger = makeLogger()
  const guard = options.guard ?? createClipStillGuard({ logger })
  const lane = options.lane ?? createReplayLane({ logger, waitMs: 5 })
  const dialled: { startMs: number; endMs: number }[] = []
  const cuts: string[] = []
  const stored: Buffer[] = []
  const deps: MintClipStillDeps = {
    logger,
    lane,
    guard,
    readCached: options.readCached ?? (async () => null),
    hasCamera: async () => options.camera !== false,
    rowFor: options.rowFor ?? (() => ('row' in options ? options.row : makeRow())),
    replayUrlFor: async (_deviceId, _row, window) => {
      dialled.push({ startMs: window.startMs, endMs: window.endMs })
      return (
        options.url ?? {
          kind: 'ok',
          url: 'rtsp://cam/cam/playback?starttime=mid',
        }
      )
    },
    cut: async (input) => {
      cuts.push(input.url)
      const scripted = options.cutFor?.(input.url)
      if (scripted !== undefined) return scripted
      return (
        options.cut ?? {
          kind: 'ok',
          bytes: Buffer.from([0xff, 0xd8]),
          slotMs: 1_721,
        }
      )
    },
    putStill: async (_deviceId, _clipKey, bytes) => {
      stored.push(bytes)
    },
  }
  return { deps, logger, lane, dialled, cuts, stored }
}

describe('mintClipStill — the cheap questions first (D54)', () => {
  it('refuses a device this addon does not own without reaching the camera', async () => {
    const p = probe({ camera: false })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('unknown-device')
    expect(result.disposition).toBe('final')
    expect(p.dialled).toEqual([])
    expect(p.cuts).toEqual([])
    expect(p.lane.held(DEVICE_ID)).toBe(false)
  })

  it('refuses a clip nobody listed without reaching the camera', async () => {
    const p = probe({ row: undefined })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('no-catalog-row')
    expect(p.dialled).toEqual([])
  })

  it('refuses a row with no window to take a midpoint of, before the lane is taken', async () => {
    const p = probe({ row: makeRow({ endMs: START_MS }) })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('no-keyframe')
    expect(result.disposition).toBe('final')
    expect(p.dialled).toEqual([])
    expect(p.lane.held(DEVICE_ID)).toBe(false)
  })
})

describe('mintClipStill — the camera’s one replay slot', () => {
  it('dials the MIDPOINT of the clip, not its head', async () => {
    const p = probe({})
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(true)
    expect(p.dialled).toEqual([{ startMs: START_MS + (END_MS - START_MS) / 2, endMs: END_MS }])
    expect(p.cuts).toEqual(['rtsp://cam/cam/playback?starttime=mid'])
    expect(p.stored).toHaveLength(1)
  })

  it('gives the slot back once the cut is done', async () => {
    const p = probe({})
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(p.lane.held(DEVICE_ID)).toBe(false)
  })

  it('WAITS its turn behind a held slot instead of being refused, then dials', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    const holder = await lane.acquire(DEVICE_ID, 'stream')
    expect(holder.kind).toBe('held')
    const p = probe({ lane })
    const pending = mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(p.dialled).toEqual([])
    if (holder.kind === 'held') holder.release()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(p.cuts).toHaveLength(1)
  })

  it('DEFERS by name when the camera’s queue is full, and never dials', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5, maxPending: 0 })
    await lane.acquire(DEVICE_ID, 'stream')
    const p = probe({ lane })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    // By NAME, and "come back" — never an absence that reads as "no picture".
    expect(result.code).toBe('queue-full')
    expect(result.disposition).toBe('deferred')
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(result.reason).toContain('queue-full')
    expect(p.dialled).toEqual([])
  })

  it('never dials for a caller that went away while it queued', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    const holder = await lane.acquire(DEVICE_ID, 'stream')
    const p = probe({ lane })
    const gone = new AbortController()
    const pending = mintClipStill(DEVICE_ID, CLIP_KEY, p.deps, gone.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    gone.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    // Named for what happened — the caller went away — never `queue-full`.
    expect('abandoned' in result && result.abandoned).toBe(true)
    if (holder.kind === 'held') holder.release()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(p.dialled).toEqual([])
    expect(lane.held(DEVICE_ID)).toBe(false)
  })

  it('DEFERS a mint an operator’s playback evicted, and gives the slot back', async () => {
    const p = probe({
      cut: { kind: 'refused', code: 'yielded', detail: 'a playback wanted it' },
    })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('queue-full')
    expect(result.disposition).toBe('deferred')
    expect(p.lane.held(DEVICE_ID)).toBe(false)
    expect(p.stored).toEqual([])
  })

  it('names a camera refusal as the camera’s, verbatim, and gives the slot back', async () => {
    const p = probe({
      cut: {
        kind: 'refused',
        code: 'camera-refused',
        detail: 'the camera answered 404 to the replay DESCRIBE',
      },
    })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('camera-refused')
    expect(result.disposition).toBe('final')
    expect(result.reason).toContain('404')
    expect(p.lane.held(DEVICE_ID)).toBe(false)
  })

  it('refuses when the clock the replay URL needs could not be read — and does not dial', async () => {
    const p = probe({
      url: {
        kind: 'refused',
        detail: 'this camera would not say what time it thinks it is',
      },
    })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('camera-refused')
    expect(p.cuts).toEqual([])
    expect(p.lane.held(DEVICE_ID)).toBe(false)
  })

  it('stores nothing when the decode failed', async () => {
    const p = probe({
      cut: {
        kind: 'refused',
        code: 'decode-failed',
        detail: 'ffmpeg exited 1',
      },
    })
    const result = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(result.ok).toBe(false)
    if (result.ok || 'abandoned' in result) throw new Error('unreachable')
    expect(result.code).toBe('decode-failed')
    expect(p.stored).toEqual([])
  })

  it('logs every line about this camera against the numeric deviceId', async () => {
    const p = probe({})
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    const calls = [
      ...vi.mocked(p.logger.warn).mock.calls,
      ...vi.mocked(p.logger.debug).mock.calls,
      ...vi.mocked(p.logger.info).mock.calls,
    ]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const extras = call[1] as { tags?: { deviceId?: number } } | undefined
      expect(extras?.tags?.deviceId).toBe(DEVICE_ID)
    }
  })
})

describe('the replay lane, with a still in it', () => {
  it('lets a PLAYBACK evict a mint rather than queue behind it', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 50 })
    let yielded = false
    const still = await lane.acquire(DEVICE_ID, 'still', () => {
      yielded = true
    })
    expect(still.kind).toBe('held')
    const asked = lane.acquire(DEVICE_ID, 'stream')
    // The mint is told at once — it does not wait for the playback's own
    // patience to run out.
    expect(yielded).toBe(true)
    if (still.kind !== 'held') throw new Error('unreachable')
    still.release()
    expect((await asked).kind).toBe('held')
  })

  it('does NOT evict a playback for a mint — speculative work is subordinate', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    let yielded = false
    const stream = await lane.acquire(DEVICE_ID, 'stream', () => {
      yielded = true
    })
    expect(stream.kind).toBe('held')
    let settled = false
    const mint = lane.acquire(DEVICE_ID, 'still').then((lease) => {
      settled = true
      return lease
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(yielded).toBe(false)
    // Queued behind the playback, not refused and not granted.
    expect(settled).toBe(false)
    if (stream.kind === 'held') stream.release()
    expect((await mint).kind).toBe('held')
  })

  it('does not evict one mint for another — they take turns', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    let yielded = false
    const first = await lane.acquire(DEVICE_ID, 'still', () => {
      yielded = true
    })
    const second = lane.acquire(DEVICE_ID, 'still')
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(yielded).toBe(false)
    if (first.kind === 'held') first.release()
    expect((await second).kind).toBe('held')
  })
})

describe('a camera that is failing its replays is left alone', () => {
  const REFUSED = {
    kind: 'refused',
    code: 'camera-refused',
    detail: 'the camera produced no frame within 5000 ms: ffmpeg said nothing',
  } as const

  function rowForKey(_deviceId: number, clipKey: string): AmcrestClipRow {
    const [start, end] = clipKey.split('-').map(Number)
    return makeRow({ clipKey, startMs: (start ?? 0) * 1000, endMs: (end ?? 0) * 1000 })
  }

  it('remembers a failed still: a remount is answered from memory, not the camera', async () => {
    const p = probe({ cut: REFUSED })
    const first = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    const again = await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(first.ok).toBe(false)
    expect(again.ok).toBe(false)
    if (again.ok || 'abandoned' in again) throw new Error('unreachable')
    expect(again.code).toBe('camera-refused')
    expect(again.disposition).toBe('final')
    expect(p.cuts).toHaveLength(1)
  })

  it('forgets a failed still once the memory lapses', async () => {
    let clock = 1_000_000
    const logger = makeLogger()
    const guard = createClipStillGuard({ logger, now: () => clock, memoryMs: 60_000 })
    const p = probe({ cut: REFUSED, guard })
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    clock += 60_001
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    expect(p.cuts).toHaveLength(2)
  })

  it('pauses the camera after two consecutive failures — the third clip is never dialled', async () => {
    const logger = makeLogger()
    const guard = createClipStillGuard({ logger })
    const p = probe({ cut: REFUSED, guard, rowFor: rowForKey })
    await mintClipStill(DEVICE_ID, '1790224000-1790224100', p.deps)
    await mintClipStill(DEVICE_ID, '1790224100-1790224200', p.deps)
    const third = await mintClipStill(DEVICE_ID, '1790224200-1790224300', p.deps)
    const fourth = await mintClipStill(DEVICE_ID, '1790224300-1790224400', p.deps)
    expect(p.cuts).toHaveLength(2)
    expect(third.ok).toBe(false)
    if (third.ok || 'abandoned' in third) throw new Error('unreachable')
    expect(third.code).toBe('camera-backoff')
    expect(third.disposition).toBe('deferred')
    expect(third.retryAfterMs).toBeGreaterThan(0)
    expect(fourth.ok).toBe(false)
    // Logged ONCE when the pause opens, against the numeric deviceId.
    const pauses = vi
      .mocked(logger.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('pausing clip stills'))
    expect(pauses).toHaveLength(1)
    const extras = pauses[0]?.[1] as { tags?: { deviceId?: number } } | undefined
    expect(extras?.tags?.deviceId).toBe(DEVICE_ID)
  })

  it('does not dial for a still that was QUEUED when the pause opened', async () => {
    const guard = createClipStillGuard({ logger: makeLogger() })
    const p = probe({ cut: REFUSED, guard, rowFor: rowForKey })
    const all = await Promise.all([
      mintClipStill(DEVICE_ID, '1790224000-1790224100', p.deps),
      mintClipStill(DEVICE_ID, '1790224100-1790224200', p.deps),
      mintClipStill(DEVICE_ID, '1790224200-1790224300', p.deps),
    ])
    expect(p.cuts).toHaveLength(2)
    const last = all[2]
    if (last === undefined || last.ok || 'abandoned' in last) throw new Error('unreachable')
    expect(last.code).toBe('camera-backoff')
  })

  it('a success in between resets the count', async () => {
    const guard = createClipStillGuard({ logger: makeLogger() })
    let calls = 0
    const p = probe({
      guard,
      rowFor: rowForKey,
      cutFor: () => {
        calls += 1
        return calls % 2 === 1 ? REFUSED : { kind: 'ok', bytes: Buffer.from([1]), slotMs: 1 }
      },
    })
    for (const key of [
      '1790224000-1790224100',
      '1790224100-1790224200',
      '1790224200-1790224300',
      '1790224300-1790224400',
    ]) {
      await mintClipStill(DEVICE_ID, key, p.deps)
    }
    expect(p.cuts).toHaveLength(4)
  })

  it('resumes once the pause lapses, and the pause is per camera', async () => {
    let clock = 1_000_000
    const guard = createClipStillGuard({ logger: makeLogger(), now: () => clock, pauseMs: 60_000 })
    const p = probe({ cut: REFUSED, guard, rowFor: rowForKey })
    await mintClipStill(DEVICE_ID, '1790224000-1790224100', p.deps)
    await mintClipStill(DEVICE_ID, '1790224100-1790224200', p.deps)
    await mintClipStill(1436, '1790224200-1790224300', p.deps)
    expect(p.cuts).toHaveLength(3)
    clock += 60_001
    await mintClipStill(DEVICE_ID, '1790224300-1790224400', p.deps)
    expect(p.cuts).toHaveLength(4)
  })
})

describe('review round 1 — the mint', () => {
  it('a clock that could not be read counts against the camera and is remembered', async () => {
    const p = probe({
      url: { kind: 'refused', detail: 'this camera would not say what time it thinks it is' },
    })
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    await mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    // Remembered: the second ask never built a URL.
    expect(p.dialled).toHaveLength(1)
  })

  it('two clock refusals in a row pause the camera like two failed cuts', async () => {
    const guard = createClipStillGuard({ logger: makeLogger() })
    const p = probe({
      guard,
      rowFor: (_d, clipKey) => {
        const [start, end] = clipKey.split('-').map(Number)
        return makeRow({ clipKey, startMs: (start ?? 0) * 1000, endMs: (end ?? 0) * 1000 })
      },
      url: { kind: 'refused', detail: 'no clock' },
    })
    await mintClipStill(DEVICE_ID, '1790224000-1790224100', p.deps)
    await mintClipStill(DEVICE_ID, '1790224100-1790224200', p.deps)
    const third = await mintClipStill(DEVICE_ID, '1790224200-1790224300', p.deps)
    if (third.ok || 'abandoned' in third) throw new Error('unreachable')
    expect(third.code).toBe('camera-backoff')
  })

  it('a still minted while this one queued is served from the cache, not dialled twice', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    const holder = await lane.acquire(DEVICE_ID, 'still')
    const jpeg = Buffer.from([0xff, 0xd8, 0x01])
    let cached: Buffer | null = null
    const p = probe({ lane, readCached: async () => cached })
    const pending = mintClipStill(DEVICE_ID, CLIP_KEY, p.deps)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    // The holder minted this very clip for another client.
    cached = jpeg
    if (holder.kind === 'held') holder.release()
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.bytes.equals(jpeg)).toBe(true)
    expect(p.dialled).toEqual([])
    expect(lane.held(DEVICE_ID)).toBe(false)
  })
})
