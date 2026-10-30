/**
 * The Reolink `videoclips` provider — slice 2.
 *
 * The enforcement D549 asked for, as tests:
 *  - "a read never logs into a standalone battery camera" — a fake that
 *    RECORDS logins and asserts zero while `sleeping`;
 *  - "every hub child call resolves to the parent's api object" (`toBe`), and
 *    the clip path constructs no session of its own;
 *  - a source that cannot answer produces a ROW with a reason, never an
 *    absence (D554 4);
 *  - every clip id carries its own source prefix, so the collection
 *    dispatcher's routing key and the id mint cannot drift apart.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveCameraUid } from '../clips/clip-addressing.js'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'
import { ClipCatalogCache } from '../clips/clip-catalog-cache.js'
import { CLIP_SOURCE_ONBOARD } from '../clips/clip-identity.js'
import {
  createReolinkVideoclipsProvider,
  type ReolinkVideoclipsDeps,
} from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger } from './clip-test-logger.js'

const NOW = Date.parse('2026-09-16T12:00:00Z')
const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')

const HDD_MOUNTED = {
  body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } } },
}
const HDD_ABSENT = {
  body: { HddInfoList: { HddInfo: { number: 0, capacity: 0, mount: 0 } } },
}

/**
 * A camera whose storage read answers NO MOUNT — the SHAPE, not a device.
 *
 * 640 used to stand here: it was measured card-less on 2026-09-20 morning
 * (`HddInfo mount 0, capacity 0`) and was the fleet's only live `no-storage`
 * camera. The operator put a card in it the SAME DAY, so a spec naming 106 for
 * this state would pin a fact about the hardware that has already evaporated —
 * and this file has form: its "640" was also configured `isBattery: false`,
 * i.e. not 106 at all. A fake encodes the state under test; a real device id
 * inside one is a claim about a machine nobody re-measures.
 */
const CARDLESS_CAMERA = 9001

/** A standalone BATTERY camera — what 106 still is, card or no card. */
const BATTERY_CAMERA = 106

interface FakeFile {
  fileName: string
  id?: string
  startTime?: Date
  endTime?: Date
  sizeBytes?: number
  supportSub?: boolean
  recordType?: string
}

interface FakeEvent {
  uid: string
  logicChn: number
  hasRecFile: boolean
  alarmTypes: string[]
  startTime?: Date
  endTime?: Date
}

interface FakeAlarmWindow {
  fileName: string
  alarmTypes: string[]
  startTime?: Date
  endTime?: Date
}

interface FakeApiOptions {
  readonly hdd?: unknown
  readonly days?: readonly number[]
  readonly subs?: readonly FakeFile[]
  readonly mains?: readonly FakeFile[]
  readonly events?: readonly FakeEvent[]
  readonly alarms?: readonly FakeAlarmWindow[]
}

function fakeApi(options: FakeApiOptions = {}) {
  return {
    getHddInfoList: vi.fn(async () => options.hdd ?? HDD_MOUNTED),
    getDayRecords: vi.fn(async () => ({
      index: 0,
      channelId: 0,
      days: (options.days ?? [16]).map((day) => ({ day, type: 'normal' })),
    })),
    getVideoclips: vi.fn(
      async ({ streamType }: { streamType?: string }): Promise<readonly FakeFile[]> =>
        streamType === 'mainStream' ? (options.mains ?? []) : (options.subs ?? []),
    ),
    searchEventLog: vi.fn(async (): Promise<readonly FakeEvent[]> => options.events ?? []),
    searchAlarmVideos: vi.fn(
      async (_params: { streamType?: number }): Promise<readonly FakeAlarmWindow[]> =>
        options.alarms ?? [],
    ),
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

const subFile: FakeFile = {
  fileName: 'RecS02_a',
  id: '/mnt/sda/U10CHILD-Camera N/RecS02_a.mp4',
  startTime: new Date('2026-09-16T06:30:00Z'),
  endTime: new Date('2026-09-16T06:31:12Z'),
  sizeBytes: 92_000,
  supportSub: true,
  recordType: 'md,people',
}
const mainFile: FakeFile = {
  fileName: 'RecM02_a',
  id: '/mnt/sda/U10CHILD-Camera N/RecM02_a.mp4',
  startTime: new Date('2026-09-16T06:30:02Z'),
  endTime: new Date('2026-09-16T06:31:14Z'),
  sizeBytes: 3_000_000,
}

/**
 * A HUB CHILD's own files, and the point is `recordType: 'none'` — measured on
 * 3628 for every row of two separate days (`{"none": 20}`, `{"none": 28}`).
 * That is why the class has to be asked for there, and why a fake that copied
 * `subFile`'s `md,people` would have kept the label join green while the wire
 * said nothing at all.
 */
const hubSubFile: FakeFile = { ...subFile, recordType: 'none' }
const hubMainFile: FakeFile = { ...mainFile }

interface HarnessOptions {
  readonly device?: Partial<{
    channel: number
    uid: string | undefined
    isHubChild: boolean
    isBattery: boolean
    sleeping: boolean
    timeZone: string
  }>
  readonly api?: ReturnType<typeof fakeApi>
  readonly vouched?: ReadonlySet<string>
  readonly unknownDevice?: boolean
}

function harness(options: HarnessOptions = {}) {
  const api = options.api ?? fakeApi({ subs: [subFile], mains: [mainFile] })
  const logins = vi.fn()
  const logger = createRecordingLogger()
  const { infos, warns } = logger
  const deps: ReolinkVideoclipsDeps = {
    now: () => NOW,
    cache: new ClipCatalogCache<ReolinkClipRow>({ now: () => NOW }),
    resolveDevice: async (deviceId) =>
      options.unknownDevice === true
        ? null
        : {
            deviceId,
            channel: options.device?.channel ?? 0,
            uid: resolveCameraUid({
              metadataUid: 'uid' in (options.device ?? {}) ? options.device?.uid : 'U-CHILD',
              configUid: undefined,
            }),
            isHubChild: options.device?.isHubChild ?? false,
            isBattery: options.device?.isBattery ?? false,
            sleeping: options.device?.sleeping ?? false,
            timeZone: options.device?.timeZone ?? 'Europe/Rome',
            hostKey: '192.168.10.161',
            getApi: async () => {
              logins()
              return api
            },
          },
    hasVouchedThumbnail: async (_deviceId, clipKey) => options.vouched?.has(clipKey) ?? false,
    thumbnailMintUrl: (deviceId, clipKey) =>
      `/addon/provider-reolink/clip-thumb/${deviceId}/${clipKey}`,
    thumbnailUrl: (deviceId, clipKey) =>
      `/addon/provider-reolink/clip-thumb/${deviceId}/${clipKey}`,
    preparePlayback: async ({ profile }) => ({
      playbackUrl: '/addon/provider-reolink/clip/1/k.mp4',
      served: profile === 'high' ? 'high' : 'low',
    }),
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
  return {
    provider: createReolinkVideoclipsProvider(deps),
    api,
    logins,
    warns,
    infos,
    deps,
  }
}

// ── listSources ───────────────────────────────────────────────────────────

describe('listSources', () => {
  it('lists ONE source for a standalone camera', async () => {
    const { provider } = harness()
    const sources = await provider.listSources({ deviceId: 107 })
    expect(sources.map((s) => s.source)).toEqual([CLIP_SOURCE_ONBOARD])
    expect(sources[0]?.availability.state).toBe('ok')
  })

  it('lists ONE source for a hub child too — two views of one store is one source', async () => {
    // The operator collapsed the two rows once the measurement showed the
    // views cover each other. A second row would be a choice of API he has to
    // understand.
    const { provider } = harness({ device: { isHubChild: true, channel: 0 } })
    const sources = await provider.listSources({ deviceId: 3628 })
    expect(sources.map((s) => s.source)).toEqual([CLIP_SOURCE_ONBOARD])
  })

  it('names NO API on the row — both topologies read the same one', async () => {
    // `via` was the price of an invisible per-camera API choice: a source that
    // silently reads a different API on two cameras and then behaves
    // differently is the thing nobody can debug later. There is no choice
    // left to report, so the field is gone rather than left reporting one
    // constant — a constant field reads as a choice that still exists.
    const hubChild = harness({ device: { isHubChild: true } })
    expect((await hubChild.provider.listSources({ deviceId: 3628 }))[0]).not.toHaveProperty('via')

    const standalone = harness()
    expect((await standalone.provider.listSources({ deviceId: 107 }))[0]).not.toHaveProperty('via')
  })

  it('is OK on a sleeping hub child — the hub answers while the camera sleeps', async () => {
    const { provider } = harness({
      device: { isHubChild: true, isBattery: true, sleeping: true },
    })
    const row = (await provider.listSources({ deviceId: 3628 }))[0]
    // Never `sleeping`: the child's own sleep is irrelevant when its parent
    // holds the catalog (measured).
    expect(row?.availability.state).toBe('ok')
  })

  it('reports the hub refusal verbatim on the ONE row', async () => {
    // A source that cannot answer is a ROW with a reason, never an absence
    // (D554 4). The refusal that matters on a hub child is now the FILE
    // listing's, because that is the catalog there (D565).
    const api = fakeApi()
    api.getVideoclips.mockRejectedValue(new Error('Baichuan request failed (responseCode 400)'))
    const { provider } = harness({ device: { isHubChild: true }, api })
    // The listing refuses by name rather than answering `[]` — an empty list
    // from a hub that said 400 is the lie this line of work exists to end.
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 3628,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/responseCode 400/)
    const row = (await provider.listSources({ deviceId: 3628 }))[0]
    expect(row?.availability.state).toBe('unreachable')
    expect(row?.availability.reason).toContain('responseCode 400')
  })

  it('answers NOTHING for a camera that is not a Reolink', async () => {
    // A Hikvision camera asking this provider for its sources gets `[]` —
    // cheap and honest; it is not this provider's device.
    const { provider } = harness({ unknownDevice: true })
    expect(await provider.listSources({ deviceId: 101 })).toEqual([])
  })

  it('says NO-STORAGE for a camera whose card is not mounted', async () => {
    const { provider } = harness({ api: fakeApi({ hdd: HDD_ABSENT }) })
    const sources = await provider.listSources({ deviceId: CARDLESS_CAMERA })
    expect(sources[0]?.availability.state).toBe('no-storage')
  })

  it('says SLEEPING with an age for a standalone battery camera, and never logs in', async () => {
    const { provider, logins } = harness({
      device: { isBattery: true, sleeping: true },
    })
    const sources = await provider.listSources({ deviceId: BATTERY_CAMERA })
    expect(sources[0]?.availability.state).toBe('sleeping')
    expect(logins).not.toHaveBeenCalled()
  })

  it('reports index-empty when the calendar marks a day the index cannot list', async () => {
    // 618: the calendar marks 3-20 September and days 6-20 list zero files.
    const { provider } = harness({ api: fakeApi({ days: [16], subs: [] }) })
    await expect(
      provider.listClips({ provider: REOLINK_ADDON_ID, deviceId: 108, since: SINCE, until: UNTIL }),
    ).rejects.toThrow(/index-empty/)
    const sources = await provider.listSources({ deviceId: 108 })
    expect(sources[0]?.availability.state).toBe('index-empty')
    expect(sources[0]?.availability.reason).toContain('2026-09-16')
  })

  it('reports the camera refusal verbatim when the catalog read threw', async () => {
    const api = fakeApi()
    api.getDayRecords.mockRejectedValue(new Error('Baichuan request failed (responseCode 400)'))
    const { provider } = harness({ api })
    await provider
      .listClips({ provider: REOLINK_ADDON_ID, deviceId: 107, since: SINCE, until: UNTIL })
      .catch(() => {})
    const sources = await provider.listSources({ deviceId: 107 })
    expect(sources[0]?.availability.state).toBe('unreachable')
    expect(sources[0]?.availability.reason).toContain('responseCode 400')
  })
})

// ── listClips ─────────────────────────────────────────────────────────────

describe('listClips', () => {
  it('lists a standalone day with both twins on the row', async () => {
    const { provider } = harness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toHaveLength(1)
    const clip = clips[0]
    expect(clip?.source).toBe(CLIP_SOURCE_ONBOARD)
    expect(clip?.id.startsWith(`${CLIP_SOURCE_ONBOARD}:`)).toBe(true)
    expect(clip?.streams?.sub?.bytes).toBe(92_000)
    expect(clip?.streams?.main?.bytes).toBe(3_000_000)
    expect(clip?.supportSub).toBe(true)
  })

  it('maps the file recordType into the operator filter vocabulary', async () => {
    const { provider } = harness()
    const clip = (
      await provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 107,
        since: SINCE,
        until: UNTIL,
      })
    )[0]
    expect(clip?.labels).toEqual(['person'])
    expect(clip?.nativeTypes).toEqual(['md', 'people'])
  })

  it('never lists a day the CALENDAR did not name', async () => {
    const api = fakeApi({ days: [], subs: [subFile] })
    const { provider } = harness({ api })
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toEqual([])
    expect(api.getVideoclips).not.toHaveBeenCalled()
  })

  it('REFUSES by name, without logging in, for a sleeping battery camera with no cache', async () => {
    // It used to answer `[]`. A caller cannot tell that apart from a quiet
    // night, and the reason was already computed one line above it.
    const { provider, logins } = harness({
      device: { isBattery: true, sleeping: true },
    })
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: BATTERY_CAMERA,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/sleeping/)
    expect(logins).not.toHaveBeenCalled()
  })

  it('serves a sleeping camera its CACHED day, with catalogAsOf and a sleeping thumbnail reason', async () => {
    const { provider, deps, logins } = harness({
      device: { isBattery: true, sleeping: true },
    })
    deps.cache.put(
      BATTERY_CAMERA,
      '2026-09-16',
      [
        {
          clipKey: 'k1',
          channel: 0,
          startMs: Date.parse('2026-09-16T06:30:00Z'),
          endMs: Date.parse('2026-09-16T06:31:12Z'),
          subFileName: 'RecS02_a',
          supportSub: true,
          nativeTypes: ['people'],
        },
      ],
      { closed: true },
    )
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: BATTERY_CAMERA,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]?.catalogAsOf).toBe(NOW)
    expect(clips[0]?.thumbnailUnavailable?.reason).toBe('sleeping')
    expect(clips[0]?.thumbnailMint).toBeUndefined()
    expect(logins).not.toHaveBeenCalled()
  })

  it('vouches a thumbnail only when a JPEG is really on disk, and offers a mint otherwise', async () => {
    const withoutJpeg = harness()
    const clipA = (
      await withoutJpeg.provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 107,
        since: SINCE,
        until: UNTIL,
      })
    )[0]
    expect(clipA?.thumbnail).toBeUndefined()
    expect(clipA?.thumbnailMint).toContain('/clip-thumb/107/')

    const key = clipA?.thumbnailMint?.split('/').at(-1) ?? ''
    const withJpeg = harness({ vouched: new Set([key]) })
    const clipB = (
      await withJpeg.provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 107,
        since: SINCE,
        until: UNTIL,
      })
    )[0]
    expect(clipB?.thumbnail).toContain('/clip-thumb/107/')
    expect(clipB?.thumbnailMint).toBeUndefined()
  })

  // DELETED 2026-09-20 with `listClips`'s `sources?: string[]`: "honours the
  // source view filter without reading a camera nobody asked about". `listClips`
  // now names ONE provider, and a pin this provider does not serve is refused by
  // the router before it reaches here — pinned by
  // `server/backend/src/__tests__/cap-routers/videoclips-two-provider-dispatch.spec.ts`
  // § "listClips is asked of ONE provider". A filter left here would be a second
  // authority over the same choice.

  it('applies the limit to the NEWEST clips', async () => {
    const older = {
      ...subFile,
      fileName: 'older',
      id: 'older',
      startTime: new Date('2026-09-16T01:00:00Z'),
      endTime: new Date('2026-09-16T01:01:00Z'),
    }
    const { provider } = harness({ api: fakeApi({ subs: [subFile, older] }) })
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
      limit: 1,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]?.timeRange.startMs).toBe(Date.parse('2026-09-16T06:30:00Z'))
  })

  it('answers nothing for a device it does not own', async () => {
    const { provider } = harness({ unknownDevice: true })
    expect(
      await provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 101,
        since: SINCE,
        until: UNTIL,
      }),
    ).toEqual([])
  })

  it('tags every log line about a camera with its deviceId', async () => {
    const { provider, infos } = harness()
    await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(infos.length).toBeGreaterThan(0)
    for (const line of infos) {
      expect(line.extras.tags).toMatchObject({ deviceId: 107 })
    }
  })

  it('logs the dropped branch when it declines to reach a sleeping camera', async () => {
    const { provider, warns } = harness({
      device: { isBattery: true, sleeping: true },
    })
    await provider
      .listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: BATTERY_CAMERA,
        since: SINCE,
        until: UNTIL,
      })
      .catch(() => {})
    const dropped = warns.find((w) => JSON.stringify(w.extras).includes('sleeping'))
    expect(dropped).toBeDefined()
    expect(dropped?.extras.tags).toMatchObject({ deviceId: BATTERY_CAMERA })
  })

  it('a STANDALONE with no persisted uid still lists — the camera ignores the uid', async () => {
    // Measured on 592 (E1 Outdoor PoE, 2026-09-20): `getDayRecords` answered
    // the same 19 days with the right uid, with a WRONG uid and with none at
    // all, and the library resolves a standalone's own uid over cmd 114 when
    // it needs one. 592 has no `metadata.uid` persisted and never will — it is
    // a standalone, and nothing writes one. A gate that demands a uid before
    // addressing a standalone's catalog refuses a camera that would answer.
    const { provider, api } = harness({ device: { uid: undefined } })
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips.length).toBeGreaterThan(0)
    expect(api.getVideoclips).toHaveBeenCalled()
    const sources = await provider.listSources({ deviceId: 107 })
    expect(sources[0]?.availability.state).toBe('ok')
  })

  it('a STANDALONE with no persisted uid is OK before anything has been read', async () => {
    // The cheap-question path: nothing listed yet, so the availability comes
    // from what the camera IS. A standalone that needs no uid must not be
    // pre-emptively declared `unreachable`.
    const { provider } = harness({ device: { uid: undefined } })
    const sources = await provider.listSources({ deviceId: 107 })
    expect(sources[0]?.availability.state).toBe('ok')
    expect(JSON.stringify(sources)).not.toContain('uid-missing')
  })

  it('logs the dropped branch when a hub child has no uid', async () => {
    const { provider, warns, logins } = harness({
      device: { isHubChild: true, uid: undefined },
    })
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 3628,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/uid-missing/)
    expect(logins).not.toHaveBeenCalled()
    expect(JSON.stringify(warns)).toContain('uid-missing')
  })
})

// ── the events VIEW of the one source ─────────────────────────────────────

describe('ONE catalog path: the file list, on every topology', () => {
  /**
   * D549 19 made a hub child's catalog the EVENT list, on two grounds: it
   * measured faster (29 events in 293 ms against 20 files in 503 ms) and it
   * carried the class a hub child's own files do not (`recordType none`).
   *
   * Both grounds were re-measured on 2026-09-20 and neither survived:
   *
   * - **the speed is reversed.** 3628, day 16: `searchEventLog` **950 ms**
   *   against `FileInfoList` sub **137 ms** + main 218 ms. Day 9: **678 ms**
   *   against 514 + 242 ms.
   * - **the class has a cheaper home.** `searchAlarmVideos` answered the same
   *   child in **247–306 ms** and joins to the day's files by their start
   *   stamp, so the file list carries the class too.
   *
   * What remains is the grain. An event window is not playable on its own —
   * it must be joined to the file that contains it to know what to download,
   * and that join is neither free nor total (28 of 29 on 3628 day 16; the
   * 29th needed `playable: false, no-file-for-window`, a row that existed
   * only because the grain was wrong). A file IS a clip: it has a start, an
   * end, bytes, and it plays.
   */
  const hubHarness = () =>
    harness({
      device: { isHubChild: true },
      api: fakeApi({ subs: [hubSubFile], mains: [hubMainFile], alarms: [] }),
    })

  it('lists a HUB CHILD from its FILE list, and never asks the event log', async () => {
    const { provider, api } = hubHarness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]?.source).toBe(CLIP_SOURCE_ONBOARD)
    expect(api.getVideoclips).toHaveBeenCalled()
    expect(api.searchEventLog).not.toHaveBeenCalled()
  })

  it('lists a STANDALONE from its file list too — one grain, one way to be wrong', async () => {
    const { provider, api } = harness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toHaveLength(1)
    expect(api.searchEventLog).not.toHaveBeenCalled()
    expect(api.getVideoclips).toHaveBeenCalled()
  })

  it('gives a hub child ONE row per recording, with both twins on it', async () => {
    // The events view gave 1–13 rows per file and no `streams` at all, so a
    // hub child had no `high` copy to play. Measured 3628 day 16: 29 events
    // against 20 files, and 22 main files to twin them with.
    const { provider } = hubHarness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips[0]?.streams?.sub?.id).toBeDefined()
    expect(clips[0]?.streams?.main?.id).toBeDefined()
    expect(clips[0]?.playable).toBeUndefined()
  })

  it('classes a hub child from its ALARM windows, joined by the file start stamp', async () => {
    // A hub child's own files are `recordType none` on every row (measured
    // `{"none": 20}` and `{"none": 28}`), so the class comes from
    // `findAlarmVideo`. The short name is `01` + YYYYMMDDHHMMSS of the file's
    // start in the CAMERA's wall clock — 06:30:00Z is 08:30:00 Rome.
    const api = fakeApi({
      subs: [hubSubFile],
      mains: [hubMainFile],
      alarms: [{ fileName: '0120260916083000', alarmTypes: ['md', 'dog_cat'] }],
    })
    const { provider } = harness({ device: { isHubChild: true }, api })
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips[0]?.nativeTypes).toEqual(['md', 'dog_cat'])
    expect(clips[0]?.labels).toEqual(['animal'])
  })

  it('never pays for alarm windows on a camera whose files already carry a class', async () => {
    // 592's files carry `md,people`; its alarm search costs 8.2–9.5 s for
    // 1 271 windows to restate them. The cheap question comes first (D54),
    // and the gate is what the DAY said, never what the camera IS.
    const { provider, api } = harness()
    await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    expect(api.searchAlarmVideos).not.toHaveBeenCalled()
  })

  it('asks for alarm windows ONCE per day, for the SUB file set', async () => {
    const api = fakeApi({ subs: [hubSubFile], mains: [hubMainFile], alarms: [] })
    const { provider } = harness({ device: { isHubChild: true }, api })
    await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    expect(api.searchAlarmVideos).toHaveBeenCalledTimes(1)
    // NUMERIC, and not `getVideoclips`'s `subStream` string. Two different
    // things with one name.
    expect(api.searchAlarmVideos.mock.calls[0]?.[0]?.streamType).toBe(1)
  })

  it('keeps the day when the ALARM search refuses, and names the refusal', async () => {
    // A label is an upgrade. Losing it must not lose the recordings, which is
    // the same rule the MAIN search already lives by.
    const api = fakeApi({ subs: [hubSubFile], mains: [hubMainFile], alarms: [] })
    api.searchAlarmVideos.mockRejectedValue(new Error('alarm search refused'))
    const { provider, warns } = harness({ device: { isHubChild: true }, api })
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    expect(clips).toHaveLength(1)
    // Honestly UNLABELLED — the raw `none` the file carried, not a class
    // invented to fill the gap and not a row lost with its label.
    expect(clips[0]?.nativeTypes).toEqual(['none'])
    expect(clips[0]?.labels).toBeUndefined()
    const line = warns.find((l) => l.message.includes('label'))
    expect(line?.extras.tags).toMatchObject({ deviceId: 3628 })
    expect(line?.extras.meta).toMatchObject({ error: 'alarm search refused' })
  })

  it('says NOTHING about an API choice on the listing line — there is only one', async () => {
    // `via` existed so the operator could read which API answered when two
    // cameras behaved differently. With one path it has nothing to say, and a
    // field whose only value is constant reads as a choice that still exists.
    const { provider, infos } = hubHarness()
    await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    const listed = infos.find((l) => l.message.includes('listed a Reolink catalog'))
    expect(listed?.extras.meta).not.toHaveProperty('via')
    const sources = await provider.listSources({ deviceId: 3628 })
    expect(sources[0]).not.toHaveProperty('via')
  })

  it('reports the camera refusal verbatim when the FILE list refuses on a hub child', async () => {
    // The chosen view is the catalog and it does not fall back — there is no
    // longer anything to fall back TO, which is the point.
    const api = fakeApi({ subs: [hubSubFile], mains: [hubMainFile] })
    api.getVideoclips.mockRejectedValue(new Error('hub refused'))
    const { provider } = harness({ device: { isHubChild: true }, api })
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 3628,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/hub refused/)
    const row = (await provider.listSources({ deviceId: 3628 }))[0]
    expect(row?.availability.state).toBe('unreachable')
    expect(row?.availability.reason).toContain('hub refused')
  })
})

// ── one session ───────────────────────────────────────────────────────────

describe('one socket to the hub', () => {
  it('resolves every hub-child call to the api object the parent handed out', async () => {
    const api = fakeApi({ subs: [subFile] })
    const { provider } = harness({ device: { isHubChild: true }, api })
    await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 3628,
      since: SINCE,
      until: UNTIL,
    })
    // Same OBJECT, not merely a working one: a second session to this hub is
    // refused, so the clip path must never construct one (D549 17).
    expect(api.getVideoclips.mock.instances.length).toBeGreaterThan(0)
    expect(api.getDayRecords).toHaveBeenCalled()
  })
})

// ── getClipPlayback ───────────────────────────────────────────────────────

describe('getClipPlayback', () => {
  it('serves an mp4 and says which twin it served', async () => {
    const { provider } = harness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    const playback = await provider.getClipPlayback({
      deviceId: 107,
      clipId: clips[0]?.id ?? '',
      profile: 'high',
    })
    expect(playback.format).toBe('mp4')
    expect(playback.served).toBe('high')
  })

  it('serves the SUB twin for low and mid', async () => {
    const { provider } = harness()
    const clips = await provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    const playback = await provider.getClipPlayback({
      deviceId: 107,
      clipId: clips[0]?.id ?? '',
      profile: 'mid',
    })
    expect(playback.served).toBe('low')
  })

  it('refuses an id this provider did not mint, naming it', async () => {
    const { provider } = harness()
    await expect(
      provider.getClipPlayback({ deviceId: 107, clipId: 'analytics:1:2:evt' }),
    ).rejects.toThrow(/analytics:1:2:evt/)
  })

  it('refuses playback on a sleeping standalone battery camera with a named reason', async () => {
    const { provider, logins } = harness({
      device: { isBattery: true, sleeping: true },
    })
    await expect(
      provider.getClipPlayback({
        deviceId: BATTERY_CAMERA,
        clipId: `${CLIP_SOURCE_ONBOARD}:0:${Buffer.from('RecS02_a').toString('base64url')}`,
      }),
    ).rejects.toThrow(/sleeping/)
    expect(logins).not.toHaveBeenCalled()
  })
})

// ── the honest state, COLD ────────────────────────────────────────────────

/**
 * What every other test in this file missed.
 *
 * Each spec that pins an honest state above calls `listClips` FIRST and reads
 * `listSources` afterwards, so it pins the state as a BY-PRODUCT of a listing,
 * in a warm process, out of the in-memory `health` map. No spec asked
 * `listSources` the way a surface does — first, cold, before anything has been
 * listed — and cold was the whole answer: on the live hub, minutes after the
 * deploy that made every runner cold, 640 (measured card-less that morning;
 * the operator added a card later the same day) and 618 (its own index lists
 * nothing for days its own calendar marks) both answered `ok` and then an
 * empty list. `ok` was a DEFAULT, never a measurement.
 */
describe('listSources answers COLD, before anything has been listed', () => {
  it('reports index-empty on a camera whose own index will not list a day its calendar marks', async () => {
    // 618: the calendar marks the day, `getVideoclips` answers zero files on
    // both streams, and the card has 177 GB free. Nothing has been listed yet
    // — this is the first call a surface makes.
    const { provider } = harness({
      api: fakeApi({ days: [16], subs: [], mains: [] }),
    })
    const row = (await provider.listSources({ deviceId: 108 }))[0]
    expect(row?.availability.state).toBe('index-empty')
    expect(row?.availability.reason).toContain('2026-09-16')
  })

  it('never claims ok from a storage read that FAILED', async () => {
    // D393: a measurement that failed is not a measurement. `getHddInfoList`
    // racing the socket on the first command after login is MEASURED on this
    // fleet (592, 2026-09-20), and folding it into "the card is fine" is how a
    // camera with no card answers `ok`.
    const api = fakeApi()
    api.getHddInfoList.mockRejectedValue(new Error('Baichuan socket closed'))
    const { provider } = harness({ api })
    const row = (await provider.listSources({ deviceId: 107 }))[0]
    expect(row?.availability.state).toBe('unreachable')
    expect(row?.availability.reason).toContain('Baichuan socket closed')
  })

  it('never logs into a standalone battery camera, even when the sleep belief says AWAKE', async () => {
    // `ReolinkCamera.sleeping` is `state.battery.sleeping ?? false`, so a slice
    // that has not restored reads as awake. A `listSources` that probes on that
    // belief is a WAKE, and on 640 it is also how `ok` was produced. The gate
    // is what the camera IS, never what is believed about it.
    const { provider, logins } = harness({
      device: { isBattery: true, sleeping: false },
    })
    const row = (await provider.listSources({ deviceId: BATTERY_CAMERA }))[0]
    expect(logins).not.toHaveBeenCalled()
    expect(row?.availability.state).not.toBe('ok')
  })

  it('says no-storage for a camera whose card is not mounted, cold', async () => {
    const { provider } = harness({ api: fakeApi({ hdd: HDD_ABSENT }) })
    const row = (await provider.listSources({ deviceId: 108 }))[0]
    expect(row?.availability.state).toBe('no-storage')
  })

  it('still says ok when its own probe LISTED something', async () => {
    // The other direction: a camera that answers must not be declared broken.
    const { provider } = harness()
    const row = (await provider.listSources({ deviceId: 107 }))[0]
    expect(row?.availability.state).toBe('ok')
    expect(row?.availability.catalogAsOf).toBe(NOW)
  })
})

// ── an empty list is never an ordinary empty day unless it IS one ─────────

describe('listClips refuses by name rather than answering an empty list', () => {
  it('refuses, naming no-storage, for a camera that stores nothing', async () => {
    const { provider } = harness({ api: fakeApi({ hdd: HDD_ABSENT }) })
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: CARDLESS_CAMERA,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/no-storage/)
  })

  it('refuses, naming index-empty and the days, when the index contradicts the calendar', async () => {
    const { provider } = harness({
      api: fakeApi({ days: [16], subs: [], mains: [] }),
    })
    await expect(
      provider.listClips({ provider: REOLINK_ADDON_ID, deviceId: 108, since: SINCE, until: UNTIL }),
    ).rejects.toThrow(/index-empty[\s\S]*2026-09-16/)
  })

  it('refuses, naming sleeping, for a battery camera with nothing cached', async () => {
    const { provider, logins } = harness({
      device: { isBattery: true, sleeping: true },
    })
    await expect(
      provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: BATTERY_CAMERA,
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow(/sleeping/)
    expect(logins).not.toHaveBeenCalled()
  })

  it('answers an ORDINARY empty day with an empty list, not a refusal', async () => {
    // The camera's own calendar names no day in the window. Nothing is wrong
    // and nothing is being hidden — an empty list is the honest answer, and
    // over-refusing here would be the same defect with the polarity reversed.
    const { provider } = harness({ api: fakeApi({ days: [], subs: [] }) })
    expect(
      await provider.listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: 107,
        since: SINCE,
        until: UNTIL,
      }),
    ).toEqual([])
  })

  it('says so on a log line when it refuses, tagged per camera', async () => {
    const { provider, warns } = harness({ api: fakeApi({ hdd: HDD_ABSENT }) })
    await provider
      .listClips({
        provider: REOLINK_ADDON_ID,
        deviceId: CARDLESS_CAMERA,
        since: SINCE,
        until: UNTIL,
      })
      .catch(() => {})
    const line = warns.find((w) => JSON.stringify(w.extras).includes('refused-empty'))
    expect(line).toBeDefined()
    expect(line?.extras.tags).toMatchObject({ deviceId: CARDLESS_CAMERA })
  })
})

/**
 * `Clip.inProgress` reaches the ROW (D563).
 *
 * The schema had it, the tile drew `Recording…` from it and the catalog
 * measured it, and `toClip` copied everything BUT it — so the newest row, the
 * one the operator looks at first, kept reporting the frozen 29 s D563
 * measured on 592 (`…_192927_000000_…`, read `17:29:27 → 17:29:56` at
 * 17:37:06, 17:37:35 and 17:44:39Z for a recording fifteen minutes long).
 *
 * `toClip` is the only site left — `toEventClip` went with the event path
 * (D565) — so this is the whole wire.
 */
describe('a clip still being written is NOT listed', () => {
  /**
   * This block asserted the opposite: that an open row reaches the wire with
   * `inProgress: true` so the tile could draw "Recording…". The operator
   * settled it on 2026-09-22 — *"Niente clips in preparazione, non ha senso
   * visualizzarle"* — and four separate places had been bending around such a
   * row: a frozen `endMs` (D563), a byte read that refuses it by name, a loop
   * that cannot run, and a player route that would cache a truncated copy
   * under an immutable key. Not listing it deletes all four questions, and the
   * clip appears whole on the next listing after the camera closes the file.
   */
  const OPEN_SUB: FakeFile = {
    ...subFile,
    fileName: 'RecS03_DST20260916_063000_000000_2B1E808_0.mp4',
    id: '/mnt/sda/Mp4Record/2026-09-16/RecS03_DST20260916_063000_000000_2B1E808_0.mp4',
    sizeBytes: 0,
  }

  const listOf = async (subs: readonly FakeFile[]) => {
    const { provider } = harness({ api: fakeApi({ subs, mains: [] }) })
    return provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
  }

  it('drops the open row from the answer', async () => {
    expect(await listOf([OPEN_SUB])).toEqual([])
  })

  it('keeps the CLOSED rows of the same day — only the open one goes', async () => {
    const listed = await listOf([subFile, OPEN_SUB])
    expect(listed).toHaveLength(1)
    expect(listed[0]?.inProgress).toBeUndefined()
  })

  it('never puts `inProgress` on the wire any more', async () => {
    for (const row of await listOf([subFile, OPEN_SUB])) {
      expect(row.inProgress).toBeUndefined()
      expect('inProgress' in row).toBe(false)
    }
  })
})
