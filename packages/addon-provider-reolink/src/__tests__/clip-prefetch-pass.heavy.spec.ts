/**
 * ONE prefetch pass over a device's catalog — what it spends and where it stops.
 *
 * Every assertion here is over a SEQUENCE, because the two defects this pass
 * can have are "never runs" and "runs for ever" and neither is visible in a
 * single value:
 *
 *  - **never runs (measured).** The bound was on the rows EXAMINED
 *    (`slice(0, limit)`), so a camera that records more than the bound in one
 *    pass could never backfill anything behind its newest 20. 592 recorded 396
 *    clips in the 24 h of 2026-09-21 and held a vouched still for 25.3 % of the
 *    1 188 rows in its cache: the newest 20 were always warm and rows 21 and
 *    older could not be reached by any number of passes. The budget is now on
 *    MINTS, and the scan walks the whole catalog newest-first behind them.
 *  - **runs for ever (measured).** 618 is a mains standalone whose
 *    `CoverPreview` does not answer: three cold mints on 2026-09-21 took
 *    30 041 / 30 017 / 30 020 ms and each answered `camera-refused` / `final`.
 *    That is a TIMEOUT, not a `400 rejected`, so `ClipThumbQueue`'s
 *    sulking-host backoff never arms for it — the lane is free and the next row
 *    walks into the same wall. A budget of 60 on that camera is 30 minutes of
 *    the host's lane per pass, minting nothing, for ever. So the pass stops on
 *    the FIRST refusal and names it; the scheduler turns that into a quiet
 *    period (`clip-prefetch-is-wired.spec.ts`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PREFETCH_BATCH } from '../clips/clip-prefetch.js'
import { type ClipService, createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger, type RecordingSink } from './clip-test-logger.js'

const DAY = '2026-09-16'
const SINCE = Date.parse(`${DAY}T00:00:00Z`)
const UNTIL = Date.parse(`${DAY}T23:59:59Z`)

const scratchDirs: string[] = []

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

interface ClipFixture {
  readonly service: ClipService
  readonly stills: ReturnType<typeof vi.fn>
  readonly logger: RecordingSink
  readonly dataDir: string
}

/**
 * A mains standalone holding `rows` clips on one day.
 *
 * Shaped like 592: a real catalog answer per day, sub files only, and a
 * `CoverPreview` that returns bytes. `stillFails` is how a camera that does
 * not answer is expressed — a thrown error, exactly as the wrapper throws.
 */
async function fixture(input: {
  readonly rows: number
  readonly failFromCall?: number
}): Promise<ClipFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-prefetch-'))
  scratchDirs.push(dataDir)
  let stillCalls = 0
  const stills = vi.fn(async () => {
    stillCalls += 1
    if (input.failFromCall !== undefined && stillCalls >= input.failFromCall) {
      throw new Error('Baichuan CoverPreview timed out after 30000 ms')
    }
    return Buffer.from(`a-real-jpeg-${stillCalls}`)
  })
  const api = {
    getHddInfoList: vi.fn(async () => ({
      body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } } },
    })),
    getDayRecords: vi.fn(async () => ({
      index: 0,
      channelId: 0,
      days: [{ day: 16, type: 'normal' }],
    })),
    getVideoclips: vi.fn(async ({ streamType }: { streamType?: string }) => {
      if (streamType === 'mainStream') return []
      return Array.from({ length: input.rows }, (_unused, i) => ({
        fileName: `RecS02_${String(i).padStart(4, '0')}`,
        id: `/mnt/sda/RecS02_${String(i).padStart(4, '0')}.mp4`,
        // Newest LAST in the listing on purpose: the pass must sort, not trust
        // the camera's order.
        startTime: new Date(SINCE + i * 60_000),
        endTime: new Date(SINCE + i * 60_000 + 30_000),
        sizeBytes: 92_000,
        supportSub: true,
        recordType: 'md,people',
      }))
    }),
    searchAlarmVideos: vi.fn(async () => []),
    getVideoclipThumbnailJpeg: stills,
    // Never called here — this file is about stills — but the ref's api type
    // carries the media half too, and a narrowed fake would be a second shape
    // of `ReolinkClipApi` in the suite.
    // The STREAM path (stage 1) is not what this spec exercises; a fake that
    // answered bytes here would vouch for a route nobody asserted.
    fileInfoListReplayBinaryDownload: vi.fn(async () => {
      throw new Error('the clip stream path must not be called here')
    }),
    downloadRecordingDemuxed: vi.fn(async () => ({
      annexB: Buffer.from('annexb'),
      videoType: 'H264' as const,
      audio: null,
      stats: {
        keyframes: 1,
        fps: 15,
        fpsSource: 'timestamps' as const,
        infoFps: 15,
        durationSeconds: 30,
        audioPackets: 0,
        audioBytes: 0,
      },
    })),
  }
  const logger = createRecordingLogger()
  const device: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: '192.168.10.161',
    getApi: async () => api,
  }
  const service = createClipService({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    dataDir,
    logger,
    resolveDevice: async () => device,
  })
  await service.provider.listClips({
    provider: REOLINK_ADDON_ID,
    deviceId: 107,
    since: SINCE,
    until: UNTIL,
  })
  return { service, stills, logger, dataDir }
}

describe('a prefetch pass budgets MINTS, so it can reach behind the live edge', () => {
  it('backfills the rows behind the ones a previous pass already warmed', async () => {
    // 200 rows; the first pass warms the newest 100. A budget on rows examined
    // makes the SECOND pass a no-op for ever — which is why 592 sat at 25.3 %.
    const { service, stills } = await fixture({ rows: 200 })

    const first = await service.prefetchThumbnails(592, 100)
    const firstCalls = stills.mock.calls.length
    const second = await service.prefetchThumbnails(592, 60)
    const secondCalls = stills.mock.calls.length - firstCalls
    const third = await service.prefetchThumbnails(592, 60)
    const thirdCalls = stills.mock.calls.length - firstCalls - secondCalls

    // The sequence, not any one value: each pass spends its whole budget on
    // rows the pass before it could not reach, and the fourth has nothing left.
    expect([first.minted, second.minted, third.minted]).toEqual([100, 60, 40])
    expect([firstCalls, secondCalls, thirdCalls]).toEqual([100, 60, 40])
    expect([first.stop, second.stop, third.stop]).toEqual(['budget', 'budget', 'rows-exhausted'])
    // And a fourth pass mints nothing at all: every row is held.
    const fourth = await service.prefetchThumbnails(592, 60)
    expect(fourth.minted).toBe(0)
    expect(fourth.alreadyHeld).toBe(200)
    expect(stills.mock.calls.length).toBe(200)
  })

  it('takes the NEWEST rows first, whatever order the camera listed them in', async () => {
    const { service } = await fixture({ rows: 30 })

    const pass = await service.prefetchThumbnails(592, 10)

    // The catalog rows the provider now vouches a still for are the ten newest
    // by start time — read back through the provider, not through a private
    // field.
    const clips = await service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    const vouched = clips
      .filter((clip) => clip.thumbnail !== undefined)
      .map((clip) => clip.timeRange.startMs)
      .toSorted((a, b) => b - a)
    const newest = clips
      .map((clip) => clip.timeRange.startMs)
      .toSorted((a, b) => b - a)
      .slice(0, 10)
    expect(pass.minted).toBe(10)
    expect(vouched).toEqual(newest)
  })

  it('defaults to a budget that covers the operator’s first screen', () => {
    // D574 measured a first paint of SIXTY tiles on 592. A budget under that
    // guarantees a cold first screen for ever, whatever else is true.
    expect(PREFETCH_BATCH).toBeGreaterThanOrEqual(60)
  })
})

describe('a prefetch pass stops on the first refusal', () => {
  it('does not walk sixty rows into a camera that is not answering', async () => {
    // 618's shape: the mint throws, the failure is a timeout rather than a
    // `400 rejected`, so nothing arms the queue's host backoff.
    const { service, stills, logger } = await fixture({ rows: 200, failFromCall: 3 })

    const pass = await service.prefetchThumbnails(592, 60)

    // Two landed, the third refused, and the pass stopped THERE — not at 60.
    expect(pass.minted).toBe(2)
    expect(pass.stop).toBe('refused')
    expect(stills.mock.calls.length).toBe(3)
    expect(pass.refusal?.code).toBe('camera-refused')
    expect(pass.refusal?.disposition).toBe('final')
    // The branch that dropped the work says so, per camera (D391).
    const line = logger.warns.find((w) => w.message.includes('thumbnail mint refused'))
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('stays stopped across repeated passes instead of paying the wall again', async () => {
    const { service, stills } = await fixture({ rows: 200, failFromCall: 1 })

    const passes = [
      await service.prefetchThumbnails(592, 60),
      await service.prefetchThumbnails(592, 60),
      await service.prefetchThumbnails(592, 60),
    ]

    // One attempt per pass, never a budget's worth. The pass itself is
    // stateless — what stops it coming back at all is the scheduler's quiet
    // ladder, asserted next door.
    expect(passes.map((p) => p.stop)).toEqual(['refused', 'refused', 'refused'])
    expect(passes.map((p) => p.minted)).toEqual([0, 0, 0])
    expect(stills.mock.calls.length).toBe(3)
  })
})

describe('a prefetch never evicts what the operator is about to open', () => {
  it('declines entirely once the device’s LRU is inside its headroom', async () => {
    const { service, stills, dataDir } = await fixture({ rows: 50 })
    // Real files under the store's real path: 6 × 10 MiB against a 64 MiB
    // bound leaves 6.25 % free, inside the 10 % a prefetch must keep.
    const dir = join(dataDir, 'clip-thumbs', '592')
    await mkdir(dir, { recursive: true })
    const ballast = Buffer.alloc(10 * 1024 * 1024, 1)
    const names = Array.from({ length: 6 }, (_unused, i) => `ballast${String(i)}.jpg`)
    for (const name of names) await writeFile(join(dir, name), ballast)

    const pass = await service.prefetchThumbnails(592, 60)

    expect(pass.stop).toBe('no-headroom')
    expect(pass.minted).toBe(0)
    expect(stills.mock.calls.length).toBe(0)
    // And nothing was pushed out to make room — eviction is the interactive
    // mint's business, never the prefetch's.
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).toSorted()).toEqual(names.toSorted())
  })
})
