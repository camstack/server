/**
 * The uid requirement is the HUB CHILD's, not every camera's.
 *
 * Measured 2026-09-20 on the live fleet:
 *  - **standalone (592)** — `getDayRecords` answered the same 19 days with the
 *    right uid, with a WRONG uid and with NONE at all: the camera ignores it,
 *    and nodelink-js resolves a standalone's own uid over cmd 114 when a
 *    command really needs one. 592 has no `metadata.uid` persisted and never
 *    will, because nothing writes one for a standalone;
 *  - **hub child (3628)** — the uid is what SELECTS the camera: channel 1
 *    asked with channel 0's uid answers channel 0's days, and the hub's own
 *    uid addresses no catalog at all.
 *
 * So the gate belongs to the topology. An unconditional one refused 592 — a
 * camera that had listed 209 clips through this very provider an hour earlier
 * — with `uid-missing`, which is the "absent vs not-yet-known" defect wearing
 * a vendor hat: it is not that 592 has no clips, it is that we declined to
 * ask.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger } from './clip-test-logger.js'

const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')

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
              startTime: new Date('2026-09-16T06:30:00Z'),
              endTime: new Date('2026-09-16T06:31:12Z'),
              sizeBytes: 92_000,
              supportSub: true,
              recordType: 'md,people',
            },
          ],
    ),
    searchAlarmVideos: vi.fn(async () => []),
    getVideoclipThumbnailJpeg: vi.fn(async () => Buffer.from('a-real-jpeg')),
    // The 0.7.10 shape, and the numbers are the ones measured on 592
    // (2026-09-20, sub file): AAC/ADTS 16 kHz mono beside 15 fps of video.
    // The STREAM path (stage 1) is not what this spec exercises; a fake that
    // answered bytes here would vouch for a route nobody asserted.
    fileInfoListReplayBinaryDownload: vi.fn(async () => {
      throw new Error('the clip stream path must not be called here')
    }),
    downloadRecordingDemuxed: vi.fn(async () => ({
      annexB: Buffer.from('annexb'),
      videoType: 'H264' as const,
      audio: {
        codec: 'Aac' as const,
        format: 'adts' as const,
        data: Buffer.from('adts'),
        frames: 677,
        bytes: 351_363,
        sampleRate: 16_000,
        channels: 1,
        durationSeconds: 43.328,
      },
      stats: {
        keyframes: 1,
        fps: 15,
        fpsSource: 'timestamps' as const,
        infoFps: 15,
        durationSeconds: 43.254,
        audioPackets: 677,
        audioBytes: 351_363,
      },
    })),
  }
}

async function standaloneWithoutUid() {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-uid-'))
  scratchDirs.push(dataDir)
  const api = fakeApi()
  const logger = createRecordingLogger()
  const device: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    // 592 as the hub really holds it: no `metadata.uid`, and a standalone.
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: '192.168.60.226',
    getApi: async () => api,
  }
  const service = createClipService({
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    dataDir,
    logger,
    resolveDevice: async () => device,
  })
  return { service, api, logger }
}

describe('a standalone camera addresses its catalog without a uid', () => {
  it('mints the still for a clip on a camera with no persisted uid', async () => {
    const { service, api } = await standaloneWithoutUid()
    const clips = await service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips.length).toBe(1)

    // `prefetchThumbnails` is the mint path without the HTTP layer: the same
    // gate, the same queue, the same store.
    const pass = await service.prefetchThumbnails(107)

    expect(pass.minted).toBe(1)
    expect(pass.stop).toBe('rows-exhausted')
    expect(api.getVideoclipThumbnailJpeg).toHaveBeenCalled()
  })
})
