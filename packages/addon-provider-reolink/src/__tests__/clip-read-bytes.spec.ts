/**
 * `videoclips.readClipBytes` on Reolink — the PRODUCING half of a clip export.
 *
 * The recorder cannot talk to a camera (one session per host, the sleep gate
 * before `getApi()`), so a cap seam is how a clip export gets its bytes
 * (D558 § 3, D572) — this inline one, or `offerClipBytes` over the framework
 * transport that D613 added beside it. Everything here is
 * about the four things that seam must never get wrong:
 *
 * 1. **It reuses the ONE fetch.** Same cmd 5, same 300 ms idle window, same
 *    duration proof against the catalog row, same single retry (D568). A
 *    second fetch path with its own completion rules is exactly the second
 *    authority D568 exists to prevent, so the assertions here are on the
 *    window the download SAW and on the retry it made.
 * 2. **The cheap question comes first.** The catalog row already carries the
 *    twin's declared size, so an over-size twin is refused without touching
 *    the camera at all (D54).
 * 3. **One authorised yes is ONE wake.** A read never wakes a standalone
 *    battery camera on its own; with the operator's authorisation it may,
 *    once.
 * 4. **It refuses BY NAME.** The engine believes a producer that speaks the
 *    `ClipExportFailure` vocabulary and turns everything else into
 *    `fetch-failed` with the prose verbatim (D572), so every refusal this
 *    producer can name is named here.
 */

import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClipBytes,
  type ClipExportFailure,
  clipExportFailureOf,
  type IVideoclipsProvider,
  VIDEOCLIPS_MAX_READ_BYTES,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCameraUid } from '../clips/clip-addressing.js'
import { createClipService } from '../clips/clip-service.js'
import { CLIP_IDLE_WINDOW_MS, CLIP_IDLE_WINDOW_RETRY_MS } from '../clips/clip-truncation.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger, type RecordingSink } from './clip-test-logger.js'

const SINCE = Date.parse('2026-09-16T00:00:00Z')
const UNTIL = Date.parse('2026-09-16T23:59:59Z')
/** 06:30:00 → 06:30:34 — a 34 s row, the shape D568 measured on 592. */
const CLIP_START = new Date('2026-09-16T06:30:00Z')
const CLIP_END = new Date('2026-09-16T06:30:34Z')
const SUB_FILE = '/mnt/sda/U10cam/RecS02_DST20260916_063000_063034_2B1E808_0.mp4'
const MAIN_FILE = '/mnt/sda/U10cam/RecM02_DST20260916_063000_063034_2B1E808_0.mp4'
/** The measured sub size on 592, and its main twin at the measured ~33×. */
const SUB_BYTES = 695_125
const MAIN_BYTES = 22_940_125

const scratchDirs: string[] = []

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/**
 * What a CALLER states, minus the one thing this harness answers for it.
 *
 * `provider` became required on 2026-09-21 (D554's rule, one method over): a
 * read that names nobody resolves in-process to whichever videoclips provider
 * the calling addon registers, which is how every onboard clip was answered by
 * the recorder's "an analytics visit has no file behind it". A MEMBER provider
 * does not read the field — it is already the one being asked — so the harness
 * supplies it and the cases stay about the bytes.
 */
type ReadInput = Omit<Parameters<NonNullable<IVideoclipsProvider['readClipBytes']>>[0], 'provider'>

interface DownloadArgs {
  readonly fileName: string
  readonly idleTimeoutMs?: number
}

interface HarnessOptions {
  /** One entry per download attempt; the last repeats. `null` = unmeasured. */
  readonly durations?: readonly (number | null)[]
  /** The camera answers every attempt with nothing. */
  readonly downloadEmpty?: boolean
  /** The mux binary does not exist. */
  readonly brokenMux?: boolean
  readonly isBattery?: boolean
  readonly isHubChild?: boolean
  readonly withMain?: boolean
  readonly mainBytes?: number
  readonly subBytes?: number
  readonly inProgress?: boolean
}

interface Harness {
  readonly read: (input: ReadInput) => Promise<ClipBytes>
  readonly list: () => Promise<readonly { readonly id: string }[]>
  readonly clipId: () => Promise<string>
  readonly listed: () => Promise<readonly { readonly id: string }[]>
  readonly seen: readonly DownloadArgs[]
  readonly apiCalls: () => number
  readonly logger: RecordingSink
  readonly scratchFiles: () => Promise<readonly string[]>
  /** Flip the camera's believed sleep state between calls. */
  readonly setSleeping: (value: boolean) => void
}

/**
 * A stand-in ffmpeg that copies its first input to its output.
 *
 * The mux is not what these tests are about — `clip-mux.spec.ts` owns the
 * argument vector — but the BYTES are: the answer must carry the file that was
 * produced from the twin that was asked for, so the delivered base64 has to be
 * traceable back to the download. Copying the elementary stream through makes
 * it exactly that, without depending on a real ffmpeg build.
 */
async function writeStubFfmpeg(dir: string): Promise<string> {
  const path = join(dir, 'stub-ffmpeg')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'prev=""',
      'input=""',
      'last=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-i" ] && [ -z "$input" ]; then input="$a"; fi',
      '  prev="$a"',
      '  last="$a"',
      'done',
      'cat "$input" > "$last"',
      '',
    ].join('\n'),
    'utf8',
  )
  await chmod(path, 0o755)
  return path
}

/** The payload each twin's download delivers, so the answer names its source. */
function payloadFor(fileName: string): Buffer {
  return Buffer.from(`annexb:${fileName}`, 'utf8')
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-read-bytes-'))
  scratchDirs.push(dataDir)
  const realFfmpeg = await writeStubFfmpeg(dataDir)
  const ffmpegBinaryPath = options.brokenMux === true ? join(dataDir, 'no-such-ffmpeg') : realFfmpeg

  const withMain = options.withMain ?? true
  const durations = options.durations ?? [33.856]
  const seen: DownloadArgs[] = []
  let attempt = 0
  const download = vi.fn(async (params: DownloadArgs) => {
    seen.push(params)
    const durationSeconds = durations[Math.min(attempt, durations.length - 1)] ?? null
    attempt += 1
    return {
      annexB: options.downloadEmpty === true ? Buffer.alloc(0) : payloadFor(params.fileName),
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

  let apiCalls = 0
  const open = options.inProgress === true
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
      const base = {
        startTime: CLIP_START,
        endTime: CLIP_END,
        supportSub: true,
        recordType: 'md,people',
      }
      if (streamType === 'mainStream') {
        if (!withMain) return []
        return [
          {
            ...base,
            fileName: 'RecM02',
            id: MAIN_FILE,
            sizeBytes: options.mainBytes ?? MAIN_BYTES,
          },
        ]
      }
      // An OPEN recording is named with a `_000000_` end stamp AND carries a
      // size of 0 — BOTH, exactly as the camera writes it (`clip-catalog.ts`).
      const subName = open
        ? 'RecS02_DST20260916_063000_000000_2B1E808_0.mp4'
        : 'RecS02_DST20260916_063000_063034_2B1E808_0.mp4'
      return [
        {
          ...base,
          fileName: subName,
          id: open ? SUB_FILE.replace('_063034_', '_000000_') : SUB_FILE,
          sizeBytes: open ? 0 : (options.subBytes ?? SUB_BYTES),
        },
      ]
    }),
    searchAlarmVideos: vi.fn(async () => []),
    getVideoclipThumbnailJpeg: vi.fn(async () => Buffer.from('a-real-jpeg')),
    // The STREAM path (stage 1) is not what this spec exercises; a fake that
    // answered bytes here would vouch for a route nobody asserted.
    fileInfoListReplayBinaryDownload: vi.fn(async () => {
      throw new Error('the clip stream path must not be called here')
    }),
    downloadRecordingDemuxed: download,
  }

  const logger = createRecordingLogger()
  let sleeping = false
  const service = createClipService({
    dataDir,
    logger,
    resolveDevice: async (): Promise<ClipDeviceRef> => ({
      deviceId: 107,
      channel: 0,
      // A hub child is SELECTED by uid; a standalone ignores it and 592 has
      // none persisted (`clip-addressing.ts`).
      uid: resolveCameraUid({
        metadataUid: options.isHubChild === true ? 'CHILDUID' : undefined,
        configUid: undefined,
      }),
      isHubChild: options.isHubChild ?? false,
      isBattery: options.isBattery ?? false,
      sleeping,
      timeZone: 'Europe/Rome',
      hostKey: '192.168.60.226',
      getApi: async () => {
        apiCalls += 1
        return api
      },
    }),
    resolveFfmpeg: async () => ffmpegBinaryPath,
  })

  const list = async (): Promise<readonly { readonly id: string }[]> =>
    service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })

  const clipId = async (): Promise<string> => {
    const id = (await list())[0]?.id
    if (id === undefined) throw new Error('the fake camera listed no clips')
    return id
  }

  /** What the listing ANSWERED — which is not everything it walked. */
  const listed = async (): Promise<readonly { readonly id: string }[]> => list()

  const read = async (input: ReadInput): Promise<ClipBytes> => {
    const method = service.provider.readClipBytes
    if (method === undefined) {
      throw new Error('videoclips: the Reolink provider does not implement readClipBytes')
    }
    // The CALLER names the provider (D554's rule reached this method on
    // 2026-09-21). A member does not read it — it is already the one being
    // asked — but the contract makes the caller decide rather than let an
    // in-process resolution pick a sibling.
    return method({ ...input, provider: 'provider-reolink' })
  }

  return {
    read,
    list,
    clipId,
    listed,
    seen,
    apiCalls: () => apiCalls,
    logger,
    setSleeping: (value: boolean) => {
      sleeping = value
    },
    scratchFiles: async () => {
      try {
        return await readdir(join(dataDir, 'clip-media', '107'))
      } catch {
        return []
      }
    },
  }
}

/** The token a refusal carried, or `null` when it did not speak the vocabulary. */
async function refusalOf(run: Promise<unknown>): Promise<ClipExportFailure | null> {
  try {
    await run
  } catch (err: unknown) {
    return clipExportFailureOf(err instanceof Error ? err.message : String(err))
  }
  throw new Error('expected a refusal, got an answer')
}

// ── the answer ────────────────────────────────────────────────────────────

describe('a clip read serves the bytes the fetch produced', () => {
  it('answers the sub twin, named, with the duration it MEASURED', async () => {
    const h = await harness()
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId() })

    expect(answer.served).toBe('low')
    expect(answer.contentType).toBe('video/mp4')
    expect(answer.name).toBe('RecS02_DST20260916_063000_063034_2B1E808_0.mp4')
    const bytes = Buffer.from(answer.base64, 'base64')
    expect(bytes.equals(payloadFor(SUB_FILE))).toBe(true)
    expect(answer.bytes).toBe(bytes.byteLength)
    // MEASURED — the decode said 33.856 s. Never the row's own 34 000 ms.
    expect(answer.durationMs).toBe(33_856)
  })

  it('takes the clip on the SAME window the player path takes', async () => {
    const h = await harness()
    await h.read({ deviceId: 107, clipId: await h.clipId() })
    expect(h.seen.length).toBe(1)
    expect(h.seen[0]?.idleTimeoutMs).toBe(CLIP_IDLE_WINDOW_MS)
    expect(h.seen[0]?.fileName).toBe(SUB_FILE)
  })

  it('retries a truncated pass once on the long window (D568), not on a rule of its own', async () => {
    const h = await harness({ durations: [12.5, 33.856] })
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId() })
    expect(h.seen.map((args) => args.idleTimeoutMs)).toEqual([
      CLIP_IDLE_WINDOW_MS,
      CLIP_IDLE_WINDOW_RETRY_MS,
    ])
    expect(answer.durationMs).toBe(33_856)
    const warn = h.logger.warns.find((l) => l.extras.meta?.['branch'] === 'truncated-fetch')
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('omits the duration rather than inventing one when nothing measured it', async () => {
    const h = await harness({ durations: [null] })
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId() })
    // Absent, never zero and never the row's span dressed up as a measurement.
    expect(answer.durationMs).toBeUndefined()
    expect(answer.bytes).toBeGreaterThan(0)
  })
})

describe('the twin is the one that was asked for, and `served` says which', () => {
  it('fetches the MAIN file for `high`', async () => {
    const h = await harness()
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId(), profile: 'high' })
    expect(h.seen.map((args) => args.fileName)).toEqual([MAIN_FILE])
    expect(answer.served).toBe('high')
    expect(Buffer.from(answer.base64, 'base64').equals(payloadFor(MAIN_FILE))).toBe(true)
    expect(answer.name).toBe('RecM02_DST20260916_063000_063034_2B1E808_0.mp4')
  })

  it('serves `mid` from the sub file, exactly as `low` does', async () => {
    const h = await harness()
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId(), profile: 'mid' })
    expect(h.seen.map((args) => args.fileName)).toEqual([SUB_FILE])
    expect(answer.served).toBe('low')
  })

  it('serves the sub and SAYS SO when the asked twin does not exist (D549 15)', async () => {
    const h = await harness({ withMain: false })
    const answer = await h.read({ deviceId: 107, clipId: await h.clipId(), profile: 'high' })
    expect(answer.served).toBe('low')
    expect(h.seen.map((args) => args.fileName)).toEqual([SUB_FILE])
    const line = h.logger.warns.find((l) => l.extras.meta?.['branch'] === 'no-main-twin')
    expect(line).toBeDefined()
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
  })
})

// ── the bound, asked before the camera ────────────────────────────────────

describe('an over-size twin is refused before anything is fetched', () => {
  it('refuses a main twin over the ceiling from the CATALOG row alone', async () => {
    const h = await harness({ mainBytes: 60 * 1024 * 1024 })
    const id = await h.clipId()
    const before = h.apiCalls()
    expect(await refusalOf(h.read({ deviceId: 107, clipId: id, profile: 'high' }))).toBe(
      'too-large-to-transfer',
    )
    // Not one byte, and not one extra session: the cheap question came first.
    expect(h.seen.length).toBe(0)
    expect(h.apiCalls()).toBe(before)
    // The two ways to be too large are DISTINGUISHABLE on the log line: this
    // one cites the camera's listed size, which is not the size we deliver.
    const line = h.logger.warns.find((l) => l.extras.meta?.['branch'] === 'too-large-to-transfer')
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
    expect(line?.extras.meta).toMatchObject({ declaredBytes: 60 * 1024 * 1024, twin: 'main' })
    expect(line?.extras.meta?.['bytes']).toBeUndefined()
  })

  it("honours the CALLER's smaller bound", async () => {
    const h = await harness()
    expect(
      await refusalOf(h.read({ deviceId: 107, clipId: await h.clipId(), maxBytes: 1_000 })),
    ).toBe('too-large-to-transfer')
    expect(h.seen.length).toBe(0)
  })

  it('caps the caller at the ceiling, however large a bound it passes', async () => {
    const h = await harness({ subBytes: VIDEOCLIPS_MAX_READ_BYTES + 1 })
    expect(
      await refusalOf(
        h.read({
          deviceId: 107,
          clipId: await h.clipId(),
          maxBytes: VIDEOCLIPS_MAX_READ_BYTES * 4,
        }),
      ),
    ).toBe('too-large-to-transfer')
    expect(h.seen.length).toBe(0)
  })

  it('refuses a DELIVERED file over the bound rather than truncating it', async () => {
    // The row under-declares: the camera's listed size has never matched the
    // received byte count on any clip measured (D568), so the delivered file
    // is bounded again after the mux.
    const h = await harness({ subBytes: 10 })
    expect(await refusalOf(h.read({ deviceId: 107, clipId: await h.clipId(), maxBytes: 12 }))).toBe(
      'too-large-to-transfer',
    )
    expect(h.seen.length).toBe(1)
    // The MEASURED file, not the listed one.
    const line = h.logger.warns.find((l) => l.extras.meta?.['branch'] === 'too-large-to-transfer')
    expect(line?.extras.meta?.['declaredBytes']).toBeUndefined()
    expect(line?.extras.meta?.['bytes']).toBeGreaterThan(12)
  })
})

// ── the wake ──────────────────────────────────────────────────────────────

describe('a read never wakes a standalone battery camera on its own', () => {
  it('refuses by name, before any session is opened', async () => {
    // Listed while awake — the only state in which a sleeping camera has rows
    // at all — then asleep by the time the bytes are asked for.
    const h = await harness({ isBattery: true })
    const id = await h.clipId()
    h.setSleeping(true)
    const before = h.apiCalls()

    expect(await refusalOf(h.read({ deviceId: 107, clipId: id }))).toBe('sleeping')
    expect(h.seen.length).toBe(0)
    expect(h.apiCalls()).toBe(before)
  })

  it('spends an operator authorisation on exactly ONE fetch', async () => {
    const h = await harness({ isBattery: true })
    const id = await h.clipId()
    h.setSleeping(true)

    const answer = await h.read({ deviceId: 107, clipId: id, wake: 'authorised' })
    expect(answer.served).toBe('low')
    expect(h.seen.length).toBe(1)
    const line = h.logger.warns.find((l) => l.extras.meta?.['branch'] === 'wake-authorised')
    expect(line).toBeDefined()
    expect(line?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('never gates a HUB CHILD on sleep — its bytes ride the parent socket', async () => {
    const h = await harness({ isBattery: true, isHubChild: true })
    const id = await h.clipId()
    h.setSleeping(true)
    const answer = await h.read({ deviceId: 107, clipId: id })
    expect(answer.served).toBe('low')
    expect(h.seen.length).toBe(1)
  })
})

// ── the named refusals ────────────────────────────────────────────────────

describe('every refusal this producer can name, it names', () => {
  it('refuses a clip the catalog has never listed HERE (from cold)', async () => {
    const h = await harness()
    // No `listClips` first: nothing has put a row in this runner's memory, and
    // a file name is a path on the camera — there is nothing to guess.
    const id = `native:reolink:onboard:0:${Buffer.from(SUB_FILE, 'utf8').toString('base64url')}`
    expect(await refusalOf(h.read({ deviceId: 107, clipId: id }))).toBe('catalog-miss')
    expect(h.seen.length).toBe(0)
  })

  it('refuses an id another source minted', async () => {
    const h = await harness()
    await h.list()
    expect(await refusalOf(h.read({ deviceId: 107, clipId: 'analytics:107:abc' }))).toBe(
      'catalog-miss',
    )
  })

  it('does not LIST a recording that is still being written', async () => {
    // Operator's call, 2026-09-22: *"Niente clips in preparazione, non ha
    // senso visualizzarle."* The row is dropped by the one listing gate
    // (`listableClips`), which is where the rule and its reasons live.
    //
    // The producer's own `clip-in-progress` refusal is KEPT and is now
    // defence-in-depth: an id outlives the listing that produced it — a deep
    // link, a card drawn a minute ago, a queued export — and such an id must
    // still be told why rather than getting a generic miss. It is not asserted
    // from here any more, because this harness can only obtain an id BY
    // listing, and that is precisely what no longer yields one.
    const h = await harness({ inProgress: true })
    expect(await h.listed()).toEqual([])
    expect(h.seen.length).toBe(0)
  })

  it('names the CAMERA when the download never lands', async () => {
    const h = await harness({ downloadEmpty: true })
    expect(await refusalOf(h.read({ deviceId: 107, clipId: await h.clipId() }))).toBe(
      'camera-refused',
    )
  })

  it('names the PRODUCER when the mux fails', async () => {
    const h = await harness({ brokenMux: true })
    expect(await refusalOf(h.read({ deviceId: 107, clipId: await h.clipId() }))).toBe(
      'fetch-failed',
    )
  })
})

// ── the scratch ───────────────────────────────────────────────────────────

describe('the per-device scratch is reused for the twin it holds, and only that one', () => {
  it('serves a second sub read from the scratch without touching the camera', async () => {
    const h = await harness()
    const id = await h.clipId()
    const first = await h.read({ deviceId: 107, clipId: id })
    const second = await h.read({ deviceId: 107, clipId: id })
    expect(h.seen.length).toBe(1)
    expect(second.base64).toBe(first.base64)
    expect(second.served).toBe('low')
    // Not measured on THIS pass — and a duration is never derived from the
    // row and presented as measured.
    expect(second.durationMs).toBeUndefined()
  })

  it('warms the scratch the player reads, so a read then a play costs one fetch', async () => {
    const h = await harness()
    await h.read({ deviceId: 107, clipId: await h.clipId() })
    expect((await h.scratchFiles()).length).toBe(1)
  })

  it('never files a MAIN twin under the sub key the player resolves', async () => {
    const h = await harness()
    await h.read({ deviceId: 107, clipId: await h.clipId(), profile: 'high' })
    // The scratch key is `clipKeyFor(channel, subFileName)` and carries no
    // twin, so a main file written under it would be served to every `low`
    // playback of that clip.
    expect(await h.scratchFiles()).toEqual([])
  })

  it('costs ONE fetch when two reads of the same twin race', async () => {
    const h = await harness()
    const id = await h.clipId()
    const [a, b] = await Promise.all([
      h.read({ deviceId: 107, clipId: id, profile: 'high' }),
      h.read({ deviceId: 107, clipId: id, profile: 'high' }),
    ])
    expect(h.seen.length).toBe(1)
    expect(a.base64).toBe(b.base64)
  })
})
