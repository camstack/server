import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger, LogExtras, RelocateFootageInput } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { RelocateEngine } from '../../relocate-engine.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentStore } from '../../segment-store.js'
import type { ArchiveDeviceUsage, SegmentRow } from '../../types.js'
import type { RecordingConfigsState } from '../config-store.js'
import {
  buildPlaybackManifest,
  buildRecordingProvider,
  collectRangeSegments,
  oversizeFragmentLogMeta,
  type RecordingProviderDeps,
} from '../recording-provider.js'
import { buildRecordingSourceProvider } from '../recording-source-provider.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'
import { makeConfigsState } from './configs-state-fixture.js'

/** No-op logger satisfying the scoped-logger surface the provider closes over. */
const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

/** A segment row on the default `loc-a` location with a deterministic path. */
function seg(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    deviceId: 99,
    profile: 'mid',
    startMs: 1_000,
    durMs: 4_000,
    bytes: 2_048,
    path: '99/mid/2026/06/15/08/1000-4000-2048.m4s',
    locationId: 'loc-a',
    ...over,
  }
}

interface Harness {
  readonly deps: RecordingProviderDeps
  readonly index: RecordingIndex
  readonly readFile: ReturnType<typeof vi.fn>
}

/** Build a provider over a real RecordingIndex + fake readFile + fixed locations. */
function harness(
  opts: {
    segments?: readonly SegmentRow[]
    locations?: readonly RecordingsLocation[]
    fileBytes?: Uint8Array
  } = {},
): Harness {
  const index = new RecordingIndex()
  for (const s of opts.segments ?? []) index.addSegment(s)

  const locations = opts.locations ?? [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/recordings/a' }, 'active'),
  ]
  const readFile = vi.fn(async () => opts.fileBytes ?? new Uint8Array([1, 2, 3, 4]))

  const deps: RecordingProviderDeps = {
    index,
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    readFile,
  }
  return { deps, index, readFile }
}

// ── getPlaybackManifest CODECS probe ─────────────────────────────────────────
// A minimal fMP4 moov with a hev1/hvcC sample entry — enough for the codec
// probe to derive `hev1.1.6.L93.B0` (same fixture recipe as codec-probe.spec).
function isoBox(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let off = 8
  for (const p of payload) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function hevcFragmentBytes(): Uint8Array {
  const hvcC = new Uint8Array(23)
  hvcC[0] = 1
  hvcC[1] = 0x01 // profile_space 0, tier 0, profile_idc 1 (Main)
  new DataView(hvcC.buffer).setUint32(2, 0x60000000) // compat → reversed "6"
  hvcC[6] = 0xb0 // first constraint byte
  hvcC[12] = 93 // level 3.1
  const entry = isoBox('hev1', new Uint8Array(78), isoBox('hvcC', hvcC))
  const stsdHead = new Uint8Array(8)
  new DataView(stsdHead.buffer).setUint32(4, 1)
  const stsd = isoBox('stsd', stsdHead, entry)
  const moov = isoBox('moov', isoBox('trak', isoBox('mdia', isoBox('minf', isoBox('stbl', stsd)))))
  const out = new Uint8Array(moov.length + 8)
  out.set(isoBox('ftyp'), 0)
  out.set(moov, 8)
  return out
}

interface ManifestHarness {
  readonly deps: RecordingProviderDeps
  readonly tmp: string
  readonly masterPath: string
}

const manifestTmpDirs: string[] = []
afterEach(async () => {
  for (const dir of manifestTmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Real-fs harness: one on-disk HEVC segment + a served playback base URL. */
async function manifestHarness(segmentBytes: Uint8Array): Promise<ManifestHarness> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-prov-manifest-'))
  manifestTmpDirs.push(tmp)
  const root = path.join(tmp, 'loc')
  const dataDir = path.join(tmp, 'data')
  const relPath = segmentRelPath(99, 'high', 1_000, 4_000, segmentBytes.length)
  const absSeg = path.join(root, relPath)
  await fs.mkdir(path.dirname(absSeg), { recursive: true })
  await fs.writeFile(absSeg, segmentBytes)

  const index = new RecordingIndex()
  index.addSegment(
    seg({
      profile: 'high',
      startMs: 1_000,
      durMs: 4_000,
      bytes: segmentBytes.length,
      path: relPath,
      locationId: 'loc-a',
    }),
  )
  const locations: RecordingsLocation[] = [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root }, 'active'),
  ]
  const deps: RecordingProviderDeps = {
    index,
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir,
    playbackBaseUrl: () => '/addon/recorder/playback',
  }
  return { deps, tmp, masterPath: path.join(dataDir, 'playback', '99', 'master.m3u8') }
}

describe('buildRecordingSourceProvider — getPlayback CODECS', () => {
  const OURS = { provider: 'recorder' } as const

  it('probes the first present fragment and advertises CODECS in the master playlist', async () => {
    const h = await manifestHarness(hevcFragmentBytes())
    const provider = buildRecordingSourceProvider(h.deps)

    const playback = await provider.getPlayback({ deviceId: 99, ...OURS, fromMs: 0, toMs: 10_000 })

    expect(playback.kind).toBe('hls')
    expect(playback.kind === 'hls' && playback.manifest.playbackUrl).not.toBeNull()
    const master = await fs.readFile(h.masterPath, 'utf8')
    expect(master).toContain('CODECS="hev1.1.6.L93.B0"')
  })

  it('caches the probe per (device, profile) — one prefix read across manifests', async () => {
    const h = await manifestHarness(hevcFragmentBytes())
    const readFilePrefix = vi.fn(async () => hevcFragmentBytes())
    const provider = buildRecordingSourceProvider({ ...h.deps, readFilePrefix })

    await provider.getPlayback({ deviceId: 99, ...OURS, fromMs: 0, toMs: 10_000 })
    await provider.getPlayback({ deviceId: 99, ...OURS, fromMs: 0, toMs: 10_000 })

    expect(readFilePrefix).toHaveBeenCalledTimes(1)
    const master = await fs.readFile(h.masterPath, 'utf8')
    expect(master).toContain('CODECS="hev1.1.6.L93.B0"')
  })

  it('omits CODECS (playlist still builds) when the fragment is unparseable', async () => {
    const h = await manifestHarness(new Uint8Array([9, 9, 9, 9]))
    const provider = buildRecordingSourceProvider(h.deps)

    const playback = await provider.getPlayback({ deviceId: 99, ...OURS, fromMs: 0, toMs: 10_000 })

    expect(playback.kind === 'hls' && playback.manifest.playbackUrl).not.toBeNull()
    const master = await fs.readFile(h.masterPath, 'utf8')
    expect(master).not.toContain('CODECS')
    expect(master).toContain('high.m3u8')
  })
})

describe('buildRecordingProvider — locateSegment', () => {
  it('hydrates the target window before answering from a cold index', async () => {
    const { deps } = harness()
    const hydrateWindow = vi.fn(async () => {
      deps.index.addSegment(seg())
    })
    const provider = buildRecordingProvider({ ...deps, hydrateWindow })

    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 2_500 })

    expect(hydrateWindow).toHaveBeenCalledWith(99, 0, 62_500)
    expect(res).toEqual({ kind: 'segment', startMs: 1_000, durMs: 4_000, bytes: 2_048 })
  })

  it('does not readdir when RAM already covers the instant — the live hour is never marked hydrated', async () => {
    // Live 2026-08-22: scrub on 104/low timed out because locateSegment always
    // called hydrateWindow (FUSE readdir) when hydrationOf !== 'hydrated', even
    // though addSegment had already indexed the covering fragment. Calendar
    // polls queued on the same share and the 8 s feeder budget expired.
    const { deps } = harness({ segments: [seg()] })
    const hydrateWindow = vi.fn()
    const provider = buildRecordingProvider({ ...deps, hydrateWindow })

    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 2_500 })

    expect(hydrateWindow).not.toHaveBeenCalled()
    expect(res).toEqual({ kind: 'segment', startMs: 1_000, durMs: 4_000, bytes: 2_048 })
  })

  it('returns kind:segment with startMs/durMs/bytes when a covering segment exists', async () => {
    const { deps } = harness({ segments: [seg()] })
    const provider = buildRecordingProvider(deps)

    // epochMs falls inside [1000, 5000)
    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 2_500 })

    expect(res).toEqual({ kind: 'segment', startMs: 1_000, durMs: 4_000, bytes: 2_048 })
  })

  it('returns kind:gap with the forward nearest edge when epochMs falls in a gap', async () => {
    // footage at [10_000, 14_000); query before it → forward edge is 10_000.
    const { deps } = harness({ segments: [seg({ startMs: 10_000 })] })
    const provider = buildRecordingProvider(deps)

    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 5_000 })

    // No footage ends at-or-before 5_000 → prevEndMs null.
    expect(res).toEqual({ kind: 'gap', nearestEdgeMs: 10_000, prevEndMs: null })
  })

  it('returns kind:gap with nearestEdgeMs null past the end of footage', async () => {
    const { deps } = harness({ segments: [seg()] })
    const provider = buildRecordingProvider(deps)

    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 1_000_000 })

    // Backward edge = end of the only segment [1_000, 5_000).
    expect(res).toEqual({ kind: 'gap', nearestEdgeMs: null, prevEndMs: 5_000 })
  })

  it('a crack between segments reports BOTH edges (backward hop for frame-step)', async () => {
    // Real recorder output: durMs under-covers the span to the next startMs —
    // [1_000, 5_000) then [5_017, 9_017) leaves the crack [5_000, 5_017).
    const { deps } = harness({
      segments: [seg(), seg({ startMs: 5_017, path: '99/mid/2026/06/15/08/5017-4000-2048.m4s' })],
    })
    const provider = buildRecordingProvider(deps)

    const res = await provider.locateSegment({ deviceId: 99, profile: 'mid', epochMs: 5_016 })

    expect(res).toEqual({ kind: 'gap', nearestEdgeMs: 5_017, prevEndMs: 5_000 })
  })
})

describe('buildRecordingProvider — readSegmentBytes', () => {
  it('resolves the absolute path from the location root and returns the file bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const { deps, readFile } = harness({ segments: [seg()], fileBytes: bytes })
    const provider = buildRecordingProvider(deps)

    const res = await provider.readSegmentBytes({ deviceId: 99, profile: 'mid', startMs: 1_000 })

    expect(readFile).toHaveBeenCalledWith('/recordings/a/99/mid/2026/06/15/08/1000-4000-2048.m4s')
    expect(res).toEqual({ data: bytes })
  })

  it('wraps a non-Uint8Array Buffer result as a Uint8Array', async () => {
    const { deps } = harness({ segments: [seg()], fileBytes: Buffer.from([5, 6]) })
    const provider = buildRecordingProvider(deps)

    const res = await provider.readSegmentBytes({ deviceId: 99, profile: 'mid', startMs: 1_000 })

    expect(res.data).toBeInstanceOf(Uint8Array)
    expect([...res.data]).toEqual([5, 6])
  })

  it('throws when no segment matches the exact startMs', async () => {
    const { deps } = harness({ segments: [seg()] })
    const provider = buildRecordingProvider(deps)

    await expect(
      provider.readSegmentBytes({ deviceId: 99, profile: 'mid', startMs: 999 }),
    ).rejects.toThrow(/no segment at start 999/)
  })

  it('throws when the segment location root is unknown', async () => {
    const { deps } = harness({
      segments: [seg({ locationId: 'gone' })],
      locations: [
        recordingsLocationOfMode(
          { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
          'active',
        ),
      ],
    })
    const provider = buildRecordingProvider(deps)

    await expect(
      provider.readSegmentBytes({ deviceId: 99, profile: 'mid', startMs: 1_000 }),
    ).rejects.toThrow(/unknown location gone/)
  })
})

describe('buildRecordingProvider — readGopBytes (D31 byte-range on the feeder path)', () => {
  const FIXTURE = path.join(
    __dirname,
    '../../../stream-broker/recorded/__tests__/fixtures/sample.m4s',
  )

  /** Ranged reader over the real fixture, recording every read. */
  async function fixtureRange() {
    const bytes = new Uint8Array(await fs.readFile(FIXTURE))
    const reads: Array<{ offset: number; length: number }> = []
    const openRangeReadable = vi.fn(async (_abs: string, size: number) => ({
      size,
      read: async (offset: number, length: number) => {
        reads.push({ offset, length })
        return bytes.subarray(offset, offset + length)
      },
      close: async () => {},
    }))
    return { bytes, reads, openRangeReadable }
  }

  it('serves the covering GOP by byte range — never the whole file', async () => {
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const { deps, readFile } = harness({ segments: [row] })
    const provider = buildRecordingProvider({ ...deps, openRangeReadable: fx.openRangeReadable })

    const res = await provider.readGopBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      epochMs: 4_950, // inside the fixture's SECOND fragment (starts 3 914 ms in)
    })

    expect(res.gopStartMs).toBe(4_914) // 1 000 + 3 914
    expect(res.data.length).toBeLessThan(fx.bytes.length / 10)
    const total = fx.reads.reduce((n, r) => n + r.length, 0)
    expect(total).toBeLessThan(fx.bytes.length) // the byte-range property
    expect(readFile).not.toHaveBeenCalled() // no whole-file read behind it
  })

  it('degrades INSIDE the mechanism to the whole segment when the index will not parse — and logs it', async () => {
    const junk = new Uint8Array(4_096).fill(7)
    const warned: string[] = []
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warned.push(msg),
      error: () => {},
    } as unknown as IScopedLogger
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: junk.length })
    const { deps } = harness({ segments: [row], fileBytes: junk })
    const openRangeReadable = vi.fn(async (_abs: string, size: number) => ({
      size,
      read: async (offset: number, length: number) => junk.subarray(offset, offset + length),
      close: async () => {},
    }))
    const provider = buildRecordingProvider({ ...deps, logger, openRangeReadable })

    const res = await provider.readGopBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      epochMs: 2_000,
    })

    expect(res.gopStartMs).toBe(1_000) // whole-segment window
    expect(res.gopDurMs).toBe(4_000)
    expect([...res.data]).toEqual([...junk])
    expect(warned.some((m) => m.includes('fell back to the WHOLE segment'))).toBe(true)
  })

  it('serves a widened window covering both fixture fragments in one range read', async () => {
    // segments-60s Task 1: a byte budget over `tfra` converts to a SET of
    // fragments — the fixture's two fragments (86 295 B + 882 B) both fit
    // comfortably under SCRUB_GOP_BUDGET_MAX_BYTES (1.5 MB), so the handler
    // must return the WHOLE segment's worth of AUs from ONE range read, not
    // just the fragment covering epochMs.
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const { deps } = harness({ segments: [row] })
    const provider = buildRecordingProvider({ ...deps, openRangeReadable: fx.openRangeReadable })

    const res = await provider.readGopBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      epochMs: 1_200, // inside the FIRST fragment
    })

    expect(res.gopStartMs).toBe(1_000)
    expect(res.gopDurMs).toBe(4_000) // fragment 1 + fragment 2, the whole window
  })
})

describe('buildRecordingProvider — readWindowBytes (the replay clip window read)', () => {
  const FIXTURE = path.join(
    __dirname,
    '../../../stream-broker/recorded/__tests__/fixtures/sample.m4s',
  )

  /** Ranged reader over the real fixture, recording every read. */
  async function fixtureRange() {
    const bytes = new Uint8Array(await fs.readFile(FIXTURE))
    const reads: Array<{ offset: number; length: number }> = []
    const openRangeReadable = vi.fn(async (_abs: string, size: number) => ({
      size,
      read: async (offset: number, length: number) => {
        reads.push({ offset, length })
        return bytes.subarray(offset, offset + length)
      },
      close: async () => {},
    }))
    return { bytes, reads, openRangeReadable }
  }

  it('serves a window fully inside fragment 1, by byte range, in one contiguous read', async () => {
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const { deps, readFile } = harness({ segments: [row] })
    const provider = buildRecordingProvider({ ...deps, openRangeReadable: fx.openRangeReadable })

    const res = await provider.readWindowBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      fromMs: 1_200, // 200ms into the segment — inside fragment 1
      toMs: 2_200, // 1200ms into the segment — still inside fragment 1 (ends at 3914)
    })

    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(res.gopStartMs).toBe(1_000)
    expect(res.gopDurMs).toBe(3_914)
    expect(res.reachesRequestedEnd).toBe(true)
    expect(readFile).not.toHaveBeenCalled() // no whole-file read behind it
  })

  it('serves a window fully inside fragment 2 (the small one) — never touches fragment 1s mdat', async () => {
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const { deps } = harness({ segments: [row] })
    const provider = buildRecordingProvider({ ...deps, openRangeReadable: fx.openRangeReadable })

    const res = await provider.readWindowBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      fromMs: 4_950, // 3950ms — inside fragment 2 (starts at 3914ms)
      toMs: 4_999,
    })

    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(res.gopStartMs).toBe(4_914) // 1_000 + 3_914
    expect(res.gopDurMs).toBe(86)
    // THE byte-range property: fragment 1 spans most of the 88.7 KB file.
    // Serving only fragment 2 must not have read it.
    const total = fx.reads.reduce((n, r) => n + r.length, 0)
    expect(total).toBeLessThan(6_000) // tail + head + the 882-byte fragment
  })

  it('serves a window spanning both fragments in ONE contiguous range read', async () => {
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const { deps } = harness({ segments: [row] })
    const provider = buildRecordingProvider({ ...deps, openRangeReadable: fx.openRangeReadable })

    const res = await provider.readWindowBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      fromMs: 1_200,
      toMs: 4_999, // 3999ms into the segment — needs fragment 2 too
    })

    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(res.gopStartMs).toBe(1_000)
    expect(res.gopDurMs).toBe(4_000)
    expect(res.reachesRequestedEnd).toBe(true)
  })

  it('REFUSES a window that runs past the covering segment — never splices a second segment file', async () => {
    const fx = await fixtureRange()
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: fx.bytes.length })
    const warned: Array<{ msg: string; meta?: Record<string, unknown> }> = []
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, extras?: LogExtras) =>
        warned.push({ msg, meta: extras?.meta as Record<string, unknown> | undefined }),
      error: () => {},
    } as unknown as IScopedLogger
    const { deps } = harness({ segments: [row] })
    const provider = buildRecordingProvider({
      ...deps,
      logger,
      openRangeReadable: fx.openRangeReadable,
    })

    const res = await provider.readWindowBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      fromMs: 1_200,
      toMs: 6_000, // past the segment's own end (1_000 + 4_000 = 5_000)
    })

    expect(res).toEqual({ kind: 'spans-multiple-segments', segmentEndMs: 5_000 })
    expect(warned.some((w) => w.msg.includes('window runs past this segment'))).toBe(true)
  })

  it('degrades INSIDE the mechanism to the whole segment when the index will not parse — and logs it', async () => {
    const junk = new Uint8Array(4_096).fill(7)
    const warned: string[] = []
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warned.push(msg),
      error: () => {},
    } as unknown as IScopedLogger
    const row = seg({ startMs: 1_000, durMs: 4_000, bytes: junk.length })
    const { deps } = harness({ segments: [row], fileBytes: junk })
    const openRangeReadable = vi.fn(async (_abs: string, size: number) => ({
      size,
      read: async (offset: number, length: number) => junk.subarray(offset, offset + length),
      close: async () => {},
    }))
    const provider = buildRecordingProvider({ ...deps, logger, openRangeReadable })

    const res = await provider.readWindowBytes({
      deviceId: 99,
      profile: 'mid',
      startMs: 1_000,
      fromMs: 1_200,
      toMs: 2_000,
    })

    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('expected ok')
    expect(res.gopStartMs).toBe(1_000) // whole-segment window
    expect(res.gopDurMs).toBe(4_000)
    expect(res.reachesRequestedEnd).toBe(true)
    expect([...res.data]).toEqual([...junk])
    expect(warned.some((m) => m.includes('fell back to the WHOLE segment'))).toBe(true)
  })
})

describe('oversizeFragmentLogMeta — the single-fragment budget overshoot', () => {
  it('is null when the fragment fit the budget', () => {
    const meta = oversizeFragmentLogMeta(
      { oversizeFragment: false, data: new Uint8Array(10) },
      { profile: 'low', startMs: 1_000, epochMs: 1_200 },
    )
    expect(meta).toBeNull()
  })

  it('carries the fragment size and the ceiling when one fragment alone exceeds it — never null there', () => {
    const bigFragment = new Uint8Array(4_800_000)
    const meta = oversizeFragmentLogMeta(
      { oversizeFragment: true, data: bigFragment },
      { profile: 'low', startMs: 1_000, epochMs: 1_200 },
    )
    expect(meta).not.toBeNull()
    expect(meta).toMatchObject({
      profile: 'low',
      startMs: 1_000,
      epochMs: 1_200,
      fragmentBytes: 4_800_000,
      maxBytes: 1_500_000,
    })
  })
})

describe('buildRecordingSourceProvider — getDaysWithRecordings', () => {
  it('returns sorted distinct local-day epochs for in-range segment starts', async () => {
    const day15 = Date.UTC(2026, 5, 15, 8, 0, 0)
    const day15b = Date.UTC(2026, 5, 15, 20, 0, 0)
    const day16 = Date.UTC(2026, 5, 16, 1, 0, 0)
    const { deps } = harness({
      segments: [
        seg({ startMs: day15, path: '99/mid/d/15a.m4s' }),
        seg({ startMs: day15b, path: '99/mid/d/15b.m4s' }),
        seg({ startMs: day16, path: '99/mid/d/16a.m4s' }),
      ],
    })
    const provider = buildRecordingSourceProvider(deps)

    const res = await provider.getDaysWithRecordings({
      deviceId: 99,
      provider: 'recorder',
      fromMs: Date.UTC(2026, 5, 1, 0, 0, 0),
      toMs: Date.UTC(2026, 5, 30, 0, 0, 0),
      tzOffsetMinutes: 0,
    })

    expect(res).toEqual({
      deviceId: 99,
      // The answer SAYS it looked — an empty `days` beside `read: 'read'` is a
      // claim, and beside `'unreadable'` it is not one (D625 §10.4).
      read: 'read',
      days: [Date.UTC(2026, 5, 15, 0, 0, 0), Date.UTC(2026, 5, 16, 0, 0, 0)],
    })
  })

  it('returns empty days for a device with no footage', async () => {
    const { deps } = harness({ segments: [] })
    const provider = buildRecordingSourceProvider(deps)

    const res = await provider.getDaysWithRecordings({
      deviceId: 99,
      provider: 'recorder',
      fromMs: 0,
      toMs: Date.now(),
      tzOffsetMinutes: 0,
    })

    expect(res).toEqual({ deviceId: 99, read: 'read', days: [] })
  })
})

// ── deleteFootprint + ops-log ────────────────────────────────────────────────

import type { OpsLogEntry } from '@camstack/types'
import type { RecordingOpsLogAppendInput, RecordingOpsLogSink } from '../ops-log-store.js'

/** Capturing ops-log sink — records appends + serves a fixed list. */
function captureOpsLog(): {
  sink: RecordingOpsLogSink
  appends: RecordingOpsLogAppendInput[]
} {
  const appends: RecordingOpsLogAppendInput[] = []
  const sink: RecordingOpsLogSink = {
    append: async (input) => {
      appends.push(input)
    },
    list: async (): Promise<readonly OpsLogEntry[]> => [],
  }
  return { sink, appends }
}

/** Build a provider whose SegmentStore.evict removes the victim rows from the
 *  real index and reports their summed bytes (mirrors production evict). */
function footprintHarness(segments: readonly SegmentRow[]): {
  provider: ReturnType<typeof buildRecordingProvider>
  appends: RecordingOpsLogAppendInput[]
  index: RecordingIndex
} {
  const index = new RecordingIndex()
  for (const s of segments) index.addSegment(s)
  const segmentStore = {
    evict: async (_location: string, rows: readonly SegmentRow[]): Promise<number> => {
      // Production evict removes by segment PATH (parsed back to device/start);
      // mirror that so the index actually drops the victims.
      index.removeSegments(rows.map((r) => r.path))
      return rows.reduce((n, r) => n + r.bytes, 0)
    },
  } as unknown as SegmentStore
  const { sink, appends } = captureOpsLog()
  const deps: RecordingProviderDeps = {
    index,
    segmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [
      recordingsLocationOfMode(
        { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
        'active',
      ),
    ],
    refreshLocations: async () => [
      recordingsLocationOfMode(
        { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
        'active',
      ),
    ],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    opsLog: sink,
  }
  return { provider: buildRecordingProvider(deps), appends, index }
}

describe('buildRecordingProvider — deleteFootprint', () => {
  const mkSeg = (startMs: number, durMs: number, bytes: number): SegmentRow =>
    seg({ startMs, durMs, bytes, path: segmentRelPath(99, 'mid', startMs, durMs, bytes) })
  const rows: readonly SegmentRow[] = [
    mkSeg(0, 1_000, 100),
    mkSeg(5_000, 1_000, 200),
    mkSeg(10_000, 1_000, 400),
  ]

  it('deletes the WHOLE footprint when no window is given', async () => {
    const { provider, appends, index } = footprintHarness(rows)
    const res = await provider.deleteFootprint({ deviceId: 99 })

    expect(res).toEqual({ deletedBuckets: 3, reclaimedBytes: 700 })
    expect(index.segments(99)).toHaveLength(0)
    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({
      op: 'manual-delete',
      reason: 'manual',
      deviceId: 99,
      itemsAffected: 3,
      bytesReclaimed: 700,
    })
    expect(appends[0]?.detail).toBe('deleted all footage')
  })

  it('deletes only segments overlapping [fromMs, toMs)', async () => {
    const { provider, appends, index } = footprintHarness(rows)
    // Window [4500, 6500) overlaps only the middle segment [5000,6000).
    const res = await provider.deleteFootprint({ deviceId: 99, fromMs: 4_500, toMs: 6_500 })

    expect(res).toEqual({ deletedBuckets: 1, reclaimedBytes: 200 })
    expect(index.segments(99).map((s) => s.startMs)).toEqual([0, 10_000])
    expect(appends[0]).toMatchObject({ op: 'manual-delete', reason: 'manual', itemsAffected: 1 })
  })

  it('treats a boundary-touching segment as non-overlapping (half-open window)', async () => {
    const { provider, index } = footprintHarness(rows)
    // Window [1000, 5000): segment a ends AT 1000 (exclusive), b starts AT 5000.
    const res = await provider.deleteFootprint({ deviceId: 99, fromMs: 1_000, toMs: 5_000 })

    expect(res).toEqual({ deletedBuckets: 0, reclaimedBytes: 0 })
    expect(index.segments(99)).toHaveLength(3)
  })

  it('deletes from a fromMs to the end when toMs is omitted', async () => {
    const { provider, index } = footprintHarness(rows)
    const res = await provider.deleteFootprint({ deviceId: 99, fromMs: 5_000 })

    expect(res).toEqual({ deletedBuckets: 2, reclaimedBytes: 600 })
    expect(index.segments(99).map((s) => s.startMs)).toEqual([0])
  })
})

describe('collectRangeSegments — the segment list comes from RAM, not from disk', () => {
  /**
   * The in-memory `RecordingIndex` already holds every segment a device has:
   * start, duration, bytes and path, kept write-through on finalize AND on
   * evict (`SegmentStore.evict` deletes the file and then calls
   * `index.removeSegments`). So the rows are already authoritative.
   *
   * The per-segment `stat` on top of them was guarding a window at most one
   * eviction pass wide — and it cost ONE SYSCALL PER SEGMENT. On a camera-day
   * (~2,700 low segments) on a contended array that measured ~4 seconds, and
   * it sat on the critical path of the first scrub: while it ran, every cursor
   * position waited on it and was superseded before it could paint, so a drag
   * painted nothing at all.
   *
   * The trade is the wrong way round. A segment deleted between the index and
   * the read yields a 404 on that ONE segment, which the byte-range reader
   * already surfaces and can move past; the stat storm was a guaranteed
   * multi-second stall on EVERY request. The stats now stop as soon as one
   * present file is found — the codec probe needs exactly one.
   */
  function statCountingHarness(segmentCount: number): {
    deps: RecordingProviderDeps
    stats: string[]
  } {
    const index = new RecordingIndex()
    for (let i = 0; i < segmentCount; i++) {
      index.addSegment({
        deviceId: 7,
        profile: 'low',
        startMs: 1_000_000 + i * 8000,
        durMs: 8000,
        bytes: 50_000,
        path: `7/low/2026/07/29/00/${1_000_000 + i * 8000}-8000-50000.m4s`,
        locationId: 'loc-a',
      })
    }
    const stats: string[] = []
    const deps = {
      index,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
      statFile: async (abs: string) => {
        stats.push(abs)
        return {}
      },
    } as unknown as RecordingProviderDeps
    return { deps, stats }
  }

  it('does not stat every segment', async () => {
    const h = statCountingHarness(500)
    // 'playback-relative' is the PLAYBACK path. 'absolute' is export, which
    // must keep verifying every file — ffmpeg dies on the first missing one.
    const out = await collectRangeSegments(
      h.deps,
      7,
      'low',
      0,
      Number.MAX_SAFE_INTEGER,
      'playback-relative',
    )
    expect(out.segments).toHaveLength(500)
    // One present file answers the codec probe; the other 499 are already known.
    expect(h.stats.length).toBeLessThanOrEqual(4)
  })

  it('still finds a file for the codec probe', async () => {
    const h = statCountingHarness(10)
    const out = await collectRangeSegments(
      h.deps,
      7,
      'low',
      0,
      Number.MAX_SAFE_INTEGER,
      'playback-relative',
    )
    expect(out.firstPresentAbs).not.toBeNull()
  })

  it('gives up the probe after a bounded scan when the files are gone', async () => {
    // A device whose rows outlive its files must not turn into a stat storm of
    // its own — that is the failure this replaced.
    const index = new RecordingIndex()
    for (let i = 0; i < 300; i++) {
      index.addSegment({
        deviceId: 7,
        profile: 'low',
        startMs: 1_000_000 + i * 8000,
        durMs: 8000,
        bytes: 50_000,
        path: `7/low/2026/07/29/00/${1_000_000 + i * 8000}-8000-50000.m4s`,
        locationId: 'loc-a',
      })
    }
    let stats = 0
    const deps = {
      index,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
      statFile: async () => {
        stats++
        throw new Error('ENOENT')
      },
    } as unknown as RecordingProviderDeps
    const out = await collectRangeSegments(
      deps,
      7,
      'low',
      0,
      Number.MAX_SAFE_INTEGER,
      'playback-relative',
    )
    expect(stats).toBeLessThanOrEqual(8)
    expect(out.firstPresentAbs).toBeNull()
  })
})

describe('collectRangeSegments — walks the window it was asked about', () => {
  /**
   * The archive-wide hydrate takes MINUTES (>1M files). Reading past footage
   * during that time saw an empty index, and the server reported "no footage" —
   * so the timeline drew a gap over recordings that exist. Measured after a
   * deploy: a camera-day held 7 segments and grew only at the rate of NEW
   * writes for ~9 minutes.
   *
   * A read must therefore walk the hours it needs, and only those.
   */
  function harness(): {
    deps: RecordingProviderDeps
    index: RecordingIndex
    windows: Array<{ fromMs: number; toMs: number }>
  } {
    const index = new RecordingIndex()
    const windows: Array<{ fromMs: number; toMs: number }> = []
    const deps = {
      index,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
      statFile: async () => ({}),
      hydrateWindow: async (deviceId: number, fromMs: number, toMs: number) => {
        windows.push({ fromMs, toMs })
        // Stand-in for the real walk: one segment appears, hour marked walked.
        index.hydrateHour(deviceId, 'loc-a', fromMs, [
          `7/low/2026/07/29/00/${fromMs + 1000}-8000-50000.m4s`,
        ])
      },
    } as unknown as RecordingProviderDeps
    return { deps, index, windows }
  }

  it('hydrates the requested window before answering', async () => {
    const h = harness()
    const out = await collectRangeSegments(h.deps, 7, 'low', 0, 3_600_000, 'playback-relative')
    expect(h.windows).toEqual([{ fromMs: 0, toMs: 3_600_000 }])
    expect(out.segments).toHaveLength(1)
  })

  it('does not walk again once the window is known', async () => {
    // A drag crosses the same hour many times; the second crossing must cost
    // nothing. This is what makes the walk affordable on the read path at all.
    const h = harness()
    await collectRangeSegments(h.deps, 7, 'low', 0, 3_600_000, 'playback-relative')
    h.index.markHydrated(7, 0, 3_600_000)
    await collectRangeSegments(h.deps, 7, 'low', 0, 3_600_000, 'playback-relative')
    expect(h.windows).toHaveLength(1)
  })

  it('reports whether the answer is trustworthy', async () => {
    // An empty result under `unknown` means "not looked at yet" and must never
    // be presented as "no footage".
    const index = new RecordingIndex()
    const deps = {
      index,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
      statFile: async () => ({}),
    } as unknown as RecordingProviderDeps
    const out = await collectRangeSegments(deps, 7, 'low', 0, 3_600_000, 'playback-relative')
    expect(out.segments).toHaveLength(0)
    expect(out.hydration).toBe('unknown')
  })
})

/**
 * The window boundary, at the CALL SITE.
 *
 * `collectRangeSegments` stopped copying the device archive, filtering it and
 * re-sorting it per call; it now slices the live sorted view. The slice has to
 * start EARLIER than the `fromMs` lower bound, because the segment an operator
 * is watching at `fromMs` started before it — and getting that wrong truncates
 * the first segment of every playback window without failing anything: the
 * clip still plays, it just begins late. So the two edges are pinned here on
 * the real provider path, not only on the index primitive.
 */
describe('collectRangeSegments — the window edges the slice must keep', () => {
  function edgeHarness(segments: readonly SegmentRow[]): RecordingProviderDeps {
    const index = new RecordingIndex()
    for (const s of segments) index.addSegment(s)
    // Every hour the fixture's segments live in, marked walked. (Was
    // `markHydratedAll`, deleted with the whole-device claim in D524.)
    for (const s of segments) index.markHydrated(7, s.startMs, s.startMs + s.durMs)
    const deps: RecordingProviderDeps = {
      index,
      segmentStore: {} as unknown as SegmentStore,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [
        recordingsLocationOfMode(
          { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
          'active',
        ),
      ],
      refreshLocations: async () => [
        recordingsLocationOfMode(
          { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
          'active',
        ),
      ],
      capacity: async () => ({ availableBytes: null, totalBytes: null }),
      hydrateDevice: async () => {},
      dataDir: '/data',
      playbackBaseUrl: () => null,
      statFile: async () => ({}),
    }
    return deps
  }

  const lowSeg = (startMs: number, durMs: number): SegmentRow => ({
    deviceId: 7,
    profile: 'low',
    startMs,
    durMs,
    bytes: 50_000,
    path: segmentRelPath(7, 'low', startMs, durMs, 50_000),
    locationId: 'loc-a',
  })

  it('keeps a segment straddling fromMs and drops one ending exactly at it', async () => {
    const deps = edgeHarness([
      lowSeg(40_000, 10_000), // [40k, 50k) — ends EXACTLY at fromMs: out
      lowSeg(45_000, 10_000), // [45k, 55k) — straddles fromMs: in
      lowSeg(60_000, 10_000), // fully inside: in
      lowSeg(70_000, 10_000), // starts EXACTLY at toMs: out
    ])
    const out = await collectRangeSegments(deps, 7, 'low', 50_000, 70_000, 'playback-relative')
    expect(out.segments.map((s) => s.startMs)).toEqual([45_000, 60_000])
  })

  it('keeps EVERY straddling predecessor, not just the nearest one', async () => {
    // A restart re-records an interval, so more than one earlier row can still
    // cover `fromMs`. "Slice one element earlier" would drop the outer one.
    const deps = edgeHarness([
      lowSeg(10_000, 120_000), // [10k, 130k)
      lowSeg(20_000, 2_000), // [20k, 22k) — irrelevant, and in between
      lowSeg(40_000, 90_000), // [40k, 130k)
      lowSeg(105_000, 10_000),
    ])
    const out = await collectRangeSegments(deps, 7, 'low', 100_000, 110_000, 'playback-relative')
    expect(out.segments.map((s) => s.startMs)).toEqual([10_000, 40_000, 105_000])
  })
})

// ── Operator-armed rebalance + the Oldest-footage column (D116, Phase 2) ─────

/** A provider wired to a real index, a fake placement snapshot and a relocate
 *  engine reduced to "what did you get asked to move". */
function rebalanceHarness(opts: {
  segments: readonly SegmentRow[]
  assignments: ReadonlyMap<string, string>
  headroom: readonly { locationId: string; headroomBytes: number }[]
  withRelocate?: boolean
}): {
  readonly deps: RecordingProviderDeps
  readonly started: RelocateFootageInput[]
} {
  const index = new RecordingIndex()
  for (const s of opts.segments) index.addSegment(s)
  const started: RelocateFootageInput[] = []
  const relocate = {
    start: (input: RelocateFootageInput): string => {
      started.push(input)
      return `job-${started.length}`
    },
    list: (): readonly never[] => [],
    cancel: (): boolean => false,
  } as unknown as RelocateEngine

  const deps: RecordingProviderDeps = {
    index,
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: '/mnt/ssd' },
        'active',
      ),
      recordingsLocationOfMode(
        { id: 'recordings:nas', type: 'recordings', root: '/mnt/nas' },
        'active',
      ),
    ],
    refreshLocations: async () => [],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    placementSnapshot: async () => ({
      assignments: opts.assignments,
      headroom: opts.headroom,
    }),
    // A stand-in hour ledger over the SAME fixture rows (D418). These tests are
    // about membership and capacity, so index and archive agree here on
    // purpose; the lopsided fixture that pins the archive-vs-residency licence
    // lives in `storage-usage-residency-licence.spec.ts`.
    archiveDeviceUsage: archiveUsageOf(opts.segments),
    ...(opts.withRelocate === false ? {} : { relocate }),
  }
  return { deps, started }
}

/** The fixture's segments folded per camera, the way
 *  `SegmentHourLedger.usageByDevice` folds its hour rows. */
function archiveUsageOf(
  segments: readonly SegmentRow[],
): (locationIds: ReadonlySet<string>) => ReadonlyMap<number, ArchiveDeviceUsage> {
  return (locationIds): ReadonlyMap<number, ArchiveDeviceUsage> => {
    const out = new Map<number, ArchiveDeviceUsage>()
    for (const s of segments) {
      if (!locationIds.has(s.locationId)) continue
      const prev = out.get(s.deviceId)
      out.set(s.deviceId, {
        bytes: (prev?.bytes ?? 0) + s.bytes,
        segments: (prev?.segments ?? 0) + 1,
        oldestMs: prev?.oldestMs == null ? s.startMs : Math.min(prev.oldestMs, s.startMs),
        newestMs: prev?.newestMs == null ? s.startMs : Math.max(prev.newestMs, s.startMs),
      })
    }
    return out
  }
}

const GB = 1_000_000_000

/** One pile: `files` segments for (deviceId, profile) on `locationId`. */
function pile(
  deviceId: number,
  profile: string,
  locationId: string,
  gb: number,
  files = 4,
): readonly SegmentRow[] {
  const bytes = Math.floor((gb * GB) / files)
  return Array.from({ length: files }, (_unused, i) => ({
    deviceId,
    profile,
    startMs: 1_000 + i * 4_000,
    durMs: 4_000,
    bytes,
    path: segmentRelPath(deviceId, profile, 1_000 + i * 4_000, 4_000, bytes),
    locationId,
  }))
}

describe('buildRecordingProvider — planStorageRebalance / startStorageRebalance', () => {
  it('plans nothing but reports it: a dry run never enqueues a job', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 50),
      assignments: new Map([['101:high', 'recordings:nas']]),
      headroom: [{ locationId: 'recordings:nas', headroomBytes: 1_000 * GB }],
    })
    const provider = buildRecordingProvider(h.deps)
    const plan = await provider.planStorageRebalance({})
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]).toMatchObject({
      deviceId: 101,
      profile: 'high',
      fromLocationId: 'recordings:default',
      toLocationId: 'recordings:nas',
    })
    expect(plan.jobIds).toEqual([])
    expect(h.started).toEqual([])
  })

  it('arms one relocate job per (camera, profile) pile — device- AND profile-scoped', async () => {
    const h = rebalanceHarness({
      segments: [
        ...pile(101, 'high', 'recordings:default', 50),
        ...pile(101, 'mid', 'recordings:default', 20),
      ],
      assignments: new Map([
        ['101:high', 'recordings:nas'],
        ['101:mid', 'recordings:nas'],
      ]),
      headroom: [{ locationId: 'recordings:nas', headroomBytes: 1_000 * GB }],
    })
    const provider = buildRecordingProvider(h.deps)
    const plan = await provider.startStorageRebalance({ throttleMbps: 10 })
    expect(plan.jobIds).toEqual(['job-1', 'job-2'])
    expect(h.started).toEqual([
      {
        fromLocationId: 'recordings:default',
        toLocationId: 'recordings:nas',
        deviceId: 101,
        profiles: ['high'],
        throttleMbps: 10,
      },
      {
        fromLocationId: 'recordings:default',
        toLocationId: 'recordings:nas',
        deviceId: 101,
        profiles: ['mid'],
        throttleMbps: 10,
      },
    ])
  })

  it('reports every refusal instead of quietly moving less', async () => {
    const h = rebalanceHarness({
      segments: [
        ...pile(101, 'high', 'recordings:default', 50),
        // 102 has no assignment at all: it is a refusal, not an omission.
        ...pile(102, 'high', 'recordings:default', 30),
      ],
      assignments: new Map([['101:high', 'recordings:nas']]),
      headroom: [{ locationId: 'recordings:nas', headroomBytes: 1_000 * GB }],
    })
    const provider = buildRecordingProvider(h.deps)
    const plan = await provider.startStorageRebalance({})
    expect(plan.moves.map((m) => m.deviceId)).toEqual([101])
    expect(plan.skipped.map((s) => [s.deviceId, s.reason])).toEqual([[102, 'unassigned']])
  })

  it('refuses to guess when placement is not active on this node', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 50),
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider({ ...h.deps, placementSnapshot: undefined })
    await expect(provider.planStorageRebalance({})).rejects.toThrow(/placement is not active/)
  })
})

describe('buildRecordingProvider — getStorageUsage carries the oldest footage per camera', () => {
  it('reports the oldest ARCHIVED start across every profile and location', async () => {
    const h = rebalanceHarness({
      segments: [
        {
          ...seg({ deviceId: 101, profile: 'high', startMs: 9_000 }),
          locationId: 'recordings:nas',
          path: segmentRelPath(101, 'high', 9_000, 4_000, 2_048),
        },
        {
          ...seg({ deviceId: 101, profile: 'low', startMs: 3_000 }),
          locationId: 'recordings:default',
          path: segmentRelPath(101, 'low', 3_000, 4_000, 2_048),
        },
      ],
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})
    expect(usage.devices).toEqual([
      {
        deviceId: 101,
        usedBytes: 4_096,
        oldestMs: 3_000,
        segments: 2,
        residentBytes: 4_096,
        residentOldestMs: 3_000,
      },
    ])
    expect(usage.devicesRead).toBe('archive')
  })

  /**
   * The device census stopped materialising (and sorting) every row on every
   * disk just to read the deviceIds off them. The MEMBERSHIP rule it replaced
   * has to survive intact, and it has one non-obvious half: footage stranded
   * on a location id that no longer resolves is not listed. Live hub today
   * holds 2 131 such rows on `recordings:high`, a location `listLocations` no
   * longer knows; they were invisible to this page before and must stay so,
   * or the page starts reporting a camera whose bytes no volume row accounts
   * for.
   */
  it('lists exactly the cameras with footage on a RESOLVABLE location, with the same totals', async () => {
    const h = rebalanceHarness({
      segments: [
        ...pile(101, 'high', 'recordings:default', 4, 2),
        ...pile(102, 'low', 'recordings:nas', 2, 2),
        // A camera whose only footage sits on a location id that no longer
        // resolves (the harness serves `:default` and `:nas` only).
        ...pile(619, 'high', 'recordings:ghost', 8, 2),
      ],
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})
    expect(usage.devices.map((d) => d.deviceId)).toEqual([101, 102])
    expect(usage.devices.map((d) => d.usedBytes)).toEqual([4 * GB, 2 * GB])
    expect(usage.totalUsedBytes).toBe(6 * GB)
  })

  /**
   * The per-VOLUME row is the archive's number, not the index's.
   *
   * It used to be `index.accountingForLocations(...)` — a walk over every
   * indexed row of every camera to produce one integer. It is now an
   * aggregation over the durable hour ledger, which also means it is right on a
   * partially-hydrated index. The assertion is that the ASK reached the archive
   * carrying the whole physical-root domain: an index-derived number would be
   * 4 096 here and the archive's is deliberately not.
   */
  it('takes the per-volume total from the archive aggregation, with the whole domain in one ask', async () => {
    const h = rebalanceHarness({
      segments: [
        {
          ...seg({ deviceId: 101, profile: 'high', startMs: 9_000 }),
          locationId: 'recordings:nas',
          path: segmentRelPath(101, 'high', 9_000, 4_000, 2_048),
        },
      ],
      assignments: new Map(),
      headroom: [],
    })
    const asked: string[][] = []
    const provider = buildRecordingProvider({
      ...h.deps,
      archiveAccounting: async (locationIds) => {
        asked.push([...locationIds].toSorted())
        return { bytes: 777_000, count: 3, oldestMs: 1, newestMs: 2 }
      },
    })
    const usage = await provider.getStorageUsage({})
    expect(usage.locations?.map((l) => l.usedBytes)).toEqual([777_000, 777_000])
    expect(asked).toEqual([['recordings:default'], ['recordings:nas']])
  })

  it('reports 0 used per volume — never an index-derived number — when there is no archive', async () => {
    const h = rebalanceHarness({
      segments: [
        {
          ...seg({ deviceId: 101, profile: 'high', startMs: 9_000 }),
          locationId: 'recordings:nas',
          path: segmentRelPath(101, 'high', 9_000, 4_000, 2_048),
        },
      ],
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})
    expect(usage.locations?.map((l) => l.usedBytes)).toEqual([0, 0])
  })
})

/**
 * The capacity half of `getStorageUsage` — the only thing in the payload that
 * can answer "is the volume full?".
 *
 * Two failures are modelled here because both have shipped as silence: a
 * capacity read that fails used to be swallowed by a bare `catch {}` (unknown
 * capacity and a dead NAS looked identical, in the payload AND in the logs),
 * and a single failing volume must never take the rest of the response with it.
 */
describe('buildRecordingProvider — getStorageUsage reports per-volume capacity', () => {
  /** A logger that records warn lines so the failure path can be asserted. */
  function capturingLogger(): {
    readonly logger: IScopedLogger
    readonly warns: { message: string; extras?: LogExtras }[]
  } {
    const warns: { message: string; extras?: LogExtras }[] = []
    const logger: IScopedLogger = {
      debug: () => {},
      info: () => {},
      warn: (message: string, extras?: LogExtras) => {
        warns.push({ message, extras })
      },
      error: () => {},
    } as unknown as IScopedLogger
    return { logger, warns }
  }

  it('carries the volume root and its statfs figures', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 1),
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider({
      ...h.deps,
      capacity: async (root: string) => ({
        availableBytes: root === '/mnt/ssd' ? 100 : 200,
        totalBytes: 1_000,
      }),
    })
    const usage = await provider.getStorageUsage({})
    const volumes = usage.locations ?? []
    const ssd = volumes.find((l) => l.root === '/mnt/ssd')
    expect(ssd).toBeDefined()
    expect(ssd?.availableBytes).toBe(100)
    expect(ssd?.totalBytes).toBe(1_000)
    expect(volumes.find((l) => l.root === '/mnt/nas')?.availableBytes).toBe(200)
  })

  it('a volume that would not answer logs a warn naming it, and reports null capacity', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 1),
      assignments: new Map(),
      headroom: [],
    })
    const { logger, warns } = capturingLogger()
    const provider = buildRecordingProvider({
      ...h.deps,
      logger,
      capacity: async (root: string) =>
        root === '/mnt/nas'
          ? { availableBytes: null, totalBytes: null, error: 'EIO: i/o error, statfs' }
          : { availableBytes: 100, totalBytes: 1_000 },
    })
    const usage = await provider.getStorageUsage({})

    const nas = (usage.locations ?? []).find((l) => l.root === '/mnt/nas')
    expect(nas?.availableBytes).toBeNull()
    expect(nas?.totalBytes).toBeNull()

    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.meta).toMatchObject({
      locationId: 'recordings:nas',
      root: '/mnt/nas',
      error: 'EIO: i/o error, statfs',
    })
  })

  it('one unreachable volume does not empty the response — the healthy one still reports', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 1),
      assignments: new Map(),
      headroom: [],
    })
    const { logger } = capturingLogger()
    const provider = buildRecordingProvider({
      ...h.deps,
      logger,
      capacity: async (root: string) =>
        root === '/mnt/nas'
          ? { availableBytes: null, totalBytes: null, error: 'ETIMEDOUT' }
          : { availableBytes: 100, totalBytes: 1_000 },
    })
    const usage = await provider.getStorageUsage({})
    const volumes = usage.locations ?? []
    expect(volumes).toHaveLength(2)
    expect(volumes.find((l) => l.root === '/mnt/ssd')?.totalBytes).toBe(1_000)
    expect(usage.totalUsedBytes).toBeGreaterThan(0)
  })

  it('does not count a disabled location volume as available space', async () => {
    const h = rebalanceHarness({
      segments: pile(101, 'high', 'recordings:default', 1),
      assignments: new Map(),
      headroom: [],
    })
    const provider = buildRecordingProvider({
      ...h.deps,
      locations: () => [
        recordingsLocationOfMode(
          { id: 'recordings:default', type: 'recordings', root: '/mnt/ssd' },
          'active',
        ),
        recordingsLocationOfMode(
          { id: 'recordingsLow:default', type: 'recordingsLow', root: '/mnt/retired' },
          'readonly',
        ),
      ],
      capacity: async (root: string) =>
        root === '/mnt/retired'
          ? { availableBytes: 9_000, totalBytes: 10_000 }
          : { availableBytes: 100, totalBytes: 1_000 },
    })
    const usage = await provider.getStorageUsage({})
    const volumes = usage.locations ?? []
    expect(volumes.find((l) => l.root === '/mnt/ssd')?.availableBytes).toBe(100)
    const retired = volumes.find((l) => l.root === '/mnt/retired')
    expect(retired?.availableBytes).toBeNull()
    expect(retired?.totalBytes).toBeNull()
  })
})

describe('buildRecordingProvider — rescanStorage', () => {
  it('rehydrates from disk then reconciles the hour ledger so ghosts do not return on restart', async () => {
    const hydrateDevice = vi.fn(async () => {})
    const reconcileHourLedger = vi.fn(async () => {})
    const deps: RecordingProviderDeps = {
      ...harness().deps,
      configStore: await makeConfigsState(),
      hydrateDevice,
      reconcileHourLedger,
    }
    const provider = buildRecordingProvider(deps)
    await provider.rescanStorage({ deviceId: 99 })
    expect(hydrateDevice).toHaveBeenCalledWith(99, deps.locations())
    expect(reconcileHourLedger).toHaveBeenCalledWith(99)
  })
})

/**
 * The profile list is a READ of the index, and it obeys the same rule as every
 * other read on this path (D167).
 *
 * `collectRangeSegments` was taught to walk the window it was asked about; the
 * loop that decides WHICH profiles to ask about was left reading the index
 * bare. On a cold index that yields zero profiles, the hydrating loop never
 * runs, and the manifest comes back empty — the exact "no footage" lie the
 * hydration tri-state exists to prevent, arrived at one level higher up.
 */
describe('buildPlaybackManifest — the profile list is a read like any other', () => {
  it('walks the window before deriving which profiles the device has', async () => {
    const index = new RecordingIndex()
    const windows: Array<{ fromMs: number; toMs: number }> = []
    const deps = {
      index,
      nodeId: 'node-1',
      logger: noopLogger,
      dataDir: '/tmp/cs-manifest-spec',
      configStore: {} as unknown as RecordingConfigsState,
      locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
      statFile: async () => ({}),
      playbackBaseUrl: () => '/addon/recorder/playback',
      readFilePrefix: async () => new Uint8Array(0),
      hydrateWindow: async (deviceId: number, fromMs: number, toMs: number) => {
        windows.push({ fromMs, toMs })
        index.hydrateHour(deviceId, 'loc-a', fromMs, [
          `7/low/2026/07/29/00/${fromMs + 1000}-8000-50000.m4s`,
        ])
      },
    } as unknown as RecordingProviderDeps

    const manifest = await buildPlaybackManifest(deps, new Map(), 7, 0, 3_600_000)

    expect(windows).toEqual([{ fromMs: 0, toMs: 3_600_000 }])
    // A manifest, not the "no playback" shape: the profile derivation saw the
    // hydrated row. Reading the index bare here returns `localMasterPath: null`.
    expect(manifest.localMasterPath).not.toBeNull()
  })
})
