/**
 * segment-audio-js — PURE-JS in-process extraction of a recorded `.m4s`
 * fragment's AUDIO track, for the WebRTC Opus egress path.
 *
 * Since A1 the recorder writes audio as **Opus** in an `Opus`/`dOps` ISOBMFF
 * sample entry (see `recorder/addon/ffmpeg-args.ts`). Opus-in-mp4 stores each
 * access unit as a raw Opus packet — exactly the payload a WebRTC Opus RTP
 * sender puts on the wire — so playback needs only an mp4box box-parse + byte
 * copy to recover the AUs, with NO per-fragment ffmpeg spawn and NO decode.
 *
 * This mirrors {@link import('./segment-demux-js.js')} on the video side: the
 * in-process fast path with the existing ffmpeg spawn kept as the fallback.
 * A pre-A1 fragment whose audio track is still AAC (`mp4a`) yields `null` here
 * so the caller falls back to the ffmpeg AAC→PCMU path (`segment-audio.ts`).
 *
 * Anchoring the first sample's cts to 0 makes each AU's `ptsMs` a plain
 * segment-relative offset in ms, matching the `PcmuAccessUnit.ptsMs` contract
 * the feeder already re-stamps.
 */
import MP4Box, {
  type MP4File,
  type MP4Info,
  type MP4Sample,
  type MP4AudioTrack,
  type MP4ArrayBuffer,
} from 'mp4box'
import { runFfmpegOnce } from './ffmpeg-run-once.js'

/** One Opus access unit (a single raw Opus packet) demuxed from a fragment. */
export interface OpusAccessUnit {
  /** Raw Opus packet bytes (the mp4 sample payload), ready for RTP. */
  readonly data: Uint8Array
  /** Source presentation time in milliseconds (segment-relative, first AU = 0). */
  readonly ptsMs: number
}

/** The audio track's codec + decoded AUs, or the reason it was not Opus. */
export interface ExtractedAudio {
  /** mp4box audio codec string, e.g. `Opus`, `mp4a.40.2`. */
  readonly codec: string
  /** Sample rate declared by the audio sample entry (48000 for Opus). */
  readonly sampleRate: number
  /** Channel count declared by the audio sample entry. */
  readonly channels: number
  /** Access units in decode order (segment-relative ptsMs). */
  readonly accessUnits: readonly OpusAccessUnit[]
}

/** True for an mp4box audio codec string that is Opus (`Opus`/`opus`). */
export function isOpusCodec(codec: string): boolean {
  return /^opus$/i.test(codec)
}

/** Resolved audio track once mp4box has parsed the `moov`. */
interface ReadyAudioTrack {
  readonly audio: MP4AudioTrack
}

/**
 * Phase 1: append the whole segment, flush, resolve the FIRST audio track when
 * `onReady` fires. Resolves null on any failure (no audio track, error, or
 * garbage bytes that never trigger a callback — a short timer settles those).
 * Mirrors `fmp4-keyframes.ts` `readTrack` but for the audio track.
 */
function readAudioTrack(file: MP4File, segment: Uint8Array): Promise<ReadyAudioTrack | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: ReadyAudioTrack | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => done(null), 250)

    file.onError = () => done(null)
    file.onReady = (info: MP4Info) => {
      const audio = info.audioTracks?.[0]
      if (!audio) return done(null)
      done({ audio })
    }

    // mp4box.js requires `fileStart` on the buffer — documented type boundary.
    const copy = segment.buffer.slice(
      segment.byteOffset,
      segment.byteOffset + segment.byteLength,
    ) as MP4ArrayBuffer
    copy.fileStart = 0
    try {
      file.appendBuffer(copy)
      file.flush()
    } catch {
      done(null)
    }
  })
}

/**
 * Demux a recorded `.m4s` fragment's audio track and return its codec + all
 * access units, or null if the fragment carries no audio / no decodable sample.
 * Codec-agnostic: the caller decides what to do with a non-Opus codec.
 * No decode, no ffmpeg — byte copies only.
 */
export async function extractAudioSamples(bytes: Uint8Array): Promise<ExtractedAudio | null> {
  const file = MP4Box.createFile()
  const ready = await readAudioTrack(file, bytes)
  if (!ready) return null

  const { audio } = ready
  const collected: OpusAccessUnit[] = []
  let firstCts: number | null = null

  file.onSamples = (_id: number, _user: unknown, samples: MP4Sample[]) => {
    for (const s of samples) {
      if (firstCts === null) firstCts = s.cts
      const ptsMs = Math.round(((s.cts - firstCts) / s.timescale) * 1000)
      collected.push({ data: new Uint8Array(s.data), ptsMs })
    }
  }
  file.setExtractionOptions(audio.id, null, { nbSamples: 100_000 })
  try {
    file.start()
  } catch {
    return null
  }

  if (collected.length === 0) return null
  return {
    codec: audio.codec,
    sampleRate: audio.audio?.sample_rate ?? 0,
    channels: audio.audio?.channel_count ?? 0,
    accessUnits: collected,
  }
}

/**
 * Pure-JS Opus audio demux of one fragment: return the fragment's Opus access
 * units, or `null` when the audio track is absent or NOT Opus (a legacy AAC
 * fragment → caller falls back to the ffmpeg AAC→Opus path). Throws only on a
 * genuinely malformed parse; the wrapper turns that into a fallback.
 */
export async function demuxSegmentAudioOpusJs(
  bytes: Uint8Array,
): Promise<readonly OpusAccessUnit[] | null> {
  const extracted = await extractAudioSamples(bytes)
  if (!extracted || !isOpusCodec(extracted.codec)) return null
  return extracted.accessUnits
}

/**
 * ffmpeg args to transcode a fragment's audio (stdin) into a self-contained
 * fragmented-mp4 with an Opus track on stdout — the SAME container the recorder
 * writes (`ffmpeg-args.ts`), so {@link demuxSegmentAudioOpusJs} reads the result
 * back with no extra code. Used ONLY as the legacy-AAC fallback for Opus
 * sessions. `-vn` drops video; `-map 0:a:0` picks the audio track.
 */
export const SEGMENT_AUDIO_OPUS_FFMPEG_ARGS: readonly string[] = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-vn',
  '-map',
  '0:a:0',
  '-c:a',
  'libopus',
  '-b:a',
  '48k',
  '-f',
  'mp4',
  '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof',
  'pipe:1',
]

/** Options for {@link demuxSegmentAudioOpusPreferJs}. */
export interface OpusAudioPreferJsOptions {
  /**
   * The node's pinned ffmpeg for the legacy-AAC fallback (D540). REQUIRED, and
   * `null` when the node has none: a legacy fragment then answers no audio,
   * and says why through {@link onFfmpegFallback} — never a PATH `ffmpeg`.
   */
  readonly ffmpegPath: string | null
  /** Invoked once when the JS Opus path misses and ffmpeg transcode kicks in. */
  readonly onFfmpegFallback?: (reason: string) => void
}

/**
 * Opus-preferred recorded audio demux for Opus-negotiated sessions:
 *   1. Try the in-process Opus extraction (post-A1 fragments — NO ffmpeg).
 *   2. On a miss (legacy pre-A1 AAC fragment), transcode the fragment's audio
 *      to an Opus fragmented-mp4 via ffmpeg and read THAT back in-process.
 * Returns `[]` (never throws) when there is no usable audio — recorded audio is
 * best-effort and must never block recorded video. Mirrors the video-side
 * `demuxSegmentPreferJs`.
 */
export async function demuxSegmentAudioOpusPreferJs(
  bytes: Uint8Array,
  opts: OpusAudioPreferJsOptions,
): Promise<readonly OpusAccessUnit[]> {
  try {
    const direct = await demuxSegmentAudioOpusJs(bytes)
    if (direct) return direct
  } catch {
    // fall through to the ffmpeg transcode fallback
  }
  if (opts.ffmpegPath === null) {
    opts.onFfmpegFallback?.(
      'audio track is not Opus (legacy fragment) and the ffmpeg fallback is refused — no pinned ffmpeg on this node',
    )
    return []
  }
  opts.onFfmpegFallback?.('audio track is not Opus (legacy fragment)')
  try {
    const opusFmp4 = await runFfmpegOnce({
      ffmpegPath: opts.ffmpegPath,
      args: SEGMENT_AUDIO_OPUS_FFMPEG_ARGS,
      input: bytes,
      // A video-only / undecodable fragment exits non-zero → treat as no audio.
      tolerateNonZeroExit: true,
    })
    if (opusFmp4.length === 0) return []
    const transcoded = await demuxSegmentAudioOpusJs(opusFmp4)
    return transcoded ?? []
  } catch {
    return []
  }
}
