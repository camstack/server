/**
 * The provider surface: what a SOURCE says about itself, what an empty window
 * means, and what `served` answers.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CamProfile, ClipSourceAvailability, IScopedLogger } from '@camstack/types'
import { CLIP_PLAYBACK_OPTIONS, VIDEOCLIPS_MAX_OFFER_BYTES } from '@camstack/types'

import { AMCREST_ADDON_ID } from '../../schema.js'
import {
  clipFileLabel,
  createAmcrestVideoclipsProvider,
  type AmcrestVideoclipsDeps,
  type PrepareStreamDialOutcome,
  type ReadCatalogOutcome,
} from '../amcrest-videoclips-provider.js'
import { CLIP_SOURCE_ONBOARD, mintClipId, parseClipId } from '../clip-identity.js'
import type { AmcrestClipRow } from '../clip-search.js'

const DEVICE_ID = 3836

/**
 * A logger fake. The cast is the documented type boundary a test double needs:
 * `IScopedLogger` carries `child`/`withTags` that return itself, which no
 * object literal can express before it exists.
 */
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
  const startMs = Date.UTC(2026, 8, 23, 8, 23, 27)
  const endMs = Date.UTC(2026, 8, 23, 8, 24, 41)
  return {
    clipKey: `${String(startMs / 1000)}-${String(endMs / 1000)}`,
    startMs,
    endMs,
    windowMs: 74_000,
    sizeBytes: 56_242_806,
    filePath: '/mnt/sd/2026-09-23/001/dav/10/10.23.27-10.24.41[M][0@0][0].mp4',
    events: ['VideoMotion'],
    flags: ['Event'],
    channel: 0,
    ...overrides,
  }
}

interface Harness {
  readonly provider: ReturnType<typeof createAmcrestVideoclipsProvider>
  readonly logger: IScopedLogger
  readonly offers: { maxBytes: number }[]
  /** Every stream dial the provider prepared, so a test can see that the
   *  CAMERA was never reached for a clip nobody listed. */
  readonly dials: { clipKey: string; audio: string }[]
}

function harness(options: {
  readonly availability?: ClipSourceAvailability
  readonly catalog?: ReadCatalogOutcome
  readonly known?: boolean
  readonly dial?: PrepareStreamDialOutcome
  /** Whether a JPEG is really on disk for this clip. */
  readonly vouchedStill?: boolean
  /** Every clipKey the vouch was asked about, in order. */
  readonly vouched?: string[]
}): Harness {
  const logger = makeLogger()
  const offers: { maxBytes: number }[] = []
  const dials: { clipKey: string; audio: string }[] = []
  const deps: AmcrestVideoclipsDeps = {
    now: (): number => 1_700_000_000_000,
    logger,
    resolveDevice: async (deviceId) =>
      options.known === false ? null : { deviceId, findChannel: 0 },
    probeAvailability: async () => options.availability ?? { state: 'ok' },
    readCatalog: async () => options.catalog ?? { kind: 'ok', rows: [makeRow()] },
    playbackUrl: (deviceId, clipKey) =>
      `/addon/${AMCREST_ADDON_ID}/clip/${String(deviceId)}/${clipKey}.mp4`,
    hasVouchedStill: async (_deviceId, clipKey) => {
      options.vouched?.push(clipKey)
      return options.vouchedStill === true
    },
    stillUrl: (deviceId, clipKey) =>
      `/addon/${AMCREST_ADDON_ID}/clip-thumb/${String(deviceId)}/${clipKey}`,
    prepareBytes: async () => ({
      kind: 'ok',
      bytes: Buffer.from('mp4'),
      durationMs: 68_433,
    }),
    prepareOffer: async ({ maxBytes }) => {
      offers.push({ maxBytes })
      return {
        kind: 'ok',
        ticket: {
          url: 'http://127.0.0.1:1/x',
          hostNodeId: 'hub',
          expiresAtMs: 1_700_000_010_000,
          declaredBytes: 56_242_806,
        },
        durationMs: 68_433,
        bytes: 56_242_806,
      }
    },
    prepareStreamDial: async ({ row, audio }) => {
      dials.push({ clipKey: row.clipKey, audio })
      return (
        options.dial ?? {
          kind: 'ok',
          url: 'http://127.0.0.1:2/token',
          expiresAtMs: 1_700_000_030_000,
        }
      )
    },
  }
  return {
    provider: createAmcrestVideoclipsProvider(deps),
    logger,
    offers,
    dials,
  }
}

describe('listSources', () => {
  it('names itself and carries the measured availability', async () => {
    const { provider } = harness({
      availability: { state: 'ok', catalogAsOf: 1 },
    })
    const sources = await provider.listSources({ deviceId: DEVICE_ID })
    expect(sources).toHaveLength(1)
    expect(sources[0]?.source).toBe(CLIP_SOURCE_ONBOARD)
    expect(sources[0]?.addonId).toBe(AMCREST_ADDON_ID)
    expect(sources[0]?.availability.state).toBe('ok')
  })

  it('turns "no clips" into "no card"', async () => {
    const { provider } = harness({
      availability: { state: 'no-storage', reason: 'there is no card in it' },
    })
    const sources = await provider.listSources({ deviceId: DEVICE_ID })
    expect(sources[0]?.availability).toEqual({
      state: 'no-storage',
      reason: 'there is no card in it',
    })
  })

  it('answers [] for a camera this addon does not own', async () => {
    const { provider } = harness({ known: false })
    expect(await provider.listSources({ deviceId: 1 })).toEqual([])
  })
})

describe('listClips', () => {
  const window = {
    deviceId: DEVICE_ID,
    since: 0,
    until: Date.UTC(2030, 0, 1),
    provider: AMCREST_ADDON_ID,
  }

  it('maps a row into a clip with the one archived copy stated', async () => {
    const { provider } = harness({})
    const clips = await provider.listClips(window)
    expect(clips).toHaveLength(1)
    const clip = clips[0]
    expect(clip?.source).toBe(CLIP_SOURCE_ONBOARD)
    expect(clip?.kind).toBe('motion')
    expect(clip?.supportSub).toBe(false)
    expect(clip?.streams?.sub).toBeUndefined()
    expect(clip?.streams?.main?.bytes).toBe(56_242_806)
    // The camera's own strings survive verbatim — the mapping above is lossy
    // on purpose and this is the lossless copy (D549 20).
    expect(clip?.nativeTypes).toEqual(['VideoMotion'])
    // No JPEG on disk yet, so the row carries an OFFER — never a vouch, and
    // never an assertion that this camera cannot make a still.
    expect(clip?.thumbnailMint).toBe(
      `/addon/${AMCREST_ADDON_ID}/clip-thumb/${String(DEVICE_ID)}/${makeRow().clipKey}`,
    )
    expect(clip?.thumbnail).toBeUndefined()
    expect(clip?.thumbnailUnavailable).toBeUndefined()
  })

  it('VOUCHES a still that is really on disk, and then offers no mint', async () => {
    const { provider } = harness({ vouchedStill: true })
    const clip = (await provider.listClips(window))[0]
    expect(clip?.thumbnail).toBe(
      `/addon/${AMCREST_ADDON_ID}/clip-thumb/${String(DEVICE_ID)}/${makeRow().clipKey}`,
    )
    // Never both: a clip with a vouched still needs no mint.
    expect(clip?.thumbnailMint).toBeUndefined()
    expect(clip?.thumbnailUnavailable).toBeUndefined()
  })

  it('asks the store per CLIP, not once per listing', async () => {
    // A vouch is a `stat` on one clip's file. Answering a whole page from one
    // read would make every row claim the first row's picture.
    const asked: string[] = []
    const { provider } = harness({
      catalog: {
        kind: 'ok',
        rows: [
          makeRow(),
          makeRow({
            clipKey: '1790170000-1790170100',
            startMs: 1_790_170_000_000,
            endMs: 1_790_170_100_000,
          }),
        ],
      },
      vouched: asked,
    })
    await provider.listClips(window)
    // Both, each once — the listing is newest-first, which is not what this
    // test is about.
    expect(asked.toSorted()).toEqual([makeRow().clipKey, '1790170000-1790170100'].toSorted())
  })

  it('says NO STILL, with the real reason, for a row that spans nothing', async () => {
    // Known in advance and free: a mint would take the camera's replay lane
    // only to refuse with the same word.
    const { provider } = harness({
      catalog: { kind: 'ok', rows: [makeRow({ endMs: makeRow().startMs })] },
    })
    const clip = (await provider.listClips(window))[0]
    expect(clip?.thumbnailUnavailable).toEqual({ reason: 'no-keyframe' })
    expect(clip?.thumbnailMint).toBeUndefined()
    expect(clip?.thumbnail).toBeUndefined()
  })

  it('never claims a still is UNSUPPORTED — this provider mints them', async () => {
    const { provider } = harness({})
    for (const clip of await provider.listClips(window)) {
      expect(clip.thumbnailUnavailable?.reason).not.toBe('unsupported')
    }
  })

  it('answers [] for an EMPTY WINDOW and does not throw', async () => {
    // The camera cannot tell "nothing matched" from "malformed"; the catalog
    // settles it with a control search and this is the answer that follows.
    const { provider } = harness({ catalog: { kind: 'empty' } })
    expect(await provider.listClips(window)).toEqual([])
  })

  it('THROWS for a source that cannot answer, rather than flattening to []', async () => {
    const { provider } = harness({
      catalog: {
        kind: 'refused',
        availability: {
          state: 'index-empty',
          reason: 'its index answers nothing anywhere',
        },
      },
    })
    await expect(provider.listClips(window)).rejects.toThrow(/index-empty/)
  })

  it('narrows to the window it was asked for', async () => {
    const inside = makeRow()
    const outside = makeRow({
      clipKey: '1-2',
      startMs: Date.UTC(2020, 0, 1),
      endMs: Date.UTC(2020, 0, 1, 0, 1),
    })
    const { provider } = harness({
      catalog: { kind: 'ok', rows: [inside, outside] },
    })
    const clips = await provider.listClips({
      ...window,
      since: Date.UTC(2026, 8, 23),
      until: Date.UTC(2026, 8, 24),
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]?.id).toBe(
      mintClipId({
        source: CLIP_SOURCE_ONBOARD,
        startMs: inside.startMs,
        endMs: inside.endMs,
      }),
    )
  })
})

describe('served', () => {
  const window = {
    deviceId: DEVICE_ID,
    since: 0,
    until: Date.UTC(2030, 0, 1),
    provider: AMCREST_ADDON_ID,
  }

  it('answers `high` for every asked profile including an absent one', async () => {
    for (const profile of [undefined, 'low', 'mid', 'high'] as const) {
      const { provider } = harness({})
      const clips = await provider.listClips(window)
      const clipId = clips[0]?.id ?? ''
      const playback = await provider.getClipPlayback({
        deviceId: DEVICE_ID,
        clipId,
        ...(profile === undefined ? {} : { profile: profile satisfies CamProfile }),
      })
      expect(playback.served).toBe('high')
      expect(playback.format).toBe('mp4')
    }
  })

  it('says the upgrade ONCE per camera and asked profile, not per clip', async () => {
    const { provider, logger } = harness({})
    const clips = await provider.listClips(window)
    const clipId = clips[0]?.id ?? ''
    for (let index = 0; index < 5; index += 1) {
      await provider.getClipPlayback({
        deviceId: DEVICE_ID,
        clipId,
        profile: 'low',
      })
    }
    const upgradeLines = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => String(call[0]).includes('archives only the main copy'))
    expect(upgradeLines).toHaveLength(1)
  })

  it('says nothing at all when no profile was asked for', async () => {
    // An unstated ask is zero (D382) — there is nothing for a line to be about.
    const { provider, logger } = harness({})
    const clips = await provider.listClips(window)
    await provider.getClipPlayback({
      deviceId: DEVICE_ID,
      clipId: clips[0]?.id ?? '',
    })
    const upgradeLines = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => String(call[0]).includes('archives only the main copy'))
    expect(upgradeLines).toHaveLength(0)
  })
})

describe('catalog-miss', () => {
  it('refuses an id whose row this node never listed, although the id is readable', async () => {
    // The window in the id is enough to BUILD a URL and deliberately not
    // enough to be given one.
    const { provider } = harness({})
    const clipId = mintClipId({
      source: CLIP_SOURCE_ONBOARD,
      startMs: Date.UTC(2026, 8, 23, 8, 23, 27),
      endMs: Date.UTC(2026, 8, 23, 8, 24, 41),
    })
    expect(parseClipId(clipId)).not.toBeNull()
    await expect(provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })).rejects.toThrow(
      /catalog-miss/,
    )
  })

  it('refuses an id another provider minted', async () => {
    const { provider } = harness({})
    await expect(
      provider.getClipPlayback({
        deviceId: DEVICE_ID,
        clipId: 'native:reolink:onboard:1:abc',
      }),
    ).rejects.toThrow(/not minted by the Amcrest provider/)
  })
})

describe('offerClipBytes', () => {
  const window = {
    deviceId: DEVICE_ID,
    since: 0,
    until: Date.UTC(2030, 0, 1),
    provider: AMCREST_ADDON_ID,
  }

  it('caps the caller bound at the offer ceiling', async () => {
    const { provider, offers } = harness({})
    const clips = await provider.listClips(window)
    await provider.offerClipBytes?.({
      deviceId: DEVICE_ID,
      clipId: clips[0]?.id ?? '',
      provider: AMCREST_ADDON_ID,
      maxBytes: VIDEOCLIPS_MAX_OFFER_BYTES * 4,
    })
    expect(offers[0]?.maxBytes).toBe(VIDEOCLIPS_MAX_OFFER_BYTES)
  })

  it('refuses a listed size over the bound BEFORE touching the camera', async () => {
    const { provider, offers } = harness({
      catalog: {
        kind: 'ok',
        rows: [makeRow({ sizeBytes: VIDEOCLIPS_MAX_OFFER_BYTES + 1 })],
      },
    })
    const clips = await provider.listClips(window)
    await expect(
      provider.offerClipBytes?.({
        deviceId: DEVICE_ID,
        clipId: clips[0]?.id ?? '',
        provider: AMCREST_ADDON_ID,
      }),
    ).rejects.toThrow(/too-large-to-transfer/)
    expect(offers).toHaveLength(0)
  })
})

describe('getPlaybackOptions', () => {
  it('answers one of the contract’s envelopes, never one of its own', async () => {
    const { provider } = harness({})
    const options = await provider.getPlaybackOptions?.({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
    })
    expect(options).toBe(CLIP_PLAYBACK_OPTIONS.realtimeStream)
  })

  /**
   * D617. `chooseClipPath` picks `stream` whenever the BROKER has a dial, and
   * the broker's dial is a constant of its own closure — so the routing does
   * not read this declaration and the two can disagree in silence. They DID:
   * the provider declared `file` while implementing no `dialClipStream`, so a
   * clip reaching the broker was refused `stream-unavailable` (proved against
   * the live hub, 2026-09-23). The only thing that keeps them in step is that
   * the envelope's transport and the method's presence are decided together.
   */
  it('declares the transport it actually implements', async () => {
    const { provider } = harness({})
    const options = await provider.getPlaybackOptions?.({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
    })
    expect(options?.transport).toBe('stream')
    expect(typeof provider.dialClipStream).toBe('function')
  })

  it('offers no rate above realtime, because the source arrives at realtime', async () => {
    const { provider } = harness({})
    const options = await provider.getPlaybackOptions?.({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
    })
    expect(options?.rates.every((rate) => rate <= 1)).toBe(true)
    expect(options?.rates).toContain(1)
  })
})

describe('dialClipStream', () => {
  it('mints a dial for a clip this node listed, and states what it will carry', async () => {
    const { provider, dials } = harness({})
    const clips = await provider.listClips({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
      since: 0,
      until: 2e12,
    })
    const dial = await provider.dialClipStream?.({
      deviceId: DEVICE_ID,
      clipId: clips[0]?.id ?? '',
      provider: AMCREST_ADDON_ID,
      audio: 'opus',
    })
    expect(dial?.url).toBe('http://127.0.0.1:2/token')
    expect(dial?.transport).toBe('forward-only')
    expect(dial?.served).toBe('high')
    expect(dial?.servedAudio).toBe('opus')
    expect(dials).toEqual([{ clipKey: '1790151807-1790151881', audio: 'opus' }])
  })

  /**
   * The camera answers a window with no footage with the SAME 404 it answers
   * a bogus path with, so a dial for a window nobody listed would hand the
   * operator "this clip is gone" about a clip that never existed. The catalog
   * is the gate and the camera is not reached.
   */
  it('refuses a clip nobody listed WITHOUT touching the camera', async () => {
    const { provider, dials } = harness({})
    await expect(
      provider.dialClipStream?.({
        deviceId: DEVICE_ID,
        clipId: mintClipId({
          source: CLIP_SOURCE_ONBOARD,
          startMs: 1_700_000_000_000,
          endMs: 1_700_000_050_000,
        }),
        provider: AMCREST_ADDON_ID,
        audio: 'none',
      }),
    ).rejects.toThrow(/catalog-miss/)
    expect(dials).toEqual([])
  })

  it('carries the audio ask through, and names `none` as a reason', async () => {
    const { provider } = harness({})
    const clips = await provider.listClips({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
      since: 0,
      until: 2e12,
    })
    const dial = await provider.dialClipStream?.({
      deviceId: DEVICE_ID,
      clipId: clips[0]?.id ?? '',
      provider: AMCREST_ADDON_ID,
    })
    expect(dial?.servedAudio).toBe('none')
    expect(dial?.audioReason).toBe('not-requested')
  })

  it('passes a refusal through in the clip vocabulary', async () => {
    const { provider } = harness({
      dial: {
        kind: 'refused',
        code: 'camera-refused',
        detail: 'the camera answered 404',
      },
    })
    const clips = await provider.listClips({
      deviceId: DEVICE_ID,
      provider: AMCREST_ADDON_ID,
      since: 0,
      until: 2e12,
    })
    await expect(
      provider.dialClipStream?.({
        deviceId: DEVICE_ID,
        clipId: clips[0]?.id ?? '',
        provider: AMCREST_ADDON_ID,
        audio: 'none',
      }),
    ).rejects.toThrow(/camera-refused/)
  })
})

describe('clipFileLabel', () => {
  it('mints a name from the window, not from the camera’s bracketed file name', () => {
    // The camera's own name is `10.23.27-10.24.41[M][0@0][0].mp4` — brackets,
    // an `@`, and a clock with no date.
    const label = clipFileLabel(makeRow())
    expect(label).toBe('amcrest_2026-09-23T08-23-27.mp4')
    expect(label).not.toContain('[')
    expect(label).not.toContain('@')
  })
})
