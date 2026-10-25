/**
 * A clip fetch ENDS on a short silence, and proves it was whole.
 *
 * Nothing on the wire ends a cmd 5 download, so the library ends it on an idle
 * window. The default is 2 000 ms and this repo never passed one, so every
 * clip fetch spent two seconds waiting for a silence that had already
 * happened: 2 361–2 726 ms for a 31–34 s sub clip on 592 against 1 040–1 062
 * at 200 ms, 6 373–7 195 against 2 829–3 571 for a 20 MB main clip, 3 384
 * against 1 668 for a hub child (D568).
 *
 * Shortening the window trades a guarantee for speed, so the guarantee is
 * REPLACED, not dropped. The listed `sizeL` cannot do it — it has never
 * matched the received byte count on any clip measured. The DECODED duration
 * can: it landed within a second of the catalog row's own `endMs − startMs` on
 * every clip measured. So a pass whose decoded duration falls short is a
 * TRUNCATED fetch, named and retried on the long window, never muxed silently
 * into a clip an operator would take for complete.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLIP_DURATION_SHORTFALL_TOLERANCE_S,
  CLIP_IDLE_WINDOW_MS,
  CLIP_IDLE_WINDOW_RETRY_MS,
  judgeClipDuration,
} from '../clips/clip-truncation.js'
import { createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { createRecordingLogger, type RecordingSink } from './clip-test-logger.js'
import { REOLINK_ADDON_ID } from '../schema.js'

// ── the judge ─────────────────────────────────────────────────────────────

describe('the decoded duration judges the fetch against the row', () => {
  it('accepts every pair measured on the fleet', () => {
    // D568's four measured clips: the row's window is whole seconds and the
    // decode lands on either side of it.
    const measured = [
      { expectedMs: 34_000, decodedSeconds: 33.856 },
      { expectedMs: 31_000, decodedSeconds: 30.537 },
      { expectedMs: 22_000, decodedSeconds: 21.951 },
      { expectedMs: 31_000, decodedSeconds: 32.017 },
    ] as const
    for (const pair of measured) {
      expect(judgeClipDuration(pair).kind).toBe('complete')
    }
  })

  it('names a pass that fell materially short', () => {
    const verdict = judgeClipDuration({ expectedMs: 34_000, decodedSeconds: 12.5 })
    expect(verdict.kind).toBe('short')
    if (verdict.kind !== 'short') throw new Error('unreachable')
    expect(verdict.shortfallSeconds).toBeCloseTo(21.5, 3)
    expect(verdict.expectedSeconds).toBeCloseTo(34, 3)
    expect(verdict.decodedSeconds).toBeCloseTo(12.5, 3)
  })

  it('holds the tolerance exactly where the measurements put it', () => {
    const justInside = 34 - CLIP_DURATION_SHORTFALL_TOLERANCE_S
    expect(judgeClipDuration({ expectedMs: 34_000, decodedSeconds: justInside }).kind).toBe(
      'complete',
    )
    expect(judgeClipDuration({ expectedMs: 34_000, decodedSeconds: justInside - 0.01 }).kind).toBe(
      'short',
    )
  })

  it('never calls a LONGER decode truncated', () => {
    expect(judgeClipDuration({ expectedMs: 22_000, decodedSeconds: 40 }).kind).toBe('complete')
  })

  it('refuses to judge what it cannot measure', () => {
    // A measurement that failed is null, never zero (D393).
    expect(judgeClipDuration({ expectedMs: 34_000, decodedSeconds: null })).toEqual({
      kind: 'unknown',
      reason: 'duration-unmeasured',
    })
    expect(judgeClipDuration({ expectedMs: 0, decodedSeconds: 33.8 })).toEqual({
      kind: 'unknown',
      reason: 'row-window-unknown',
    })
    // An OPEN file's endMs is frozen (D563): it is not a window to judge.
    expect(
      judgeClipDuration({ expectedMs: 34_000, decodedSeconds: 3.2, inProgress: true }),
    ).toEqual({ kind: 'unknown', reason: 'clip-open' })
  })
})

// ── the fetch path ────────────────────────────────────────────────────────

const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')
/** 06:30:00 → 06:30:34 — a 34 s row, the shape D568 measured on 592. */
const CLIP_START = new Date('2026-09-16T06:30:00Z')
const CLIP_END = new Date('2026-09-16T06:30:34Z')

const scratchDirs: string[] = []

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

interface DownloadArgs {
  readonly idleTimeoutMs?: number
}

function downloadReturning(durations: readonly number[]) {
  const seen: DownloadArgs[] = []
  let call = 0
  const download = vi.fn(async (params: DownloadArgs) => {
    seen.push(params)
    const durationSeconds = durations[Math.min(call, durations.length - 1)] ?? null
    call += 1
    return {
      annexB: Buffer.from('annexb'),
      videoType: 'H264' as const,
      audio: null,
      stats: {
        keyframes: 13,
        fps: 15.019,
        fpsSource: 'timestamps' as const,
        infoFps: 30,
        durationSeconds,
        audioPackets: 0,
        audioBytes: 0,
      },
    }
  })
  return { download, seen }
}

function fakeApi(download: ReturnType<typeof downloadReturning>['download']) {
  return {
    getHddInfoList: vi.fn(async () => ({
      body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } } },
    })),
    getDayRecords: vi.fn(async () => ({
      index: 0,
      channelId: 0,
      days: [{ day: 16, type: 'normal' }],
    })),
    getVideoclips: vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [
            {
              fileName: 'RecS02_a',
              id: '/mnt/sda/RecS02_a.mp4',
              startTime: CLIP_START,
              endTime: CLIP_END,
              sizeBytes: 695_125,
              supportSub: true,
              recordType: 'md,people',
            },
          ],
    ),
    searchAlarmVideos: vi.fn(async () => []),
    getVideoclipThumbnailJpeg: vi.fn(async () => Buffer.from('a-real-jpeg')),
    // The STREAM path (stage 1) is not what this spec exercises; a fake that
    // answered bytes here would vouch for a route nobody asserted.
    fileInfoListReplayBinaryDownload: vi.fn(async () => {
      throw new Error('the clip stream path must not be called here')
    }),
    downloadRecordingDemuxed: download,
  }
}

interface Harness {
  readonly play: () => Promise<number>
  readonly seen: DownloadArgs[]
  readonly download: ReturnType<typeof downloadReturning>['download']
  readonly logger: RecordingSink
}

async function harness(durations: readonly number[]): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-completion-'))
  scratchDirs.push(dataDir)
  const { download, seen } = downloadReturning(durations)
  const api = fakeApi(download)
  const logger = createRecordingLogger()
  const device: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: '192.168.60.226',
    getApi: async () => api,
  }
  const service = createClipService({
    dataDir,
    logger,
    resolveDevice: async () => device,
    // The mux is not what these tests are about, and a binary that cannot be
    // spawned fails the same way everywhere. Everything asserted here happens
    // strictly before it.
    resolveFfmpeg: async () => join(dataDir, 'no-such-ffmpeg'),
  })

  const play = async (): Promise<number> => {
    const clips = await service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    // The key an operator's player would use: the one the mint URL carries.
    const clipKey = clips[0]?.thumbnailMint?.split('/').at(-1) ?? ''
    const res = new PassThrough()
    let status = 0
    Object.assign(res, {
      writeHead(code: number) {
        status = code
        return res
      },
    })
    const req = { url: `/107/${clipKey}.mp4`, method: 'GET', headers: {} }
    await service.playbackHandler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    )
    return status
  }

  return { play, seen, download, logger }
}

describe('a clip fetch ends on the short idle window', () => {
  it('passes the window the measurements chose, on the first attempt', async () => {
    const { play, seen } = await harness([33.856])
    await play()
    expect(seen.length).toBe(1)
    expect(seen[0]?.idleTimeoutMs).toBe(CLIP_IDLE_WINDOW_MS)
  })

  it('says nothing about truncation when the decode matches the row', async () => {
    const { play, logger } = await harness([33.856])
    await play()
    expect(logger.warns.filter((line) => line.message.includes('truncated'))).toEqual([])
  })
})

describe('a short decode is a truncated fetch, named and retried', () => {
  it('retries once on the long window and names the numbers that decided it', async () => {
    const { play, seen, logger } = await harness([12.5, 33.856])
    await play()

    expect(seen.map((args) => args.idleTimeoutMs)).toEqual([
      CLIP_IDLE_WINDOW_MS,
      CLIP_IDLE_WINDOW_RETRY_MS,
    ])

    const warn = logger.warns.find((line) => line.message.includes('truncated'))
    expect(warn).toBeDefined()
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta).toMatchObject({
      branch: 'truncated-fetch',
      idleTimeoutMs: CLIP_IDLE_WINDOW_MS,
      expectedSeconds: 34,
      decodedSeconds: 12.5,
    })
  })

  it('reports a clip that is STILL short after the long window, distinctly', async () => {
    const { play, seen, logger } = await harness([12.5, 12.5])
    await play()

    // Retried ONCE. A camera that serves a short file twice is not a window
    // artefact, and a third pass would only cost the operator another wait.
    expect(seen.length).toBe(2)
    const after = logger.warns.find(
      (line) => line.extras.meta?.['branch'] === 'truncated-after-retry',
    )
    expect(after).toBeDefined()
    expect(after?.extras.tags).toEqual({ deviceId: 107 })
    expect(after?.extras.meta).toMatchObject({
      idleTimeoutMs: CLIP_IDLE_WINDOW_RETRY_MS,
      expectedSeconds: 34,
      decodedSeconds: 12.5,
    })
  })

  it('keeps the LONGER of the two passes — a retry never serves less media', async () => {
    const { play, download, logger } = await harness([20, 12.5])
    await play()
    expect(download).toHaveBeenCalledTimes(2)
    const after = logger.warns.find(
      (line) => line.extras.meta?.['branch'] === 'truncated-after-retry',
    )
    expect(after?.extras.meta).toMatchObject({ decodedSeconds: 20 })
  })
})
