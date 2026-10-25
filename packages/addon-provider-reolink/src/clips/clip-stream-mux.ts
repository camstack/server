/**
 * The pure half of the STREAMED clip: what the mux is told, how the rate is
 * probed, and how a peer that stops taking bytes is caught.
 *
 * ## What a stream is, and is not
 *
 * `clip-mux.ts` makes a FILE: the whole cmd 5 transfer lands, is judged, and
 * ONE ffmpeg writes an MP4 with `moov` first. The player then gets a length,
 * `Range`, seek and a scratch copy (D549 22, D567, D568). This module serves
 * the same recording as it ARRIVES from the camera, and three of those rules
 * are stated here as not applying to a stream, with the reason each:
 *
 * - **`+faststart` cannot exist.** It is a second pass over a finished file
 *   that moves `moov` to the front. A stream has no finished file, so the
 *   container is fragmented (`frag_keyframe+empty_moov+default_base_moof`):
 *   an empty `moov` first, then one fragment per keyframe. A consequence the
 *   route states in its own headers: the response has no length, so it is not
 *   `Range`-able and carries no duration until the last fragment.
 * - **The MEASURED rate (D567) is measured over a PROBE, not the file.** `-r`
 *   is an input option and must be known before ffmpeg is spawned, and the
 *   whole-file measurement exists only after the last access unit. The probe
 *   is the first {@link CLIP_STREAM_RATE_PROBE_ACCESS_UNITS} access units, or
 *   every unit of a clip shorter than that, and it goes through the library's
 *   own `estimateVideoTiming` so there is one rate derivation, not two. What
 *   D567 forbids stays forbidden, and D604 closes the back door it left: a
 *   rate that did not come from timestamps is not handed to `-r`, and it is
 *   not OMITTED either — omission is not "no rate", it is ffmpeg's own
 *   default, which is the elementary stream's nominal number, the one that
 *   said 30 where a hub child delivered 15.019. The probe is widened
 *   ({@link CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS}) and then the STREAM is
 *   refused by name. `buildClipStreamMuxArgs` still accepts `null` and still
 *   omits `-r` for it, because that is what the flag means; no producer
 *   passes it.
 * - **The AAC is TRANSCODED, not copied (D600).** The file path copies ADTS
 *   into the MP4 because its consumer is a player that decodes AAC. A stream's
 *   consumer is a WebRTC session, which speaks Opus or µ-law and never AAC, so
 *   the one ffmpeg this module already spawns gains a SECOND input (`pipe:3`,
 *   the ADTS frames the same decoder hands over) and encodes it to the codec
 *   the caller asked for on the dial. Doing it here rather than at the broker
 *   is what keeps the second hop a byte copy: an Opus sample in MP4 is exactly
 *   the packet an RTP sender puts on the wire, so nothing downstream decodes,
 *   and no second backlog exists outside the consumer's own bound.
 *
 *   Two measured facts shape it. **µ-law cannot go in MP4** — `ffmpeg 7.1`
 *   answers `Could not find tag for codec pcm_mulaw in stream #1` — so a
 *   `pcmu` ask is muxed into `mov`, which carries the `ulaw` sample entry and
 *   is otherwise the same boxes. And **the audio input must exist before the
 *   spawn**: ffmpeg probes every input before it writes a byte of output, so a
 *   `pipe:3` that never delivers would hold the VIDEO hostage. The decision is
 *   therefore taken once, from audio the decoder has already handed over, and
 *   a stream that never produced an AAC frame in time is muxed silent and says
 *   so by name.
 *
 * ## The peer that never drains (D447)
 *
 * The data plane hands the addon the real `res`, so `write()`'s return is the
 * socket's own word on whether it took the chunk. A stream has two such hops —
 * the access units into ffmpeg's stdin, and ffmpeg's stdout into the socket —
 * and neither may be allowed to pile up in process memory for ever, because
 * the SOURCE cannot be paused: the camera pushes cmd 5 chunks at its own pace
 * and the library exposes no pause. {@link createDrainGate} is the rule on
 * both hops: a `write()` that returned `false` arms a timer; `drain` disarms
 * it; a timer that fires is a peer that has stopped taking bytes and the
 * stream is CUT, by name.
 */
import { estimateVideoTiming } from '@apocaliss92/nodelink-js'

import type { ClipVideoType } from './clip-mux.js'

/**
 * Access units held back before ffmpeg is spawned, so `-r` can be measured.
 *
 * Sixteen is about one second at the 15 fps every sub file on this fleet
 * delivers (D567: 15 on 592 sub, 15.019 on a hub child) and under two thirds
 * of one at 25. It is the smallest window over which `roundRecordingFps`
 * snaps reliably: the library snaps 14–16 → 15 and 23–26 → 25, and a single
 * frame of jitter over fifteen intervals moves the estimate by under 7 %.
 * Held in memory, not on disk: these are the frames in flight, not a scratch.
 */
export const CLIP_STREAM_RATE_PROBE_ACCESS_UNITS = 16

/**
 * How far the probe may be EXTENDED when the first window could not measure.
 *
 * The probe is a window, not a deadline: a window whose timestamps say
 * nothing (they are equal, or they go backwards because the transfer before
 * this one is still arriving — D604) is answered by holding more units, not
 * by muxing at a rate nobody measured. 128 units is about eight seconds at
 * 15 fps and a few MiB of held access units, and past it a stream that still
 * cannot say its own rate is REFUSED by name rather than handed to ffmpeg's
 * own default — which is the info header's nominal number, the one D567
 * exists to refuse.
 */
export const CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS = 128

/**
 * How long a hop may sit on a `write()` that returned `false` before the
 * stream is cut. Ten seconds is two orders of magnitude over the largest
 * inter-chunk gap measured inside a live transfer (59 ms) and short enough
 * that a peer that walked away does not hold the camera's one session for the
 * length of the clip.
 */
export const CLIP_STREAM_DRAIN_TIMEOUT_MS = 10_000

/**
 * Grace for ffmpeg to flush after its stdin was ended. A mux that has not
 * exited by then is hung on input it cannot parse and is killed, so a stream
 * never holds a process past its transfer.
 */
export const CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS = 15_000

/** The fragmented container a stream is muxed into — see the file header. */
export const CLIP_STREAM_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof'

export type ClipStreamFpsSource = 'timestamps' | 'unmeasured'

export interface ClipStreamRate {
  /** The rate `-r` gets, or `null` — never the info header's number (D567). */
  readonly fps: number | null
  readonly fpsSource: ClipStreamFpsSource
  /** How many access units the probe was measured over. */
  readonly accessUnits: number
}

/**
 * The rate the probe measured, through the library's one derivation.
 *
 * `estimateVideoTiming` falls back to the info header when the timestamps
 * cannot say; that fallback is REFUSED here (`fpsSource: 'unmeasured'`), as
 * D567 says, so a guess is never handed to `-r` under a measurement's name.
 */
export function probeClipStreamRate(timestampsUs: readonly number[]): ClipStreamRate {
  const timing = estimateVideoTiming({ timestampsUs })
  if (timing.fpsSource !== 'timestamps' || timing.fps === null) {
    return { fps: null, fpsSource: 'unmeasured', accessUnits: timestampsUs.length }
  }
  return { fps: timing.fps, fpsSource: 'timestamps', accessUnits: timestampsUs.length }
}

/** The audio codec a stream is muxed with — never `none`, which is absence. */
export type ClipStreamAudioCodec = 'opus' | 'pcmu'

/**
 * The fd the ADTS frames are written on, and the input ffmpeg reads them from.
 *
 * Not `pipe:0` — that is the video elementary stream — and not a file, because
 * nothing about a stream touches a disk. `stdio` index 3 on the spawn is
 * `pipe:3` to ffmpeg.
 */
export const CLIP_STREAM_AUDIO_FD = 3

/**
 * Mono, because a WebRTC session sends one channel and a camera's microphone
 * is one. Stated once so the encoder and the consumer cannot disagree about
 * it: a channel-count mismatch is the audio bug that passes every unit test.
 */
export const CLIP_STREAM_AUDIO_CHANNELS = 1

/** Opus at 48 kHz — the only rate the codec has, and the session's RTP clock. */
export const CLIP_STREAM_OPUS_RATE_HZ = 48_000
/** µ-law at 8 kHz — the PCMU RTP clock. */
export const CLIP_STREAM_PCMU_RATE_HZ = 8_000
/**
 * Bitrate for the Opus encode. A camera microphone at 16 kHz mono carries
 * nothing 24 kbit/s loses, and it is what the recorded path's own AAC→Opus
 * fallback uses (`segment-audio-js.ts`), so the two clip paths sound alike.
 */
export const CLIP_STREAM_OPUS_BITRATE = '24k'

/**
 * The container a stream is muxed into, for a given audio ask.
 *
 * MEASURED, not chosen: ffmpeg's MP4 muxer refuses `pcm_mulaw`
 * (`Could not find tag for codec pcm_mulaw in stream #1`), and its MOV muxer
 * takes it as a `ulaw` sample entry. The boxes a consumer walks are the same
 * either way — `ftyp`, an empty `moov`, then `moof`+`mdat` — so this changes
 * the content type and nothing else.
 */
export function clipStreamContainerFor(audio: ClipStreamAudioCodec | null): 'mp4' | 'mov' {
  return audio === 'pcmu' ? 'mov' : 'mp4'
}

/** What the route puts on `content-type` for {@link clipStreamContainerFor}. */
export function clipStreamContentTypeFor(audio: ClipStreamAudioCodec | null): string {
  return clipStreamContainerFor(audio) === 'mov' ? 'video/quicktime' : 'video/mp4'
}

export interface ClipStreamMuxArgsInput {
  readonly videoType: ClipVideoType
  /** {@link ClipStreamRate.fps} — `null` omits `-r` entirely. */
  readonly fps: number | null
  /**
   * The codec the second input is encoded to, or `null` for a silent mux.
   *
   * `null` omits the input ENTIRELY — it does not feed an empty pipe. ffmpeg
   * probes every input before writing output, so an input that never delivers
   * would stall the video with it.
   */
  readonly audio: ClipStreamAudioCodec | null
}

/**
 * One ffmpeg, stdin to stdout, fragmented, with an optional second input.
 *
 * Mirrors `buildClipMuxArgs` where a stream can: the demuxer is named from
 * the DETECTED codec (the BcMedia header lies on a hub child), `-r` is an
 * input option before its own `-i`, and the video is copied. Where it
 * cannot — `+faststart` — the file header says why; where it now can — the
 * audio input — it is an ENCODE rather than the file path's copy, because
 * this output is consumed by a WebRTC sender and not by a player.
 */
export function buildClipStreamMuxArgs(input: ClipStreamMuxArgsInput): readonly string[] {
  const demuxer = input.videoType === 'H265' ? 'hevc' : 'h264'
  const audio = input.audio
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(input.fps !== null && Number.isFinite(input.fps) && input.fps > 0
      ? ['-r', String(input.fps)]
      : []),
    '-f',
    demuxer,
    '-i',
    'pipe:0',
    // The second input: self-delimiting ADTS frames, declared as such, on the
    // fd the producer writes the decoder's own audio frames to.
    ...(audio !== null ? ['-f', 'aac', '-i', `pipe:${String(CLIP_STREAM_AUDIO_FD)}`] : []),
    // Mapping is explicit once there are two inputs: ffmpeg's default picks
    // one stream per type and would silently drop the second input's audio if
    // the video input ever carried one.
    ...(audio !== null ? ['-map', '0:v', '-map', '1:a'] : []),
    '-c:v',
    'copy',
    ...(audio === 'opus'
      ? [
          '-c:a',
          'libopus',
          '-ar',
          String(CLIP_STREAM_OPUS_RATE_HZ),
          '-ac',
          String(CLIP_STREAM_AUDIO_CHANNELS),
          '-b:a',
          CLIP_STREAM_OPUS_BITRATE,
        ]
      : []),
    ...(audio === 'pcmu'
      ? [
          '-c:a',
          'pcm_mulaw',
          '-ar',
          String(CLIP_STREAM_PCMU_RATE_HZ),
          '-ac',
          String(CLIP_STREAM_AUDIO_CHANNELS),
        ]
      : []),
    '-movflags',
    CLIP_STREAM_MOVFLAGS,
    '-f',
    clipStreamContainerFor(audio),
    'pipe:1',
  ]
}

/** The reason a hop stopped taking bytes, as it reaches the log line. */
export type ClipStreamHop = 'mux-stdin' | 'mux-audio-stdin' | 'peer'

export interface DrainGateDeps {
  readonly timeoutMs: number
  /** Fires when a `false` write has not been drained inside `timeoutMs`. */
  onStall(): void
}

type DrainTimer = ReturnType<typeof setTimeout>

export interface DrainGate {
  /** Feed every `write()`'s return value here. */
  wrote(accepted: boolean): void
  /** The hop's `drain` event. */
  drained(): void
  /** True while a `false` write is waiting on `drain`. */
  waiting(): boolean
  dispose(): void
}

/**
 * The D447 rule as a state machine, so it can be proved without a socket.
 *
 * A `false` write ARMS the timer; further `false` writes while it is armed do
 * not push the deadline out. `drain` — the hop's own word that it took what
 * it held — disarms it. Stall fires at most once, and a disposed gate is
 * silent for ever.
 *
 * **A gate must be DISPOSED when its hop stops taking bytes for good** — when
 * the input is ended, and when the run is over. Node emits no `drain` after
 * `end()` (`afterWrite` guards it with `!state.ending`), so a gate armed at
 * EOF can never be disarmed: it fires `timeoutMs` later and severs a stream
 * that was already served. Measured on real bytes: a 42 s clip delivered at
 * 18× leaves the audio pipe armed at EOF every time, with zero `drain`
 * events after `end()`. (D604)
 */
export function createDrainGate(deps: DrainGateDeps): DrainGate {
  let handle: DrainTimer | null = null
  let stalled = false
  const disarm = (): void => {
    if (handle !== null) clearTimeout(handle)
    handle = null
  }
  return {
    wrote(accepted) {
      if (accepted || handle !== null || stalled) return
      handle = setTimeout(() => {
        handle = null
        if (stalled) return
        stalled = true
        deps.onStall()
      }, deps.timeoutMs)
    },
    drained() {
      disarm()
    },
    waiting() {
      return handle !== null
    },
    dispose() {
      disarm()
      stalled = true
    },
  }
}
