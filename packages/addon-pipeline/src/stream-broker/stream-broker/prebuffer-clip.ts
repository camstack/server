/**
 * Render a GIF / MP4 from a broker's PRE-BUFFER around an instant.
 *
 * WHY NOT THE RECORDING: only FINALIZED segments are addressable and the one
 * covering "now" is still being written (~13 s behind, measured), so a
 * segment-sourced notification clip is either delayed by a segment or shows the
 * seconds BEFORE the trigger — the approach, not the event (operator,
 * 2026-07-30). The pre-buffer already holds those seconds; it is exactly what
 * `EncodedRingBuffer` was built for. It also means a camera does not have to be
 * recording at all to produce a clip.
 *
 * The packets never leave the process: ffmpeg is fed the annex-B elementary
 * stream on stdin and the caller receives muxed bytes — one compressed,
 * on-demand payload per notification (D9/D18).
 */
import type { ChildProcess } from 'node:child_process'
import { type CamProfile, type EncodedPacket, ffmpegRate } from '@camstack/types'
import { convertH264ToAnnexB } from '../webrtc/h264-utils.js'
import { convertH265ToAnnexB } from '../webrtc/h265-utils.js'
import { annexBHasParameterSets } from './annexb-param-sets.js'

/** Profiles cheapest-first — the default picks the first one assigned. */
export const PROFILE_BY_COST: readonly CamProfile[] = ['low', 'mid', 'high'] as const

/**
 * The profile a clip should use: the caller's choice when it is actually
 * assigned, else the CHEAPEST assigned one. A notification attachment is
 * watched on a phone — spending the 4K rendition on it wastes CPU to produce a
 * file the recipient's client will downscale anyway.
 *
 * `null` when the camera has no assigned profile at all (nothing to render).
 */
export function pickClipProfile(
  assigned: readonly CamProfile[],
  requested: CamProfile | undefined,
): CamProfile | null {
  if (requested !== undefined && assigned.includes(requested)) return requested
  for (const p of PROFILE_BY_COST) {
    if (assigned.includes(p)) return p
  }
  return null
}

/**
 * The tallest rendition an event clip is cut from.
 *
 * 1080 and not 720: the attachment is native-resolution H.264 that nothing
 * re-encodes, and the operator asked for a clip they could actually watch. A
 * few seconds of 4K copy is megabytes, which is the difference between "every
 * notifier takes it" and "pushover drops it at 5 MiB".
 */
export const EVENT_CLIP_MAX_HEIGHT = 1080

/** One rendition, as {@link pickBestClipProfile} needs to see it. */
export interface ClipProfileCandidate {
  readonly profile: CamProfile
  readonly codec?: string | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/**
 * The rendition an EVENT production should cut from — the opposite default to
 * {@link pickClipProfile}.
 *
 * `pickClipProfile` takes the cheapest assigned slot, which was right when a
 * notification attachment was a 480 px thumbnail with motion. It is wrong now:
 * on this fleet the cheapest slot is a 640×360 substream, and a gif derived
 * from it is the "de-pixellated" attachment the operator reported. So an event
 * production prefers the LARGEST H.264 rendition at or below
 * {@link EVENT_CLIP_MAX_HEIGHT}:
 *
 *  - **H.264, because that is what can be COPIED.** An H.265 slot forces a
 *    re-encode, which is both expensive and not universally playable on the
 *    phones notifications land on.
 *  - **At or below 1080p**, falling back to the smallest slot above it when a
 *    camera offers nothing else — a 4K-only camera still gets a clip, it just
 *    pays for it.
 *
 * `null` when no rendition qualifies; the caller then falls back to
 * `pickClipProfile` and the answer reports which was used.
 */
export function pickBestClipProfile(
  candidates: readonly ClipProfileCandidate[],
): CamProfile | null {
  const usable = candidates.filter(
    (c) => normaliseCodec(c.codec) === 'h264' && (c.height ?? 0) > 0 && (c.width ?? 0) > 0,
  )
  if (usable.length === 0) return null
  const within = usable.filter((c) => (c.height ?? 0) <= EVENT_CLIP_MAX_HEIGHT)
  const pool = within.length > 0 ? within : usable
  const sorted = [...pool].sort((a, b) =>
    within.length > 0 ? (b.height ?? 0) - (a.height ?? 0) : (a.height ?? 0) - (b.height ?? 0),
  )
  return sorted[0]?.profile ?? null
}

/** Publishers spell H.265 four ways; the same normalisation the broker uses. */
function normaliseCodec(codec: string | undefined): string {
  return (codec ?? '').toLowerCase().replace(/[.\s-]/g, '')
}

/**
 * The tail of the buffer covering `windowSec`, starting at a KEYFRAME.
 *
 * `pts` is a stream clock, not wall time, so the window is taken as a DURATION
 * from the newest packet rather than by absolute timestamps — which is also
 * what makes it correct when the caller waited for the post-roll: the tail then
 * spans `[event − pre, event + post]`. Decoding must start at a keyframe, so a
 * window that would begin mid-GOP is widened backwards to the previous one; if
 * there is none, everything from the first keyframe is returned rather than an
 * undecodable fragment.
 */
export function tailWindow(
  packets: readonly EncodedPacket[],
  windowSec: number,
): readonly EncodedPacket[] {
  const video = decodableVideo(packets)
  const newest = video[video.length - 1]
  if (newest === undefined) return []
  return sliceFromKeyframe(
    video,
    newest.pts - Math.max(0, windowSec) * 1000,
    Number.POSITIVE_INFINITY,
  )
}

/**
 * Placeholder packets ("RECONNECTING"/"SLEEPING" keyframes the broker pumps at
 * 1 Hz while no RTP flows) are a DIFFERENT resolution and parameter set —
 * muxing them into a clip corrupts the decode and produces a file that freezes
 * on the placeholder.
 */
function decodableVideo(packets: readonly EncodedPacket[]): readonly EncodedPacket[] {
  return packets.filter((p) => p.type === 'video' && p.isPlaceholder !== true)
}

/**
 * `[startPts, endPts]`, widened backwards to a keyframe — decoding cannot start
 * mid-GOP, so a window that would is widened rather than returned undecodable.
 */
function sliceFromKeyframe(
  video: readonly EncodedPacket[],
  startPts: number,
  endPts: number,
): readonly EncodedPacket[] {
  if (video.length === 0) return []
  let start = video.findIndex((p) => p.pts >= startPts)
  if (start < 0) start = 0
  while (start > 0 && !video[start]?.keyframe) start -= 1
  if (!video[start]?.keyframe) {
    const firstKey = video.findIndex((p) => p.keyframe)
    if (firstKey < 0) return []
    start = firstKey
  }
  const out: EncodedPacket[] = []
  for (let i = start; i < video.length; i += 1) {
    const p = video[i]
    if (p === undefined) break
    if (p.pts > endPts) break
    out.push(p)
  }
  return out
}

export interface AroundWindowInput {
  readonly packets: readonly EncodedPacket[]
  /** Wall-clock instant the clip must be CENTRED on. */
  readonly aroundMs: number
  readonly preRollSec: number
  readonly postRollSec: number
  /** Wall clock at the moment the buffer was read (the newest packet's age). */
  readonly nowMs: number
}

/**
 * The window `[around − pre, around + post]`, selected by WALL CLOCK.
 *
 * `pts` is a stream clock with an arbitrary origin, so the mapping is anchored
 * on the newest packet: it arrived (near enough) at `nowMs`, and every earlier
 * packet is `newest.pts − p.pts` milliseconds older. Anchoring is what makes a
 * LATE call still correct — taking the tail instead would silently return the
 * last seconds of the buffer, i.e. a clip of the wrong moment, which is exactly
 * the failure the operator reported for the segment-sourced version.
 *
 * Empty when the buffer no longer reaches back to the moment; the caller
 * reports that rather than attaching the wrong footage.
 */
export function windowAround(input: AroundWindowInput): readonly EncodedPacket[] {
  const video = decodableVideo(input.packets)
  const newest = video[video.length - 1]
  const oldest = video[0]
  if (newest === undefined || oldest === undefined) return []
  const ptsAt = (wallMs: number): number => newest.pts - (input.nowMs - wallMs)
  const startPts = ptsAt(input.aroundMs - Math.max(0, input.preRollSec) * 1000)
  const endPts = ptsAt(input.aroundMs + Math.max(0, input.postRollSec) * 1000)
  // The moment itself must be inside the retained span — a window entirely
  // after the newest packet, or entirely before the oldest, holds no footage of
  // the event at all.
  const momentPts = ptsAt(input.aroundMs)
  if (momentPts > newest.pts || momentPts < oldest.pts) return []
  return sliceFromKeyframe(video, startPts, endPts)
}

/** Wall-clock span a selected window actually covers. */
export interface ClipCoverage {
  readonly fromTs: number
  readonly toTs: number
}

/**
 * What the selected window covers, in WALL CLOCK.
 *
 * The same anchoring {@link windowAround} selects by, and for the same reason:
 * `pts` is a stream clock with an arbitrary origin, so the only fixed point is
 * that the newest retained packet arrived (near enough) at `nowMs`. Every
 * earlier packet is `newest.pts − p.pts` milliseconds before it.
 *
 * This exists so a caller can say "the clip starts 4.1 s BEFORE the event"
 * instead of inferring it from a duration and a hope. A production whose
 * `fromTs` is after the event has no pre-roll, which is precisely the defect
 * that has to be visible rather than plausible.
 */
export function windowCoverage(
  packets: readonly EncodedPacket[],
  window: readonly EncodedPacket[],
  nowMs: number,
): ClipCoverage {
  const video = decodableVideo(packets)
  const newest = video[video.length - 1]
  const first = window[0]
  const last = window[window.length - 1]
  if (newest === undefined || first === undefined || last === undefined) {
    return { fromTs: nowMs, toTs: nowMs }
  }
  return {
    fromTs: nowMs - (newest.pts - first.pts),
    toTs: nowMs - (newest.pts - last.pts),
  }
}

export interface PreBufferClipInput {
  /** Playback rate; see `clipFfmpegArgs`. Absent = the 2x default. */
  readonly speed?: number
  /** The already-selected window — see {@link windowAround} / {@link tailWindow}. */
  readonly window: readonly EncodedPacket[]
  readonly format: 'gif' | 'mp4'
  readonly maxWidth: number
  readonly fps: number
  readonly spawn: (cmd: string, args: readonly string[]) => ChildProcess
  /** The node's pinned ffmpeg (D540). Required — there is no PATH default. */
  readonly ffmpegPath: string
  /**
   * SDP-harvested VPS/SPS/PPS, prepended to a keyframe that lacks them in-band.
   * Some cameras (Reolink native high) ship them ONLY in the SDP, and ffmpeg
   * cannot initialise its decoder without them.
   */
  readonly sdpParameterSets?: ReadonlyArray<Buffer> | null
  /** The rendition's own width, or 0 when unknown — the only input
   *  {@link clipCanCopy} needs that the window itself cannot supply. */
  readonly sourceWidth?: number
}

/** True for an HEVC packet — the container flag and the demuxer both differ. */
export function isHevcPacket(packet: EncodedPacket | undefined): boolean {
  const codec = (packet?.codec ?? 'h264').toLowerCase()
  return codec.includes('265') || codec.includes('hevc')
}

/**
 * The elementary stream ffmpeg reads on stdin.
 *
 * Broker packets are NOT guaranteed Annex-B — several sources carry
 * length-prefixed (AVCC/HVCC) access units, which ffmpeg's `-f h264` demuxer
 * silently fails to parse: it decodes nothing and exits with "received no
 * packets". This is the same conversion the WebRTC join path applies to the
 * pre-buffer, for the same reason.
 */
export function toElementaryStream(
  window: readonly EncodedPacket[],
  sdpParameterSets?: ReadonlyArray<Buffer> | null,
): Buffer {
  const hevc = isHevcPacket(window[0])
  const convert = hevc ? convertH265ToAnnexB : convertH264ToAnnexB
  const codec = hevc ? 'h265' : 'h264'
  const params =
    sdpParameterSets && sdpParameterSets.length > 0 ? Buffer.concat([...sdpParameterSets]) : null
  const parts: Buffer[] = []
  let primed = false
  for (const packet of window) {
    const annexB = convert(Buffer.from(packet.data))
    if (!primed) {
      // Prime ONCE, ahead of the first access unit: repeating the sets before
      // every keyframe duplicates them for the (many) cameras that already
      // carry them in-band.
      if (params !== null && !annexBHasParameterSets(annexB, codec)) parts.push(params)
      primed = true
    }
    parts.push(annexB)
  }
  return Buffer.concat(parts)
}

const RENDER_TIMEOUT_MS = 20_000

/** Playback rate when the caller does not choose one. */
export const DEFAULT_CLIP_SPEED = 2

/**
 * The widest an event clip is RE-ENCODED at — 720p.
 *
 * Only ever reached when the render already forced a decode (a speed other than
 * real time, or an H.265 source). At real time the width must stay the source's
 * own, because an identity scale is precisely what `clipCanCopy` looks for.
 *
 * Measured on a real 101 720p window, `-preset veryfast`: crf 23 at 1280 is
 * 254 KB and 0.23 s of encode, against the 922 KB the copy of the same window
 * carried. Capping wider renditions here costs nothing an operator can see on a
 * phone and keeps the burst bounded on a hub that is already busy.
 */
export const EVENT_CLIP_ENCODE_MAX_WIDTH = 1280

/**
 * Quality of a re-encoded event clip.
 *
 * 23, not the 28 this used when the encode was a fallback nobody chose. Measured
 * on the same 101 window: crf 23 is 254 KB and crf 28 is 145 KB **in the same
 * 0.23 s** — the preset buys the time, the crf only buys bytes. A notification
 * video is looked at, and 254 KB is far under the smallest cap any notifier
 * declares (pushover's 5 MiB).
 */
export const EVENT_CLIP_CRF = '23'

/**
 * The width to render an event clip at, given what the source is and whether
 * the caller asked for real time.
 *
 * One function because two call sites have to agree: the mux and the
 * `copy`/`encode` the production REPORTS. They disagreed once already — a
 * reported mode that does not match the render is a log line that lies.
 */
export function eventClipEncodeWidth(sourceWidth: number, speed: number): number {
  const source = Math.max(1, Math.round(sourceWidth))
  if (speed === 1) return source
  return Math.min(source, EVENT_CLIP_ENCODE_MAX_WIDTH)
}

// `ffmpegRate` moved to `@camstack/types` with the gif chain that uses it
// (D682); re-exported so existing importers of this module are unchanged.
export { ffmpegRate }

/**
 * Whether this render can COPY the camera's own H.264 instead of re-encoding it.
 *
 * The ring already holds the camera's elementary stream. Re-encoding it is only
 * ever necessary to change something, so the question is entirely "is anything
 * being changed":
 *
 *  - **A scale is a change.** Only when the caller asks for at least the
 *    source's own width is the `scale` filter an identity. `sourceWidth === 0`
 *    means nobody knows the source's width, and a copy would then be a guess —
 *    so it re-encodes, which is what it always did.
 *  - **A speed is a change.** `setpts` rewrites the timeline.
 *  - **H.265 is a change we WANT.** The mp4 lands on phones, and HEVC in an mp4
 *    is not universally playable there; transcoding an H.265 camera's clip to
 *    H.264 is the one case where the re-encode is the feature. (It is also why
 *    the clip ring remains the fallback for an H.265-only camera rather than
 *    something to delete.)
 *  - **A GIF is a re-encode by definition.**
 *
 * Copying is what makes a notification clip the camera's own 1280×720 picture
 * rather than `libx264 -crf 28` at 480 px — measured on 101, the same eleven
 * seconds are 224 KB copied against a visibly softer re-encode, and the gif
 * derived from it stops looking pixellated for the same reason.
 */
export function clipCanCopy(input: {
  readonly format: 'gif' | 'mp4'
  readonly maxWidth: number
  readonly speed?: number
  readonly hevc?: boolean
  /** The rendition's own width, or 0 when it is not known. */
  readonly sourceWidth: number
}): boolean {
  if (input.format !== 'mp4') return false
  if (input.hevc === true) return false
  if ((input.speed ?? DEFAULT_CLIP_SPEED) !== 1) return false
  return input.sourceWidth > 0 && input.maxWidth >= input.sourceWidth
}

/** ffmpeg args for the chosen container, reading an annex-B stream from stdin. */
export function clipFfmpegArgs(input: {
  readonly format: 'gif' | 'mp4'
  readonly maxWidth: number
  readonly fps: number
  /**
   * Playback rate. A notification clip is GLANCED at on a lock screen, not
   * watched, so the default is 2x — the operator sees the whole passage in
   * half the time. `1` is real time and emits no filter at all.
   */
  readonly speed?: number
  /** The demuxer must match the elementary stream, or nothing decodes. */
  readonly hevc?: boolean
  /**
   * Copy the video instead of re-encoding it — see {@link clipCanCopy}. The
   * caller decides, because only the caller knows the source's width.
   */
  readonly copyVideo?: boolean
}): readonly string[] {
  const scale = `scale=${input.maxWidth}:-2:flags=lanczos`
  const demuxer = input.hevc === true ? 'hevc' : 'h264'
  const speed = input.speed ?? DEFAULT_CLIP_SPEED
  // AFTER the fps decimation, never before: `fps` applied to an already
  // sped-up timeline yields twice the frames the caller asked for, and a GIF
  // pays for every one of them.
  //
  const setpts = speed !== 1 ? `,setpts=PTS/${speed}` : ''
  // For a GIF — and ONLY a GIF — the rate is declared AGAIN at `fps × speed`
  // after the compression. Not redundant; measured on a live 101 window.
  // `setpts` rewrites the timestamps but leaves the filter LINK still
  // advertising the decimation rate, and the gif muxer honours the link: a 4×
  // gif came out the right LENGTH carrying a QUARTER of the frames it should
  // have, and bigger for it, because frames that far apart share no pixels for
  // the gif's inter-frame transparency to delta away. An mp4 needs none of this
  // — its muxer writes the timestamps it is given, and pinning a rate there
  // would duplicate or drop frames instead.
  const gifSetpts = speed !== 1 ? `${setpts},fps=${ffmpegRate(input.fps * speed)}` : setpts
  if (input.format === 'gif') {
    return [
      '-y',
      '-f',
      demuxer,
      '-i',
      'pipe:0',
      // A GIF is 256 colours and WHICH 256 is the whole game. Without this the
      // encoder quantises to a fixed generic palette, which is why the output
      // looked banded and washed out on exactly what a camera produces: large
      // areas of near-identical tone. `palettegen` derives the palette from
      // THIS clip; `paletteuse` maps to it. One pass — `split` feeds both
      // branches, so the stream is still read once from the pipe (a two-pass
      // palette would need to rewind stdin, which a pipe cannot do).
      //
      // `stats_mode=diff` weights the palette towards what MOVES rather than
      // the static background, which is the subject in every clip we send.
      // Bayer dithering is deliberate over the default error-diffusion: it does
      // not crawl between frames, and a shimmering background on a looping GIF
      // reads as noise and costs bytes on every frame.
      '-filter_complex',
      `[0:v]fps=${ffmpegRate(input.fps)}${gifSetpts},${scale},split[a][b];` +
        `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop',
      '0',
      '-f',
      'gif',
      'pipe:1',
    ]
  }
  if (input.copyVideo === true) {
    // No `-vf` at all: a filter graph forces a decode, which is the entire
    // thing being avoided. The demuxer takes the frame rate from the SPS VUI
    // when the camera writes one (every camera on this fleet does — verified
    // with `ffprobe` on the muxed output, 10/1 for 101's 720p slot).
    return [
      '-y',
      '-f',
      demuxer,
      '-i',
      'pipe:0',
      '-c:v',
      'copy',
      // `frag_keyframe+empty_moov` because the output is a PIPE: a normal mp4
      // rewrites its header at the end, which a pipe cannot do.
      '-movflags',
      'frag_keyframe+empty_moov',
      '-an',
      '-f',
      'mp4',
      'pipe:1',
    ]
  }
  return [
    '-y',
    '-f',
    demuxer,
    '-i',
    'pipe:0',
    '-vf',
    `${scale}${setpts}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    EVENT_CLIP_CRF,
    '-pix_fmt',
    'yuv420p',
    // `frag_keyframe+empty_moov` because the output is a PIPE: a normal mp4
    // rewrites its header at the end, which a pipe cannot do.
    '-movflags',
    'frag_keyframe+empty_moov',
    '-an',
    '-f',
    'mp4',
    'pipe:1',
  ]
}

/**
 * Feed the window to ffmpeg and collect the muxed bytes.
 *
 * The child is GUARANTEED terminated before this settles — these renders run on
 * every notification that asks for video, so a leaked ffmpeg here accumulates
 * on the streaming node until someone notices the host is slow.
 */
export async function renderPreBufferClip(input: PreBufferClipInput): Promise<Buffer> {
  const window = input.window
  if (window.length === 0) throw new Error('pre-buffer holds no decodable video for this window')

  return new Promise<Buffer>((resolve, reject) => {
    const hevc = isHevcPacket(window[0])
    const copyVideo = clipCanCopy({
      format: input.format,
      maxWidth: input.maxWidth,
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      hevc,
      sourceWidth: input.sourceWidth ?? 0,
    })
    const proc = input.spawn(input.ffmpegPath, clipFfmpegArgs({ ...input, hevc, copyVideo }))
    const chunks: Buffer[] = []
    let stderrTail = ''
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (err: Error | null, out?: Buffer): void => {
      if (done) return
      done = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      try {
        proc.stdout?.removeAllListeners()
        proc.stderr?.removeAllListeners()
        proc.stdin?.destroy()
      } catch {
        /* nothing to detach */
      }
      if (err !== null) reject(err)
      else resolve(out ?? Buffer.alloc(0))
    }

    timer = setTimeout(
      () => settle(new Error('pre-buffer clip render timed out')),
      RENDER_TIMEOUT_MS,
    )
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c))
    proc.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-400)
    })
    proc.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    proc.on('close', (code) => {
      if (code !== 0) {
        settle(new Error(`ffmpeg pre-buffer clip exited ${code}: ${stderrTail}`))
        return
      }
      const out = Buffer.concat(chunks)
      settle(out.byteLength === 0 ? new Error('pre-buffer clip produced no bytes') : null, out)
    })

    // A broken pipe (ffmpeg exiting early) must not crash the process.
    proc.stdin?.on('error', () => {})
    proc.stdin?.write(toElementaryStream(window, input.sdpParameterSets))
    proc.stdin?.end()
  })
}
