/**
 * Slice 5's server side: cmd 5 into a bounded scratch (retried until it LANDS,
 * under a bound — D58), then ONE bounded ffmpeg muxing to MP4 with
 * `+faststart` so `moov` is first and the duration is known before the bytes
 * arrive — which is what makes the player's seek work natively.
 *
 * Never through the broker (there is no live session for stored media) and
 * never RTMP (credentials in the URL, and asking for the URL enables the RTMP
 * port as a side effect).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildClipMuxArgs,
  CLIP_FETCH_MAX_ATTEMPTS,
  type ClipAudioTrack,
  decideClipAudio,
  fetchClipBytes,
} from '../clips/clip-mux.js'

describe('buildClipMuxArgs', () => {
  const args = buildClipMuxArgs({ inputPath: '/tmp/a.h264', outputPath: '/tmp/a.mp4' })

  it('copies the stream rather than re-encoding it', () => {
    expect(args).toContain('-c:v')
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
  })

  it('puts `moov` first so duration is known before the bytes arrive', () => {
    expect(args).toContain('-movflags')
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart')
  })

  it('emits every INPUT option strictly before `-i`', () => {
    const i = args.indexOf('-i')
    expect(i).toBeGreaterThan(-1)
    expect(args.indexOf('-f')).toBeLessThan(i)
    expect(args.indexOf('-movflags')).toBeGreaterThan(i)
  })

  it('names the input format — a headerless Annex-B stream cannot state it', () => {
    expect(args[args.indexOf('-f') + 1]).toBe('h264')
  })

  it('uses hevc for an H.265 camera', () => {
    const hevc = buildClipMuxArgs({
      inputPath: '/tmp/a.h265',
      outputPath: '/tmp/a.mp4',
      videoType: 'H265',
    })
    expect(hevc[hevc.indexOf('-f') + 1]).toBe('hevc')
  })

  it('never reads stdin and never asks a question', () => {
    expect(args).toContain('-nostdin')
    expect(args).toContain('-y')
  })

  it('ends with the output path', () => {
    expect(args.at(-1)).toBe('/tmp/a.mp4')
  })
})

describe('fetchClipBytes', () => {
  const stats = {
    keyframes: 1,
    fps: 15,
    fpsSource: 'timestamps' as const,
    infoFps: 15,
    durationSeconds: 43.254,
    audioPackets: 677,
    audioBytes: 351_363,
  }
  const ok = {
    annexB: Buffer.from('annexb'),
    videoType: 'H264' as const,
    audio: null,
    stats,
  }

  it('lands on the first attempt when the camera answers', async () => {
    const download = vi.fn(async () => ok)
    const out = await fetchClipBytes({ download, sleep: async () => {} })
    expect(out.annexB.toString()).toBe('annexb')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('retries until it LANDS, under a bound', async () => {
    // "Media a later pass depends on is retried until it lands, under a bound"
    // (D58) — gate on "did it persist", never on one attempt.
    let calls = 0
    const download = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('ECONNRESET')
      return ok
    })
    const out = await fetchClipBytes({ download, sleep: async () => {} })
    expect(out.annexB.toString()).toBe('annexb')
    expect(download).toHaveBeenCalledTimes(3)
  })

  it('gives up at the bound rather than looping for ever, naming the last refusal', async () => {
    const download = vi.fn(async () => {
      throw new Error('Baichuan download failed (native-only)')
    })
    await expect(fetchClipBytes({ download, sleep: async () => {} })).rejects.toThrow(/native-only/)
    expect(download).toHaveBeenCalledTimes(CLIP_FETCH_MAX_ATTEMPTS)
  })

  it('treats an EMPTY answer as a failed attempt, not as a clip', async () => {
    // A zero-byte "clip" would mux into an MP4 the player shows as broken;
    // gate on "did it persist", never on "did the call return".
    let calls = 0
    const download = vi.fn(async () => {
      calls += 1
      return calls < 2
        ? {
            annexB: Buffer.alloc(0),
            videoType: null,
            audio: null,
            stats: { ...stats, keyframes: 0 },
          }
        : ok
    })
    const out = await fetchClipBytes({ download, sleep: async () => {} })
    expect(out.annexB.byteLength).toBeGreaterThan(0)
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('backs off between attempts rather than hammering the one session', async () => {
    const waits: number[] = []
    let calls = 0
    const download = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('boom')
      return ok
    })
    await fetchClipBytes({
      download,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toHaveLength(2)
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0)
  })
})

/**
 * The delivered rate, and the second input (D567).
 *
 * `@apocaliss92/nodelink-js@0.7.10` returns the audio the cmd 5 download has
 * always carried, and it measures the rate the file actually plays at.
 * Measured on 592 (E1 Outdoor PoE, 2026-09-20, read-only): a sub file
 * delivered `fps 15` over 43.254 s of video beside 43.328 s of AAC/ADTS,
 * 16 kHz mono; its main twin `fps 25` over 41.295 s beside 41.280 s. Measured
 * on a Home Hub child by the library session: `InfoV1/V2` declares 30 and the
 * camera delivers 15.019, which muxed at the declared rate makes the video
 * half as long as its own audio.
 */
describe('buildClipMuxArgs: the delivered rate', () => {
  const at = (args: readonly string[], flag: string): string | undefined =>
    args[args.indexOf(flag) + 1]

  it('gives ffmpeg the MEASURED rate, as an INPUT option before `-i`', () => {
    const args = buildClipMuxArgs({ inputPath: '/tmp/a.h264', outputPath: '/tmp/a.mp4', fps: 15 })
    expect(at(args, '-r')).toBe('15')
    expect(args.indexOf('-r')).toBeLessThan(args.indexOf('-i'))
  })

  it('carries a fractional measured rate verbatim — 15.019, never 30', () => {
    const args = buildClipMuxArgs({
      inputPath: '/tmp/a.h264',
      outputPath: '/tmp/a.mp4',
      fps: 15.019,
    })
    expect(at(args, '-r')).toBe('15.019')
  })

  it('says NOTHING about the rate when nothing on the wire measured one', () => {
    // A deliberate fallback: the demuxer's own default, never the info
    // header's nominal rate, which is the number that caused the defect.
    for (const fps of [null, 0, Number.NaN, -1]) {
      const args = buildClipMuxArgs({ inputPath: '/tmp/a.h264', outputPath: '/tmp/a.mp4', fps })
      expect(args).not.toContain('-r')
    }
  })

  it('declares the OUTPUT container rather than trusting the extension', () => {
    const args = buildClipMuxArgs({ inputPath: '/tmp/a.h264', outputPath: '/tmp/a.mp4' })
    expect(args.lastIndexOf('-f')).toBeGreaterThan(args.indexOf('-i'))
    expect(args[args.lastIndexOf('-f') + 1]).toBe('mp4')
  })
})

describe('buildClipMuxArgs: the audio input', () => {
  const withAudio = buildClipMuxArgs({
    inputPath: '/tmp/a.h264',
    outputPath: '/tmp/a.mp4',
    fps: 15,
    audio: { path: '/tmp/a.aac', format: 'adts' },
  })
  const videoOnly = buildClipMuxArgs({ inputPath: '/tmp/a.h264', outputPath: '/tmp/a.mp4' })

  it('adds the track as a SECOND input, declared `aac`, after the video one', () => {
    const inputs = withAudio.reduce<number[]>(
      (acc, arg, i) => (arg === '-i' ? [...acc, i] : acc),
      [],
    )
    expect(inputs).toHaveLength(2)
    expect(withAudio[(inputs[1] ?? 0) + 1]).toBe('/tmp/a.aac')
    expect(withAudio[(inputs[1] ?? 0) - 1]).toBe('aac')
  })

  it('copies both tracks — a stored clip is never re-encoded', () => {
    expect(withAudio[withAudio.indexOf('-c:v') + 1]).toBe('copy')
    expect(withAudio[withAudio.indexOf('-c:a') + 1]).toBe('copy')
    expect(withAudio).not.toContain('-c:a aac')
  })

  it('applies `aac_adtstoasc` — ADTS frames are not an MP4 audio sample', () => {
    expect(withAudio[withAudio.indexOf('-bsf:a') + 1]).toBe('aac_adtstoasc')
  })

  it('keeps `+faststart` with two inputs — the seek depends on it (D549 22)', () => {
    expect(withAudio[withAudio.indexOf('-movflags') + 1]).toBe('+faststart')
    expect(withAudio.at(-1)).toBe('/tmp/a.mp4')
  })

  it('adds no audio input, and no audio bitstream filter, when there is none', () => {
    expect(videoOnly.filter((a) => a === '-i')).toHaveLength(1)
    expect(videoOnly).not.toContain('-bsf:a')
    expect(videoOnly).not.toContain('-c:a')
    expect(videoOnly[videoOnly.indexOf('-c:v') + 1]).toBe('copy')
  })
})

describe('decideClipAudio', () => {
  const DATA = Buffer.from('adts-frames')
  const track = (over: Partial<ClipAudioTrack> = {}): ClipAudioTrack => ({
    codec: 'Aac',
    format: 'adts',
    data: DATA,
    frames: 677,
    bytes: 351_363,
    sampleRate: 16_000,
    channels: 1,
    durationSeconds: 43.328,
    ...over,
  })

  it('carries the BYTES on the decision, so the gate cannot be re-derived', () => {
    const decision = decideClipAudio(track())
    expect(decision.kind === 'copy' && decision.data).toBe(DATA)
  })

  it('copies an ADTS track — the measured 592 case, sub AND main', () => {
    expect(decideClipAudio(track())).toEqual({ kind: 'copy', format: 'adts', data: DATA })
  })

  it('serves the clip SILENT when no audio packet arrived, and names that', () => {
    expect(decideClipAudio(null)).toEqual({
      kind: 'silent',
      reason: 'no-audio-track',
      format: null,
    })
  })

  it('refuses to stream-copy ADPCM — a transcode nobody here can test is not written', () => {
    // No camera on this fleet produces one; the library types and reports the
    // case, and the honest answer is a silent clip that SAYS why.
    expect(decideClipAudio(track({ codec: 'Adpcm', format: 'adpcm' }))).toEqual({
      kind: 'silent',
      reason: 'audio-not-copyable',
      format: 'adpcm',
    })
  })

  it('refuses an UNKNOWN layout — `audio != null` is not the gate', () => {
    expect(decideClipAudio(track({ format: 'unknown' }))).toEqual({
      kind: 'silent',
      reason: 'audio-not-copyable',
      format: 'unknown',
    })
  })

  it('treats a track that arrived with no bytes as no track at all', () => {
    expect(decideClipAudio(track({ frames: 0, bytes: 0 }))).toEqual({
      kind: 'silent',
      reason: 'no-audio-track',
      format: 'adts',
    })
  })
})
