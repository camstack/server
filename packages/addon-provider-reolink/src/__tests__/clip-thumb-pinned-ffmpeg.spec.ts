/**
 * A clip still is decoded by the node's PINNED ffmpeg (D540) — never by a
 * PATH `ffmpeg`.
 *
 * The CoverPreview answer is a raw H.264/H.265 I-frame, and the library turns
 * it into a JPEG with ffmpeg. Its own default for that binary is the bare name
 * `ffmpeg`, which on the hub image is not on PATH at all: every still on 3629,
 * 3628 and 618 was refused for over a day with `spawn ffmpeg ENOENT`, reported
 * as `camera-refused` — the camera had answered perfectly.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { createRecordingLogger } from './clip-test-logger.js'
import { REOLINK_ADDON_ID } from '../schema.js'

const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')
const PINNED = '/data/deps/ffmpeg-8.1.2-5/ffmpeg'

const scratchDirs: string[] = []

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

function fakeApi() {
  return {
    getHddInfoList: vi.fn(async () => ({
      body: {
        HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } },
      },
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
              startTime: new Date('2026-09-16T06:30:00Z'),
              endTime: new Date('2026-09-16T06:31:12Z'),
              sizeBytes: 92_000,
              supportSub: true,
              recordType: 'md,people',
            },
          ],
    ),
    searchAlarmVideos: vi.fn(async () => []),
    getVideoclipThumbnailJpeg: vi.fn(async (_params: { ffmpegPath?: string }) =>
      Buffer.from('a-real-jpeg'),
    ),
    fileInfoListReplayBinaryDownload: vi.fn(async () => {
      throw new Error('the clip stream path must not be called here')
    }),
    downloadRecordingDemuxed: vi.fn(async () => {
      throw new Error('the clip byte path must not be called here')
    }),
  }
}

async function serviceWith(resolveFfmpeg: () => Promise<string>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-ffmpeg-'))
  scratchDirs.push(dataDir)
  const api = fakeApi()
  const logger = createRecordingLogger()
  const device: ClipDeviceRef = {
    deviceId: 3629,
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
    resolveFfmpeg,
    dataDir,
    logger,
    resolveDevice: async () => device,
  })
  await service.provider.listClips({
    provider: REOLINK_ADDON_ID,
    deviceId: 3629,
    since: SINCE,
    until: UNTIL,
  })
  return { service, api, logger }
}

describe('a clip still is decoded by the pinned ffmpeg', () => {
  it('hands the library the RESOLVED binary, never its PATH default', async () => {
    const { service, api } = await serviceWith(async () => PINNED)

    const pass = await service.prefetchThumbnails(3629)

    expect(pass.minted).toBe(1)
    expect(api.getVideoclipThumbnailJpeg).toHaveBeenCalledTimes(1)
    expect(api.getVideoclipThumbnailJpeg.mock.calls[0]?.[0].ffmpegPath).toBe(PINNED)
  })

  it('refuses as OUR decode failure, without asking the camera, when no pinned ffmpeg resolves', async () => {
    const { service, api, logger } = await serviceWith(async () => {
      throw new Error('download refused: sha mismatch')
    })

    const pass = await service.prefetchThumbnails(3629)

    expect(pass.minted).toBe(0)
    expect(pass.refusal?.code).toBe('decode-failed')
    expect(pass.refusal?.disposition).toBe('final')
    // The login is the wake on a battery camera; no binary, no reason to knock.
    expect(api.getVideoclipThumbnailJpeg).not.toHaveBeenCalled()
    const line = logger.warns.find((w) => w.message.includes('thumbnail mint refused'))
    expect(line?.extras.tags?.['deviceId']).toBe(3629)
  })
})
