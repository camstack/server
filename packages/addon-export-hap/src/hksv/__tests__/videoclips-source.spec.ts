/**
 * The `videoclips` source over the teed HomeKit clips.
 *
 * Driven against a REAL temporary directory through a REAL `HksvClipStore`,
 * because every claim here is a claim about what is on disk: "the row is
 * playable", "the thumbnail is vouched", "the source says `ok` because
 * something was really read". A fake store would only prove the provider
 * agrees with the fake, which is how this repo has twice shipped a green
 * suite over a live bug.
 *
 * **Every honest-state spec asks `listSources` FIRST, cold.** D561: the
 * Reolink surface computed its states as a side effect of `listClips`, every
 * spec listed before it asked, and on the live cluster a cold process answered
 * `ok` for a camera with nothing. The gap was in the SUITE before it was on the
 * wire.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CamProfile, ClipBytes, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HksvBuildOutcome } from '../build-outcome.js'
import type { ClipLocationRefusal } from '../clip-location.js'
import { clipFileNames } from '../clip-record.js'
import { HksvClipStore } from '../clip-store.js'
import type { ClipThumbnailMinter } from '../clip-store.js'
import type { HksvCameraFacts } from '../videoclips-source.js'
import { createHksvVideoclipsProvider, HKSV_CLIP_SOURCE_LABEL } from '../videoclips-source.js'

const DEVICE_ID = 101
const ADDON_ID = 'export-hap'
const NOW = 5_000_000

interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
  readonly tags?: Record<string, unknown>
}

function logger(sink: LogLine[]): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, payload?: LogPayload): void => {
      sink.push({ level, message, meta: payload?.meta ?? {}, tags: payload?.tags ?? {} })
    }
  const log = {
    debug: () => {},
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: the provider only ever calls these six.
  return log as unknown as IScopedLogger
}

let root = ''
let logs: LogLine[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hksv-clip-source-'))
  logs = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const honestMinter: ClipThumbnailMinter = async ({ jpegPath }) => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(jpegPath, Buffer.alloc(256, 0xff))
  return { ok: true }
}

function facts(over: Partial<HksvCameraFacts> = {}): HksvCameraFacts {
  return {
    exported: true,
    homekitRecording: true,
    keepingClips: true,
    lastBuild: null,
    ...over,
  }
}

function withheld(reason: HksvBuildOutcome['withheld'], detail: string): HksvBuildOutcome {
  return { deviceId: DEVICE_ID, advertised: false, withheld: reason, detail, atMs: NOW - 1_000 }
}

interface Harness {
  readonly store: HksvClipStore
  readonly provider: ReturnType<typeof createHksvVideoclipsProvider>
  writeClip(input: {
    readonly streamId: number
    readonly startedAtMs: number
    readonly endedAtMs?: number
    readonly deviceId?: number
    readonly minter?: ClipThumbnailMinter
    readonly profile?: CamProfile | null
  }): Promise<string>
}

function harness(
  options: {
    readonly camera?: HksvCameraFacts
    readonly resolveRoot?: () => Promise<string | null>
    readonly refusal?: ClipLocationRefusal | null
    readonly minter?: ClipThumbnailMinter
  } = {},
): Harness {
  const log = logger(logs)
  const store = new HksvClipStore({
    logger: log,
    resolveRoot: options.resolveRoot ?? (async () => root),
    mintThumbnail: options.minter,
    now: () => NOW,
  })
  const provider = createHksvVideoclipsProvider({
    logger: log,
    addonId: ADDON_ID,
    describeCamera: () => options.camera ?? facts(),
    readCatalog: (deviceId) => store.listCatalog(deviceId),
    locationRefusal: () => options.refusal ?? null,
    mediaUrl: (deviceId, stem) => `/addon/${ADDON_ID}/hksv-clip/${String(deviceId)}/${stem}.mp4`,
    thumbnailUrl: (deviceId, stem) =>
      `/addon/${ADDON_ID}/hksv-clip-thumb/${String(deviceId)}/${stem}.jpg`,
    clipFilePath: (deviceId, stem) => store.artifactPath(deviceId, stem, 'clip'),
    now: () => NOW,
  })
  return {
    store,
    provider,
    writeClip: async (input) => {
      const deviceId = input.deviceId ?? DEVICE_ID
      const profile = input.profile === undefined ? 'mid' : input.profile
      const open = await store.open({
        deviceId,
        streamId: input.streamId,
        startedAtMs: input.startedAtMs,
        prebufferSpanMs: 4_000,
        width: 1280,
        height: 720,
        fragmentMs: 4_000,
        ...(profile === null ? {} : { profile }),
      })
      if (open === null) throw new Error('the store refused to open a clip')
      await open.sink.write(new Uint8Array(64).fill(7))
      await open.sink.close()
      const record = await open.complete({
        bytes: 64,
        fragments: 2,
        sawInit: true,
        truncated: null,
        startedAtMs: input.startedAtMs,
        endedAtMs: input.endedAtMs ?? input.startedAtMs + 20_000,
      })
      if (record === null) throw new Error('the store dropped the clip')
      return record.clipId
    },
  }
}

describe('the HKSV source EXISTS because of HomeKit, and is not a switch', () => {
  it('lists no source for a camera that is not exported to HomeKit', async () => {
    const h = harness({ camera: facts({ exported: false }) })
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    expect(await h.provider.listSources({ deviceId: DEVICE_ID })).toEqual([])
  })

  it('lists no source once HomeKit recording is switched off for the camera', async () => {
    const h = harness({ camera: facts({ homekitRecording: false }) })
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    expect(await h.provider.listSources({ deviceId: DEVICE_ID })).toEqual([])
  })

  it('lists the source, named and attributed, when both are on', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const sources = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(sources).toHaveLength(1)
    expect(sources[0]?.source).toBe('hksv')
    expect(sources[0]?.addonId).toBe(ADDON_ID)
    expect(sources[0]?.label).toBe(HKSV_CLIP_SOURCE_LABEL)
  })

  it('keeps listing the source when the operator switched the COPIES off, and says so', async () => {
    // D62: an off switch is REPORTED off. `keepClips` governs the tee, not the
    // existence of the source — the clips already kept are still the truth.
    const h = harness({ camera: facts({ keepingClips: false }) })
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('ok')
    expect(source?.availability.reason).toContain('switched off')
  })
})

describe('listSources MEASURES the state it reports — asked COLD', () => {
  it('says ok only because a real directory read answered, and dates the answer', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('ok')
    expect(source?.availability.catalogAsOf).toBe(NOW)
  })

  it('says ok with nothing kept yet — an empty directory is an ANSWER', async () => {
    const h = harness()
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('ok')
    expect(source?.availability.reason).toContain('nothing')
  })

  it('says no-storage when the location is readonly, drained or disabled', async () => {
    const h = harness({ resolveRoot: async () => null, refusal: 'not-writable' })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('no-storage')
    expect(source?.availability.reason).toContain('not-writable')
  })

  it('says no-storage when no clips location has been seeded at all', async () => {
    const h = harness({ resolveRoot: async () => null, refusal: 'no-location' })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('no-storage')
    expect(source?.availability.reason).toContain('no-location')
  })

  it('says unreachable when the storage cap could not be reached — never ok', async () => {
    const h = harness({ resolveRoot: async () => null, refusal: 'unreachable' })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('unreachable')
  })

  it('says unreachable when the catalog read THREW — a failed read is not "no clips"', async () => {
    const h = harness({
      resolveRoot: async () => {
        throw new Error('storage cap timed out')
      },
    })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('unreachable')
    expect(source?.availability.reason).toContain('storage cap timed out')
  })

  it('says index-empty for a camera HomeKit never recorded, naming the refusal', async () => {
    // The operator's switch says RECORD and the store holds nothing: that is a
    // contradiction, and the only honest thing is to say which of
    // `buildHksvRecording`'s three refusals fired.
    const h = harness({
      camera: facts({
        lastBuild: withheld('key-frame-interval', 'gopMs=12000'),
      }),
    })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('index-empty')
    expect(source?.availability.reason).toContain('key-frame-interval')
    expect(source?.availability.reason).toContain('gopMs=12000')
  })

  it('does not call a camera that never recorded index-empty once a clip exists', async () => {
    const h = harness({ camera: facts({ lastBuild: withheld('no-recordable-stream', 'h265') }) })
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [source] = await h.provider.listSources({ deviceId: DEVICE_ID })
    expect(source?.availability.state).toBe('ok')
  })
})

describe('listClips answers from the store', () => {
  it('lists newest first with the real time range', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000, endedAtMs: 21_000 })
    await h.writeClip({ streamId: 2, startedAtMs: 60_000, endedAtMs: 75_000 })
    const clips = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      provider: ADDON_ID,
    })
    expect(clips.map((c) => c.timeRange)).toEqual([
      { startMs: 60_000, endMs: 75_000 },
      { startMs: 1_000, endMs: 21_000 },
    ])
    expect(clips.every((c) => c.source === 'hksv' && c.kind === 'native')).toBe(true)
  })

  it('honours the window and the limit', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000, endedAtMs: 21_000 })
    await h.writeClip({ streamId: 2, startedAtMs: 60_000, endedAtMs: 75_000 })
    await h.writeClip({ streamId: 3, startedAtMs: 120_000, endedAtMs: 140_000 })
    const inWindow = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 50_000,
      until: 100_000,
      provider: ADDON_ID,
    })
    expect(inWindow.map((c) => c.timeRange.startMs)).toEqual([60_000])
    const capped = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      limit: 2,
      provider: ADDON_ID,
    })
    expect(capped).toHaveLength(2)
  })

  it('emits a VOUCHED thumbnail url only when the JPEG is really on disk', async () => {
    const h = harness({ minter: honestMinter })
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [clip] = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      provider: ADDON_ID,
    })
    expect(clip?.thumbnail).toContain(clipFileNames(clipId).thumbnail)
    expect(clip?.thumbnailUnavailable).toBeUndefined()
  })

  it('names the reason when the clip has no still, instead of a blank claim', async () => {
    // No minter was wired, so the store wrote `not-attempted`. The surface must
    // draw a glyph and a reason, never an empty tile that looks like a bug.
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [clip] = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      provider: ADDON_ID,
    })
    expect(clip?.thumbnail).toBeUndefined()
    expect(clip?.thumbnailUnavailable?.reason).toBe('unsupported')
    expect(
      logs.some(
        (l) => l.meta['thumbnailReason'] === 'not-attempted' && l.tags['deviceId'] === DEVICE_ID,
      ),
    ).toBe(true)
  })

  it('LISTS a clip whose fMP4 is gone, saying it cannot be played', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    await rm(join(root, String(DEVICE_ID), clipFileNames(clipId).clip))
    const [clip] = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      provider: ADDON_ID,
    })
    expect(clip?.id).toBe(clipId)
    expect(clip?.playable).toBe(false)
    expect(clip?.unplayableReason).toBe('clip-file-missing')
  })

  it('leaves `playable` ABSENT for a clip that has its bytes — absent means yes', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const [clip] = await h.provider.listClips({
      deviceId: DEVICE_ID,
      since: 0,
      until: 200_000,
      provider: ADDON_ID,
    })
    expect(clip?.playable).toBeUndefined()
  })

  it('answers [] for a camera this addon does not export — not its business', async () => {
    const h = harness({ camera: facts({ exported: false }) })
    expect(
      await h.provider.listClips({
        deviceId: DEVICE_ID,
        since: 0,
        until: 200_000,
        provider: ADDON_ID,
      }),
    ).toEqual([])
  })

  it('REFUSES by name rather than answering [] when the source cannot answer', async () => {
    const h = harness({ resolveRoot: async () => null, refusal: 'not-writable' })
    await expect(
      h.provider.listClips({ deviceId: DEVICE_ID, since: 0, until: 200_000, provider: ADDON_ID }),
    ).rejects.toThrow(/no-storage/)
    expect(logs.some((l) => l.level === 'warn' && l.tags['deviceId'] === DEVICE_ID)).toBe(true)
  })

  it('answers [] for an ordinary quiet window on a source that CAN answer', async () => {
    const h = harness()
    await h.writeClip({ streamId: 1, startedAtMs: 1_000, endedAtMs: 21_000 })
    expect(
      await h.provider.listClips({
        deviceId: DEVICE_ID,
        since: 500_000,
        until: 600_000,
        provider: ADDON_ID,
      }),
    ).toEqual([])
  })
})

describe('getClipPlayback serves the bytes by handle', () => {
  it('answers a media url on this addon’s own plane, as an mp4', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    const playback = await h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })
    expect(playback.format).toBe('mp4')
    expect(playback.playbackUrl).toBe(
      `/addon/${ADDON_ID}/hksv-clip/${String(DEVICE_ID)}/${clipFileNames(clipId).clip}`,
    )
    // The URL is not a credential (D549 22): nothing is appended to it.
    expect(playback.playbackUrl).not.toContain('token')
  })

  it('refuses an id this provider did not mint', async () => {
    const h = harness()
    await expect(
      h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId: 'analytics:1:2:abc' }),
    ).rejects.toThrow(/not minted/)
  })

  it('refuses an id minted for a DIFFERENT camera', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000, deviceId: 102 })
    await expect(h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })).rejects.toThrow(
      /another camera/,
    )
  })

  it('refuses a clip whose fMP4 is gone, in the words the row already used', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    await rm(join(root, String(DEVICE_ID), clipFileNames(clipId).clip))
    await expect(h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })).rejects.toThrow(
      /clip-file-missing/,
    )
  })

  it('refuses a clip nothing in the catalog answers to', async () => {
    const h = harness()
    await expect(
      h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId: `hksv:${String(DEVICE_ID)}:1-2` }),
    ).rejects.toThrow(/no clip/)
  })
})

/**
 * `readClipBytes` is an OPTIONAL cap method — a provider may not have one. This
 * source DOES, because an addon cannot fetch another addon's data-plane URL,
 * and a clip export that could not reach a HomeKit clip would be a source the
 * operator can see and not save. So the spec asserts the method exists before
 * it asserts anything about the bytes.
 */
function readBytes(
  h: Harness,
  input: { readonly deviceId: number; readonly clipId: string; readonly maxBytes?: number },
): Promise<ClipBytes> {
  const read = h.provider.readClipBytes
  if (read === undefined) {
    throw new Error('the HomeKit clip source must implement readClipBytes')
  }
  // The caller NAMES the provider (D554's rule reached this method on
  // 2026-09-21). A member provider does not read it — it is already the one
  // being asked — but the type says the caller had to decide.
  return read({ ...input, provider: 'export-hap' })
}

describe('readClipBytes — the by-handle read another ADDON pulls', () => {
  it('answers the clip’s bytes, named, with the twin it really served', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000, endedAtMs: 21_000 })
    const bytes = await readBytes(h, { deviceId: DEVICE_ID, clipId })
    expect(bytes.contentType).toBe('video/mp4')
    expect(bytes.bytes).toBe(64)
    expect(Buffer.from(bytes.base64, 'base64').byteLength).toBe(64)
    expect(bytes.name).toContain('.mp4')
    // The SLOT HomeKit recorded from, written by the tee — never derived from
    // the pixels, which say nothing about which broker profile they came from.
    expect(bytes.served).toBe('mid')
    expect(bytes.durationMs).toBe(20_000)
  })

  it('REFUSES a clip bigger than the caller’s bound, with the size in the message', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    await expect(readBytes(h, { deviceId: DEVICE_ID, clipId, maxBytes: 10 })).rejects.toThrow(/64/)
  })

  it('refuses a clip whose sidecar does not name the slot it recorded from', async () => {
    // Half an answer is worse than a refusal: `served` is a measurement the
    // tee makes, and a sidecar written before it did cannot be guessed at.
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000, profile: null })
    await expect(readBytes(h, { deviceId: DEVICE_ID, clipId })).rejects.toThrow(/which profile/)
  })

  it('refuses a clip whose bytes are gone', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000 })
    await rm(join(root, String(DEVICE_ID), clipFileNames(clipId).clip))
    await expect(readBytes(h, { deviceId: DEVICE_ID, clipId })).rejects.toThrow(/clip-file-missing/)
  })
})

describe('getClipPlayback names the twin it serves', () => {
  it('says which slot HomeKit recorded from', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000, profile: 'low' })
    const playback = await h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })
    expect(playback.served).toBe('low')
  })

  it('leaves `served` absent when the sidecar never recorded one', async () => {
    const h = harness()
    const clipId = await h.writeClip({ streamId: 1, startedAtMs: 1_000, profile: null })
    const playback = await h.provider.getClipPlayback({ deviceId: DEVICE_ID, clipId })
    expect(playback.served).toBeUndefined()
  })
})
