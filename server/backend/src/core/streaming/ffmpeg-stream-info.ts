/**
 * Stream metadata read from the pinned `ffmpeg`'s own input report.
 *
 * The probe used `ffprobe -of json`, spawned by NAME off the host's PATH — and
 * the pinned build every node downloads (D540) provisions `ffmpeg` only, so
 * there is no `ffprobe` of ours to run. `ffmpeg -i <url>` with no output prints
 * the same facts for every input stream on stderr before it exits for want of
 * an output:
 *
 *   Stream #0:0: Video: h264 (Main), yuvj420p(pc, bt709, progressive), 2560x1440, 20 fps, 20 tbr, 90k tbn
 *   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 16000 Hz, mono, fltp, 32 kb/s
 *
 * Pure and total: a line it cannot read contributes nothing, never a throw.
 */
import type { StreamAudioMetadata, StreamMetadata } from '@camstack/types'

/** How long the probe waits on a network input, in µs (ffmpeg's unit). */
const PROBE_INPUT_TIMEOUT_US = '5000000'

/**
 * The probe argv for `url`, chosen by SCHEME.
 *
 * The ffmpeg CLI, unlike ffprobe, refuses an input option nothing consumed:
 * `-rtsp_transport` on an http or file input is `Option rtsp_transport not
 * found … Error opening input files`, exit 8 (measured on jellyfin 8.1.2).
 * `-timeout` is an http and rtsp option, is unknown to a file, and on rtmp
 * would mean LISTEN mode. So each scheme gets exactly what it consumes.
 */
export function buildStreamProbeArgs(url: string): readonly string[] {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? ''
  const input: string[] = []
  if (scheme === 'rtsp' || scheme === 'rtsps') {
    input.push('-rtsp_transport', 'tcp', '-timeout', PROBE_INPUT_TIMEOUT_US)
  } else if (scheme === 'http' || scheme === 'https') {
    input.push('-timeout', PROBE_INPUT_TIMEOUT_US)
  }
  return ['-hide_banner', '-nostdin', ...input, '-i', url]
}

/** Did the probe find anything at all? An empty result is a failed probe. */
export function probeFoundAStream(meta: StreamMetadata): boolean {
  return meta.codec !== undefined || meta.audio !== undefined
}

/** Codec aliases normalised to canonical names. */
const CODEC_ALIASES: Readonly<Record<string, string>> = {
  hevc: 'h265',
}

/** `Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / …), …` → kind + the rest. */
const STREAM_LINE_RE = /^\s*Stream #\d+:\d+\S*:\s+(Video|Audio):\s+(.*)$/

/** `aac (LC) (mp4a / 0x…)` → codec `aac`, profile `LC` (the FIRST parenthesis). */
const CODEC_RE = /^([\w-]+)(?:\s+\(([^)/]+)\))?/

/** Channel layouts ffmpeg names instead of counting. */
const CHANNEL_LAYOUTS: Readonly<Record<string, number>> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  quad: 4,
  '5.0': 5,
  '5.1': 6,
  '7.1': 8,
}

function positive(n: number): number | undefined {
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function kbps(body: string): number | undefined {
  const m = /(\d+) kb\/s/.exec(body)
  return m === null ? undefined : positive(Number(m[1]))
}

function fps(body: string): number | undefined {
  // `fps` is the stream's rate; `tbr` is ffmpeg's guess when it has none.
  // ffmpeg prints `90k tbr` for 90 000 — the `k` is a multiplier, not noise.
  const m = /([\d.]+)(k)? fps\b/.exec(body) ?? /([\d.]+)(k)? tbr\b/.exec(body)
  if (m === null) return undefined
  const base = positive(Number(m[1]))
  if (base === undefined) return undefined
  const value = m[2] === 'k' ? base * 1000 : base
  return Math.round(value * 100) / 100
}

function readVideo(body: string, meta: StreamMetadata): void {
  const codec = CODEC_RE.exec(body)
  const raw = codec?.[1]?.toLowerCase()
  if (raw !== undefined) meta.codec = CODEC_ALIASES[raw] ?? raw
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(body)
  if (size !== null) {
    const width = positive(Number(size[1]))
    const height = positive(Number(size[2]))
    if (width !== undefined) meta.width = width
    if (height !== undefined) meta.height = height
  }
  const rate = fps(body)
  if (rate !== undefined) meta.fps = rate
  const bitrate = kbps(body)
  if (bitrate !== undefined) meta.bitrateKbps = bitrate
}

function readAudio(body: string): StreamAudioMetadata {
  const audio: StreamAudioMetadata = {}
  const codec = CODEC_RE.exec(body)
  if (codec?.[1] !== undefined) audio.codec = codec[1].toLowerCase()
  const profile = codec?.[2]?.trim()
  if (profile !== undefined && profile.length > 0) audio.profile = profile
  const hz = /(\d+) Hz/.exec(body)
  if (hz !== null) {
    const sampleRate = positive(Number(hz[1]))
    if (sampleRate !== undefined) audio.sampleRate = sampleRate
  }
  const fields = body.split(',').map((f) => f.trim())
  for (const field of fields) {
    const named = CHANNEL_LAYOUTS[field.replace(/\(.*\)$/, '')]
    if (named !== undefined) {
      audio.channels = named
      break
    }
    const counted = /^(\d+) channels$/.exec(field)
    if (counted !== null) {
      audio.channels = Number(counted[1])
      break
    }
  }
  const bitrate = kbps(body)
  if (bitrate !== undefined) audio.bitrateKbps = bitrate
  return audio
}

/** The FIRST video and FIRST audio stream of `ffmpeg -i`'s report. */
export function parseFfmpegStreamInfo(stderr: string): StreamMetadata {
  const meta: StreamMetadata = {}
  // CRLF too: `(.*)$` cannot cross a `\r`, and a Windows build or a captured
  // log hands one over.
  for (const line of stderr.split(/\r?\n/)) {
    const m = STREAM_LINE_RE.exec(line)
    if (m === null) continue
    const kind = m[1]
    const body = m[2] ?? ''
    if (kind === 'Video' && meta.codec === undefined) readVideo(body, meta)
    else if (kind === 'Audio' && meta.audio === undefined) meta.audio = readAudio(body)
  }
  return meta
}
