/**
 * The cap surface: what a camera's clips look like, and what every refusal is
 * called.
 */

import type { ClipSourceAvailability, IScopedLogger } from '@camstack/types'

import { clipExportFailure, VIDEOCLIPS_MAX_READ_BYTES } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { HikvisionClipRow } from '../clip-catalog.js'
import { CLIP_SOURCE_ONBOARD, clipKeyFor, mintClipId, parseClipId } from '../clip-identity.js'
import { chooseClipQuality } from '../clip-twins.js'
import {
  type ClipDeviceRef,
  createHikvisionVideoclipsProvider,
  type HikvisionVideoclipsDeps,
} from '../hikvision-videoclips-provider.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

const DEVICE: ClipDeviceRef = {
  deviceId: 3833,
  trackId: 101,
  host: '203.0.113.1',
  username: 'u',
  password: 'p',
}

function row(startMs: number, fileName: string, sizeBytes?: number): HikvisionClipRow {
  return {
    clipKey: clipKeyFor(101, fileName),
    trackId: 101,
    fileName,
    startMs,
    endMs: startMs + 19_000,
    playbackPath: `/Streaming/tracks/101/?starttime=x&endtime=y&name=${fileName}`,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    recordTypes: ['motion'],
  }
}

interface Harness {
  readonly provider: ReturnType<typeof createHikvisionVideoclipsProvider>
  readonly dials: { deviceId: number; clipKey: string; audio: string }[]
  readonly reads: { clipKey: string; maxBytes: number }[]
  readonly offers: { clipKey: string; maxBytes: number }[]
}

function harness(overrides: Partial<HikvisionVideoclipsDeps> = {}): Harness {
  const dials: { deviceId: number; clipKey: string; audio: string }[] = []
  const reads: { clipKey: string; maxBytes: number }[] = []
  const offers: { clipKey: string; maxBytes: number }[] = []
  const provider = createHikvisionVideoclipsProvider({
    now: () => 1_790_000_000_000,
    logger,
    resolveDevice: async (deviceId) => (deviceId === DEVICE.deviceId ? DEVICE : null),
    probeAvailability: async () => ({ state: 'ok', catalogAsOf: 1 }),
    readCatalog: async () => ({ kind: 'ok', rows: [] }),
    playbackUrl: (deviceId, clipKey) =>
      `/addon/provider-hikvision/clip/${String(deviceId)}/${clipKey}.mp4`,
    hasVouchedStill: async () => false,
    stillUrl: (deviceId, clipKey) =>
      `/addon/provider-hikvision/clip-thumb/${String(deviceId)}/${clipKey}`,
    prepareBytes: async ({ row: given, maxBytes }) => {
      reads.push({ clipKey: given.clipKey, maxBytes })
      return { kind: 'ok', bytes: Buffer.from('mp4'), durationMs: 19_000 }
    },
    prepareOffer: async ({ row: given, maxBytes }) => {
      offers.push({ clipKey: given.clipKey, maxBytes })
      return {
        kind: 'ok',
        ticket: {
          url: 'http://127.0.0.1:1/offer-token',
          hostNodeId: 'hub',
          expiresAtMs: 1_790_000_030_000,
          declaredBytes: 3,
        },
        durationMs: 19_000,
        bytes: 3,
      }
    },
    prepareStreamDial: async ({ device, row: given, audio }) => {
      dials.push({ deviceId: device.deviceId, clipKey: given.clipKey, audio })
      return { kind: 'ok', url: 'http://127.0.0.1:1/token', expiresAtMs: 42 }
    },
    ...overrides,
  })
  return { provider, dials, reads, offers }
}

describe('listSources', () => {
  it('answers [] for a device this addon does not own', async () => {
    const { provider } = harness()
    expect(await provider.listSources({ deviceId: 1 })).toEqual([])
  })

  it('names the addon that serves the row, and carries the probed state', async () => {
    const availability: ClipSourceAvailability = {
      state: 'no-storage',
      reason: 'The camera reports no storage device (empty hddList).',
    }
    const { provider } = harness({ probeAvailability: async () => availability })
    const sources = await provider.listSources({ deviceId: 3833 })
    expect(sources).toEqual([
      {
        source: CLIP_SOURCE_ONBOARD,
        addonId: 'provider-hikvision',
        label: 'Camera storage',
        availability,
      },
    ])
  })
})

describe('listClips', () => {
  it('narrows to the window it was asked for, newest first', async () => {
    const rows = [row(1_000, 'a'), row(50_000, 'b'), row(500_000, 'c')]
    const { provider } = harness({ readCatalog: async () => ({ kind: 'ok', rows }) })
    const clips = await provider.listClips({
      deviceId: 3833,
      since: 40_000,
      until: 100_000,
      provider: 'provider-hikvision',
    })
    // `a` ended at 20 000 and `c` starts at 500 000: neither overlaps.
    expect(clips.map((clip) => clip.timeRange.startMs)).toEqual([50_000])
    expect(clips[0]?.source).toBe(CLIP_SOURCE_ONBOARD)
  })

  it('keeps a clip that STRADDLES the edge of the window', async () => {
    // Overlap, not containment: the operator asking for 15:00 wants the clip
    // that started at 14:59 and was still recording at 15:00.
    const { provider } = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(35_000, 'edge')] }),
    })
    const clips = await provider.listClips({
      deviceId: 3833,
      since: 40_000,
      until: 100_000,
      provider: 'provider-hikvision',
    })
    expect(clips).toHaveLength(1)
  })

  it('REFUSES rather than answering [] when the source could not answer', async () => {
    // An empty list is an answer only when the source could answer. "This
    // camera has no recordings" is the one sentence this line of work exists
    // to stop a surface from having to guess at.
    const { provider } = harness({
      readCatalog: async () => ({
        kind: 'refused',
        availability: { state: 'no-storage', reason: 'no card' },
      }),
    })
    await expect(
      provider.listClips({
        deviceId: 3833,
        since: 0,
        until: 1,
        provider: 'provider-hikvision',
      }),
    ).rejects.toThrow(/no-storage/)
  })

  it('OFFERS a still it has not got, and VOUCHES for one it has — never both', async () => {
    // The offer is honoured by cutting a frame from the clip's own archived
    // copy, which this provider already fetches once for the player and the
    // export (D558) — so an offer costs at most the fetch the operator's next
    // tap would have paid anyway. It used to say `unsupported`, which was true
    // of the camera's ISAPI and false of this provider.
    const listed = async (has: boolean) =>
      (
        await harness({
          readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'b')] }),
          hasVouchedStill: async () => has,
        }).provider.listClips({
          deviceId: 3833,
          since: 0,
          until: 1_000_000,
          provider: 'provider-hikvision',
        })
      )[0]

    const offered = await listed(false)
    expect(offered?.thumbnail).toBeUndefined()
    expect(offered?.thumbnailMint).toContain('/clip-thumb/3833/')
    // Absence is never ASSERTED before anybody asked: `thumbnailUnavailable`
    // would tell the surface not to try (D315).
    expect(offered?.thumbnailUnavailable).toBeUndefined()

    const vouched = await listed(true)
    expect(vouched?.thumbnail).toContain('/clip-thumb/3833/')
    expect(vouched?.thumbnailMint).toBeUndefined()
    expect(vouched?.thumbnailUnavailable).toBeUndefined()
  })

  it('lists the ONE archived copy as the MAIN one, and no sub', async () => {
    const { provider } = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'b', 11_600_000)] }),
    })
    const clip = (
      await provider.listClips({
        deviceId: 3833,
        since: 0,
        until: 1_000_000,
        provider: 'provider-hikvision',
      })
    )[0]
    // A `sub` entry that is really the main file is the 33x lie D576 forbids,
    // stated as data.
    expect(clip?.streams?.sub).toBeUndefined()
    expect(clip?.streams?.main?.bytes).toBe(11_600_000)
    expect(clip?.supportSub).toBe(false)
  })

  it('carries the camera’s own record types unmapped', async () => {
    const { provider } = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'b')] }),
    })
    const clip = (
      await provider.listClips({
        deviceId: 3833,
        since: 0,
        until: 1_000_000,
        provider: 'provider-hikvision',
      })
    )[0]
    expect(clip?.nativeTypes).toEqual(['motion'])
    expect(clip?.kind).toBe('motion')
  })
})

describe('chooseClipQuality', () => {
  it('serves the main copy for every ask, and flags the cheap ones as upgrades', () => {
    expect(chooseClipQuality('high')).toEqual({ twin: 'main', served: 'high', upgraded: false })
    expect(chooseClipQuality('mid')).toEqual({ twin: 'main', served: 'high', upgraded: true })
    expect(chooseClipQuality('low')).toEqual({ twin: 'main', served: 'high', upgraded: true })
    // An absent profile stated no ask, and D382's rule is that an unstated ask
    // is zero — there is nothing for the line to be about.
    expect(chooseClipQuality(undefined)).toEqual({
      twin: 'main',
      served: 'high',
      upgraded: false,
    })
  })
})

describe('the clip id', () => {
  it('round-trips, and refuses an id another source minted', () => {
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'ch01_0001' })
    expect(parseClipId(id)).toEqual({
      source: CLIP_SOURCE_ONBOARD,
      trackId: 101,
      fileName: 'ch01_0001',
    })
    expect(parseClipId('native:reolink:onboard:0:abcd')).toBeNull()
    expect(parseClipId('analytics:500:2500:m1')).toBeNull()
  })
})

describe('getClipPlayback', () => {
  it('points at the addon’s own media plane and states what it serves', async () => {
    const { provider } = harness()
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'ch01_0001' })
    const playback = await provider.getClipPlayback({ deviceId: 3833, clipId: id, profile: 'low' })
    expect(playback.format).toBe('mp4')
    // A `low` ask answered with the 4K copy — stated, because it is the only
    // copy and the cost is real.
    expect(playback.served).toBe('high')
    expect(playback.playbackUrl).toBe(
      `/addon/provider-hikvision/clip/3833/${clipKeyFor(101, 'ch01_0001')}.mp4`,
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('archives only the main copy'),
      expect.objectContaining({ tags: { deviceId: 3833 } }),
    )
  })

  it('refuses an id it did not mint', async () => {
    const { provider } = harness()
    await expect(
      provider.getClipPlayback({ deviceId: 3833, clipId: 'analytics:1:2:m' }),
    ).rejects.toThrow(/was not minted by the Hikvision provider/)
  })
})

describe('readClipBytes', () => {
  async function listed(sizeBytes?: number): Promise<{ provider: Harness; id: string }> {
    const built = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'ch01_0001', sizeBytes)] }),
    })
    await built.provider.listClips({
      deviceId: 3833,
      since: 0,
      until: 1_000_000,
      provider: 'provider-hikvision',
    })
    return {
      provider: built,
      id: mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'ch01_0001' }),
    }
  }

  it('answers `catalog-miss` for a clip this node never listed', async () => {
    const { provider } = harness()
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'never' })
    await expect(
      provider.readClipBytes?.({ deviceId: 3833, clipId: id, provider: 'provider-hikvision' }),
    ).rejects.toThrow(clipExportFailure('catalog-miss', 'clip "'))
  })

  it('refuses an over-size clip from the CATALOG, before the camera is touched', async () => {
    const { provider, id } = await listed(VIDEOCLIPS_MAX_READ_BYTES + 1)
    await expect(
      provider.provider.readClipBytes?.({
        deviceId: 3833,
        clipId: id,
        provider: 'provider-hikvision',
      }),
    ).rejects.toThrow(/too-large-to-transfer/)
    // The cheap question comes first: no session, no transfer, no mux (D54).
    expect(provider.reads).toEqual([])
  })

  it('serves the bytes, the measured duration and what was really served', async () => {
    const { provider, id } = await listed(1_000)
    const bytes = await provider.provider.readClipBytes?.({
      deviceId: 3833,
      clipId: id,
      provider: 'provider-hikvision',
      profile: 'low',
    })
    expect(bytes?.served).toBe('high')
    expect(bytes?.durationMs).toBe(19_000)
    expect(bytes?.contentType).toBe('video/mp4')
    expect(bytes?.name).toContain('ch01_0001.mp4')
    expect(provider.reads[0]?.maxBytes).toBe(VIDEOCLIPS_MAX_READ_BYTES)
  })

  it('caps the caller’s own bound by the ceiling', async () => {
    const { provider, id } = await listed(1_000)
    await provider.provider.readClipBytes?.({
      deviceId: 3833,
      clipId: id,
      provider: 'provider-hikvision',
      maxBytes: VIDEOCLIPS_MAX_READ_BYTES * 10,
    })
    expect(provider.reads[0]?.maxBytes).toBe(VIDEOCLIPS_MAX_READ_BYTES)
  })
})

describe('dialClipStream', () => {
  async function listed(): Promise<{ built: Harness; id: string }> {
    const built = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'ch01_0001')] }),
    })
    await built.provider.listClips({
      deviceId: 3833,
      since: 0,
      until: 1_000_000,
      provider: 'provider-hikvision',
    })
    return {
      built,
      id: mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'ch01_0001' }),
    }
  }

  it('states the transport, the twin it serves and the codec it promises', async () => {
    const { built, id } = await listed()
    const dial = await built.provider.dialClipStream?.({
      deviceId: 3833,
      clipId: id,
      provider: 'provider-hikvision',
      profile: 'low',
      audio: 'pcmu',
    })
    expect(dial).toEqual({
      url: 'http://127.0.0.1:1/token',
      expiresAtMs: 42,
      transport: 'forward-only',
      served: 'high',
      servedAudio: 'pcmu',
    })
    expect(built.dials).toEqual([
      { deviceId: 3833, clipKey: clipKeyFor(101, 'ch01_0001'), audio: 'pcmu' },
    ])
  })

  it('reads an absent audio ask as `none`, and says why it is silent', async () => {
    // D382: an unstated ask is zero. A broker older than the field keeps the
    // video-only stream it had.
    const { built, id } = await listed()
    const dial = await built.provider.dialClipStream?.({
      deviceId: 3833,
      clipId: id,
      provider: 'provider-hikvision',
    })
    expect(dial?.servedAudio).toBe('none')
    expect(dial?.audioReason).toBe('not-requested')
    expect(built.dials[0]?.audio).toBe('none')
  })

  it('refuses a clip nobody listed, by name, without minting a URL', async () => {
    const built = harness()
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'never' })
    await expect(
      built.provider.dialClipStream?.({
        deviceId: 3833,
        clipId: id,
        provider: 'provider-hikvision',
      }),
    ).rejects.toThrow(/catalog-miss/)
    expect(built.dials).toEqual([])
  })

  it('carries the producer’s refusal in the clip vocabulary', async () => {
    const built = harness({
      readCatalog: async () => ({ kind: 'ok', rows: [row(50_000, 'ch01_0001')] }),
      prepareStreamDial: async () => ({
        kind: 'refused',
        code: 'camera-refused',
        detail: 'SETUP of the video track answered 500',
      }),
    })
    await built.provider.listClips({
      deviceId: 3833,
      since: 0,
      until: 1_000_000,
      provider: 'provider-hikvision',
    })
    const id = mintClipId({ source: CLIP_SOURCE_ONBOARD, trackId: 101, fileName: 'ch01_0001' })
    await expect(
      built.provider.dialClipStream?.({
        deviceId: 3833,
        clipId: id,
        provider: 'provider-hikvision',
      }),
    ).rejects.toThrow(/camera-refused/)
  })
})

describe('the playback options this provider declares', () => {
  it('caps the rate ladder at realtime, because the replay ARRIVES at realtime', async () => {
    // Measured on 1436, 2026-09-23: 176 access units in 14 274 ms at 12.5 fps
    // — 14.08 s of media in 14.27 s of wall clock, 1.01×. The broker's pacer
    // consumes `rate` seconds of media per second while the socket supplies
    // one, so 2× and 4× drain a buffer that never held the rest of the clip:
    // the picture stops and the provider's drain gate reports `peer-stalled`.
    // The honest fix is the DECLARATION, not a pacer that promises (D612).
    const built = harness({})
    const options = await built.provider.getPlaybackOptions?.({
      deviceId: 3833,
      provider: 'provider-hikvision',
    })
    expect(options?.transport).toBe('stream')
    expect(options?.seek).toBe('forward')
    expect(options?.rates).toContain(1)
    expect(Math.max(...(options?.rates ?? [0]))).toBe(1)
  })
})
