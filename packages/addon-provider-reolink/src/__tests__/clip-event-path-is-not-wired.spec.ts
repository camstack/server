/**
 * The event path is KEPT and NOT WIRED, and this is the red test in the way of
 * re-wiring it by accident (D565).
 *
 * `clip-event-catalog.ts` still exists, still compiles and is still exercised
 * by `clip-event-catalog.spec.ts`, because the hub's cross-child event feed is
 * a real future surface and re-deriving it from git history is the expensive
 * option. What it is NOT is the catalog: `FileInfoList` is, on every topology.
 *
 * The repo's rule is that a leftover which describes the right design is worse
 * than nothing, because it reads as verification. So "not wired" is not left
 * to a docblock nobody runs:
 *
 *  - the CATALOG path never calls `searchEventLog`, on either topology, in any
 *    of the four shapes a listing takes (cold source probe, a listing, a
 *    listing of a day the calendar does not name, playback);
 *  - the provider module does not import the event catalog at all, so a
 *    re-wiring is a visible import and not a one-line call.
 *
 * Both are asserted from COLD — nothing is listed first — because every
 * honest-state spec on this surface has at some point passed while the wire
 * lied, by warming the state before asking.
 */
import { resolveCameraUid } from '../clips/clip-addressing.js'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createReolinkVideoclipsProvider,
  type ReolinkVideoclipsDeps,
} from '../clips/reolink-videoclips-provider.js'
import { ClipCatalogCache } from '../clips/clip-catalog-cache.js'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'
import { createRecordingLogger } from './clip-test-logger.js'
import { REOLINK_ADDON_ID } from '../schema.js'

const NOW = Date.parse('2026-09-16T12:00:00Z')
const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')

function fakeApi() {
  return {
    getHddInfoList: vi.fn(async () => ({
      body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } } },
    })),
    getDayRecords: vi.fn(async () => ({ days: [{ day: 16 }] })),
    getVideoclips: vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [
            {
              fileName: 'RecS02_a',
              id: '/mnt/sda/U10CHILD-Camera N/RecS02_a.mp4',
              startTime: new Date('2026-09-16T06:30:00Z'),
              endTime: new Date('2026-09-16T06:31:12Z'),
              sizeBytes: 92_000,
              supportSub: true,
              recordType: 'none',
            },
          ],
    ),
    searchAlarmVideos: vi.fn(async () => []),
    /** Present on the api, and never called by the catalog. */
    searchEventLog: vi.fn(async () => {
      throw new Error('the catalog must not read the event log')
    }),
    getVideoclipThumbnailJpeg: vi.fn(async () => Buffer.from('jpeg')),
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

function harness(isHubChild: boolean) {
  const api = fakeApi()
  const logger = createRecordingLogger()
  const deps: ReolinkVideoclipsDeps = {
    now: () => NOW,
    cache: new ClipCatalogCache<ReolinkClipRow>({ now: () => NOW }),
    resolveDevice: async (deviceId) => ({
      deviceId,
      channel: 0,
      uid: resolveCameraUid({ metadataUid: 'U-CHILD', configUid: undefined }),
      isHubChild,
      isBattery: false,
      sleeping: false,
      timeZone: 'Europe/Rome',
      hostKey: '192.168.10.161',
      getApi: async () => api,
    }),
    hasVouchedThumbnail: async () => false,
    thumbnailUrl: () => '/t',
    thumbnailMintUrl: () => '/m',
    preparePlayback: async () => ({ playbackUrl: '/p.mp4', served: 'low' as const }),
    // Not this spec's subject. Named rather than thrown: a throwing stub
    // reads exactly like a method somebody forgot (D572).
    prepareBytes: async () => ({
      kind: 'refused' as const,
      code: 'fetch-failed' as const,
      detail: 'this fixture does not produce clip bytes',
    }),
    prepareOffer: async () => ({
      kind: 'refused' as const,
      code: 'fetch-failed' as const,
      detail: 'this fixture does not offer clip bytes',
    }),
    prepareStreamDial: async () => ({
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'no dial in this spec',
    }),
    logger,
  }
  return { provider: createReolinkVideoclipsProvider(deps), api }
}

describe('the catalog never reads the hub event log', () => {
  for (const [label, isHubChild] of [
    ['a hub child', true],
    ['a standalone', false],
  ] as const) {
    it(`${label}: listSources, cold, asks it nothing`, async () => {
      const { provider, api } = harness(isHubChild)
      await provider.listSources({ deviceId: 3628 })
      expect(api.searchEventLog).not.toHaveBeenCalled()
    })

    it(`${label}: listClips asks it nothing`, async () => {
      const { provider, api } = harness(isHubChild)
      await provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 3628,
        since: SINCE,
        until: UNTIL,
      })
      expect(api.searchEventLog).not.toHaveBeenCalled()
    })

    it(`${label}: a listing plus a playback asks it nothing`, async () => {
      const { provider, api } = harness(isHubChild)
      const clips = await provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 3628,
        since: SINCE,
        until: UNTIL,
      })
      const id = clips[0]?.id
      expect(id).toBeDefined()
      await provider.getClipPlayback({ deviceId: 3628, clipId: id ?? '' })
      expect(api.searchEventLog).not.toHaveBeenCalled()
    })
  }
})

describe('the event module is kept, and unreferenced by the catalog', () => {
  it('the provider does not import `clip-event-catalog`', async () => {
    // A re-wiring must be a deliberate, visible act — an import somebody adds
    // and a reviewer sees — rather than a call that slips back in.
    const source = await readFile(
      new URL('../clips/reolink-videoclips-provider.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/from '\.\/clip-event-catalog\.js'/)
  })

  it('but the module still exists and still works', async () => {
    // Kept, so it stays exercised and cannot rot silently into something that
    // would not compile the day it is wanted.
    const { joinEventsToFiles } = await import('../clips/clip-event-catalog.js')
    expect(
      joinEventsToFiles(
        [
          {
            channel: 0,
            startMs: 10,
            endMs: 20,
            nativeTypes: ['people'],
            hasRecFile: false,
          },
        ],
        [],
      )[0]?.unplayableReason,
    ).toBe('no-rec-file')
  })

  it('its docblock SAYS it is not wired, in the first line', async () => {
    // "Keep it for later" written as a hopeful TODO is the leftover class this
    // repo keeps paying for: it reads as verification that something is live.
    const source = await readFile(
      new URL('../clips/clip-event-catalog.ts', import.meta.url),
      'utf8',
    )
    const firstLine = source.split('\n').find((line) => line.trim().startsWith('* ')) ?? ''
    expect(firstLine).toMatch(/NOT WIRED/)
  })
})
