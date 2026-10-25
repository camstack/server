import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { demuxSegmentFullJs, demuxSegmentPreferJs } from '../segment-demux-js'
import { demuxSegmentToAnnexB, FfmpegFallbackRefusedError } from '../segment-demux'

// Real HEVC recording fragment (self-contained `.m4s`, one IDR-led GOP).
// LOCAL-ONLY — never committed (real footage) — so fresh checkouts / CI skip
// the fixture-backed cases.
const HEVC_SAMPLE = join(__dirname, 'fixtures/sample.m4s')
const HAVE_HEVC = existsSync(HEVC_SAMPLE)
/** The binary the product would run: CI exports the pinned build here (D540). */
const FFMPEG = process.env['CAMSTACK_FFMPEG_PATH'] ?? 'ffmpeg'

const nalTypesAnnexB = (buf: Uint8Array, hevc: boolean): Set<number> => {
  const types = new Set<number>()
  for (let i = 0; i + 5 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      const h = buf[i + 4]!
      types.add(hevc ? (h >> 1) & 0x3f : h & 0x1f)
    }
  }
  return types
}

const startsWithAnnexB = (buf: Uint8Array): boolean =>
  buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1

describe.skipIf(!HAVE_HEVC)('demuxSegmentFullJs (H.265 real fragment)', () => {
  const SAMPLE = (): Uint8Array => new Uint8Array(readFileSync(HEVC_SAMPLE))

  it('returns every access unit tagged H265, first is a params-fused IDR', async () => {
    const aus = await demuxSegmentFullJs(SAMPLE())
    expect(aus).not.toBeNull()
    expect(aus!.length).toBeGreaterThan(1)
    expect(aus!.every((a) => a.codec === 'H265')).toBe(true)
    expect(aus!.every((a) => a.data.length > 0)).toBe(true)
    expect(aus!.every((a) => startsWithAnnexB(a.data))).toBe(true)
    expect(aus![0]!.keyframe).toBe(true)
  })

  it('ptsMs is non-decreasing and segment-relative (first AU = 0)', async () => {
    const aus = await demuxSegmentFullJs(SAMPLE())
    expect(aus![0]!.ptsMs).toBe(0)
    for (let i = 1; i < aus!.length; i++) {
      expect(aus![i]!.ptsMs).toBeGreaterThanOrEqual(aus![i - 1]!.ptsMs)
    }
  })

  it('each IDR (keyframe) AU carries its parameter sets (VPS/SPS/PPS); deltas do not', async () => {
    const aus = await demuxSegmentFullJs(SAMPLE())
    for (const au of aus!) {
      const types = nalTypesAnnexB(au.data, true)
      if (au.keyframe) {
        expect(types.has(32)).toBe(true) // VPS
        expect(types.has(33)).toBe(true) // SPS
        expect(types.has(34)).toBe(true) // PPS
        expect(types.has(19) || types.has(20)).toBe(true) // IDR
      } else {
        // Delta AUs carry no parameter sets (only VCL / non-IRAP NALs).
        expect(types.has(32)).toBe(false)
        expect(types.has(33)).toBe(false)
        expect(types.has(34)).toBe(false)
      }
    }
  })

  it('matches the ffmpeg demux: same AU count, codec, keyframe flags and PTS span', async () => {
    const [js, ff] = await Promise.all([
      demuxSegmentFullJs(SAMPLE()),
      demuxSegmentToAnnexB(SAMPLE(), FFMPEG),
    ])
    // Same number of access units.
    expect(js!.length).toBe(ff.length)
    // Same codec.
    expect(js!.map((a) => a.codec)).toEqual(ff.map((a) => a.codec))
    // Same ordered keyframe flags (single-GOP fragment ⇒ first true, rest false).
    expect(js!.map((a) => a.keyframe)).toEqual(ff.map((a) => a.keyframe))
    // Both PTS sequences are non-decreasing. The ABSOLUTE values differ (the
    // ffmpeg mpegts muxer starts PES PTS at a non-zero base and rounds the
    // 90 kHz→ms conversion differently than mp4box's cts/timescale), so we
    // compare the segment-relative SPAN, not per-AU equality.
    for (let i = 1; i < js!.length; i++) {
      expect(js![i]!.ptsMs).toBeGreaterThanOrEqual(js![i - 1]!.ptsMs)
      expect(ff[i]!.ptsMs).toBeGreaterThanOrEqual(ff[i - 1]!.ptsMs)
    }
    const jsSpan = js![js!.length - 1]!.ptsMs - js![0]!.ptsMs
    const ffSpan = ff[ff.length - 1]!.ptsMs - ff[0]!.ptsMs
    expect(Math.abs(jsSpan - ffSpan)).toBeLessThanOrEqual(2)
  })
})

// Fixture-independent: runs on every checkout (CI included).
describe('demuxSegmentFullJs (garbage handling)', () => {
  it('returns null on non-mp4 bytes (never throws)', async () => {
    expect(await demuxSegmentFullJs(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7))).toBeNull()
  })
})

describe('demuxSegmentPreferJs — which demux ran, reported on BOTH paths', () => {
  it('falls back to the ffmpeg demux and reports path=ffmpeg WITH the reason', async () => {
    const onDemuxPath = vi.fn()
    // Garbage → JS returns null → ffmpeg spawn runs and also fails to parse,
    // throwing. Assert the fallback was chosen (callback fired) and the ffmpeg
    // path was reached (it rejects on garbage).
    await expect(
      demuxSegmentPreferJs(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7), {
        ffmpegPath: FFMPEG,
        onDemuxPath,
      }),
    ).rejects.toBeDefined()
    expect(onDemuxPath).toHaveBeenCalledOnce()
    expect(onDemuxPath.mock.calls[0]![0]).toMatchObject({ path: 'ffmpeg' })
    expect(onDemuxPath.mock.calls[0]![0].reason).toContain('no access units')
  })

  it('REFUSES the fallback when the node has no pinned ffmpeg — never a PATH name (D540)', async () => {
    const onDemuxPath = vi.fn()
    await expect(
      demuxSegmentPreferJs(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7), {
        ffmpegPath: null,
        onDemuxPath,
      }),
    ).rejects.toBeInstanceOf(FfmpegFallbackRefusedError)
    // The fallback was still NEEDED, and still counted as such.
    expect(onDemuxPath.mock.calls[0]![0]).toMatchObject({ path: 'ffmpeg' })
  })

  it.skipIf(!HAVE_HEVC)(
    'reports path=js for a valid fragment — a SUCCESS is counted too',
    async () => {
      const onDemuxPath = vi.fn()
      const aus = await demuxSegmentPreferJs(new Uint8Array(readFileSync(HEVC_SAMPLE)), {
        ffmpegPath: FFMPEG,
        onDemuxPath,
      })
      expect(aus.length).toBeGreaterThan(1)
      expect(aus.every((a) => a.codec === 'H265')).toBe(true)
      // The in-process path must announce itself: a counter that only ever hears
      // about failures cannot answer "how often do we fall back".
      expect(onDemuxPath).toHaveBeenCalledOnce()
      expect(onDemuxPath.mock.calls[0]![0]).toEqual({ path: 'js' })
    },
  )

  it('uses an injected jsParse instead of the in-process mp4box parse', async () => {
    const onDemuxPath = vi.fn()
    const injected = [
      {
        data: new Uint8Array([0, 0, 0, 1, 0x65]),
        ptsMs: 0,
        keyframe: true,
        codec: 'H264' as const,
      },
    ]
    const jsParse = vi.fn(async () => injected)
    const aus = await demuxSegmentPreferJs(Uint8Array.of(9, 9, 9), {
      ffmpegPath: FFMPEG,
      onDemuxPath,
      jsParse,
    })
    expect(jsParse).toHaveBeenCalledOnce()
    expect(aus).toBe(injected)
    expect(onDemuxPath).toHaveBeenCalledOnce()
    expect(onDemuxPath.mock.calls[0]![0]).toEqual({ path: 'js' })
  })
})
