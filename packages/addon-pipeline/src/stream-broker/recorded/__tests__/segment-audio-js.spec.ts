import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  demuxSegmentAudioOpusJs,
  demuxSegmentAudioOpusPreferJs,
  extractAudioSamples,
  isOpusCodec,
} from '../segment-audio-js'

const SAMPLE_AAC = readFileSync(join(__dirname, 'fixtures/sample.m4s'))

/**
 * The ffmpeg these tests spawn. The product never runs the host's binary (D540:
 * every node downloads one pinned build, and PATH is not on the list), so the
 * tests take the same override the product honours and fall back to PATH only
 * for a developer machine. CI sets it to the pinned build.
 */
const FFMPEG = process.env['CAMSTACK_FFMPEG_PATH'] ?? 'ffmpeg'

/**
 * Produce a self-contained fragmented-mp4 (`.m4s`) with an Opus audio track
 * using the SAME muxer flags the recorder writes (`ffmpeg-args.ts`): Opus in an
 * `Opus`/`dOps` sample entry, `movflags=+frag_keyframe+empty_moov+default_base_moof`.
 *
 * THROWS when ffmpeg cannot do it, naming its stderr. It used to return null
 * and the Opus-path tests returned early on null — so on a runner whose apt
 * ffmpeg was 4.2.7 (Opus-in-MP4 "experimental, add -strict -2" until 4.3)
 * two of these tests were inert for months and read as green, while the one
 * that could not skip failed with `expected 0 to be greater than 50`. A
 * fixture that cannot be built is a red test, not a quiet one.
 */
function makeOpusFragment(dir: string): Uint8Array {
  const out = join(dir, 'opus.m4s')
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2:sample_rate=48000',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      '-f',
      'mp4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-y',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() ?? ''
    throw new Error(
      `cannot build the Opus fixture with ${FFMPEG} (status ${String(r.status)}, ` +
        `${r.error?.message ?? 'no spawn error'}): ${stderr || '(no stderr)'}`,
    )
  }
  return new Uint8Array(readFileSync(out))
}

let scratch = ''
let opusFragment: Uint8Array = new Uint8Array(0)

beforeAll(() => {
  scratch = mkdtempSync(join(__dirname, '.audio-js-'))
  opusFragment = makeOpusFragment(scratch)
})
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('isOpusCodec', () => {
  it('matches the mp4box Opus codec string, not AAC', () => {
    expect(isOpusCodec('Opus')).toBe(true)
    expect(isOpusCodec('opus')).toBe(true)
    expect(isOpusCodec('mp4a.40.2')).toBe(false)
  })
})

describe('extractAudioSamples', () => {
  it('reads the legacy AAC fixture audio track metadata', async () => {
    const got = await extractAudioSamples(new Uint8Array(SAMPLE_AAC))
    expect(got).not.toBeNull()
    expect(got!.codec.startsWith('mp4a')).toBe(true)
    expect(got!.accessUnits.length).toBeGreaterThan(0)
  })
})

describe('demuxSegmentAudioOpusJs', () => {
  it('returns null for a legacy AAC fragment (→ ffmpeg fallback)', async () => {
    expect(await demuxSegmentAudioOpusJs(new Uint8Array(SAMPLE_AAC))).toBeNull()
  })

  it('returns null for garbage bytes', async () => {
    expect(await demuxSegmentAudioOpusJs(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
  })

  it('extracts ordered Opus access units from an Opus fragment', async () => {
    const extracted = await extractAudioSamples(opusFragment)
    expect(extracted).not.toBeNull()
    expect(isOpusCodec(extracted!.codec)).toBe(true)
    expect(extracted!.sampleRate).toBe(48000)

    const aus = await demuxSegmentAudioOpusJs(opusFragment)
    expect(aus).not.toBeNull()
    // ~2 s of 20 ms Opus frames → ~100 AUs, first is segment-relative 0.
    expect(aus!.length).toBeGreaterThan(50)
    expect(aus![0]!.ptsMs).toBe(0)
    for (let i = 1; i < aus!.length; i++) {
      expect(aus![i]!.ptsMs).toBeGreaterThanOrEqual(aus![i - 1]!.ptsMs)
    }
    // Every AU carries a non-empty raw Opus packet.
    expect(aus!.every((a) => a.data.length > 0)).toBe(true)
  })
})

describe('demuxSegmentAudioOpusPreferJs', () => {
  it('returns Opus AUs directly from an Opus fragment (no ffmpeg fallback)', async () => {
    let fellBack = false
    const aus = await demuxSegmentAudioOpusPreferJs(opusFragment, {
      ffmpegPath: FFMPEG,
      onFfmpegFallback: () => {
        fellBack = true
      },
    })
    expect(fellBack).toBe(false)
    expect(aus.length).toBeGreaterThan(50)
    expect(aus[0]!.ptsMs).toBe(0)
  })

  it('transcodes a legacy AAC fragment to Opus via the ffmpeg fallback', async () => {
    let fellBack = false
    const aus = await demuxSegmentAudioOpusPreferJs(new Uint8Array(SAMPLE_AAC), {
      ffmpegPath: FFMPEG,
      onFfmpegFallback: () => {
        fellBack = true
      },
    })
    expect(fellBack).toBe(true)
    // The AAC fixture has ~4 s of audio → the transcoded Opus yields many AUs.
    expect(aus.length).toBeGreaterThan(50)
    expect(aus[0]!.ptsMs).toBe(0)
    expect(aus.every((a) => a.data.length > 0)).toBe(true)
  })

  it('answers no audio, and SAYS why, when a legacy fragment needs ffmpeg and the node has none', async () => {
    const reasons: string[] = []
    const aus = await demuxSegmentAudioOpusPreferJs(new Uint8Array(SAMPLE_AAC), {
      ffmpegPath: null,
      onFfmpegFallback: (reason) => {
        reasons.push(reason)
      },
    })
    expect(aus).toEqual([])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('no pinned ffmpeg')
  })

  it('returns [] (never throws) for garbage bytes', async () => {
    const aus = await demuxSegmentAudioOpusPreferJs(new Uint8Array([9, 9, 9, 9]), {
      ffmpegPath: FFMPEG,
    })
    expect(aus).toEqual([])
  })
})
