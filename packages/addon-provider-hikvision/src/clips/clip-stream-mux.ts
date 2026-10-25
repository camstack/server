/**
 * The pure half of a Hikvision clip's mux: what ffmpeg is told, and how a hop
 * that stops taking bytes is caught.
 *
 * Deliberately the same SHAPE as the Reolink clip stream's mux (D597/D600/
 * D604) — one ffmpeg, stdin to stdout, fragmented, an optional second input on
 * `pipe:3`, a drain gate on every hop — because the two providers feed the
 * same broker through the same contract and a second idea of what a clip
 * stream is would be a second thing to keep in step. What differs is the
 * inputs, and each difference is measured:
 *
 * - **The video input is what the RTSP replay depacketized**, an Annex-B
 *   elementary stream, named from the SDP's `a=rtpmap` (H.265 on this fleet).
 *   `ContentMgmt/search` says `H.264-BP` for the same media and is never read
 *   for this.
 * - **The audio input is µ-law, not AAC.** The archive carries `PCMU/8000`,
 *   which IS the codec a WebRTC session negotiates as `pcmu`, so a `pcmu` ask
 *   is a COPY here where Reolink pays a transcode. An `opus` ask is still an
 *   encode, and it is the same encoder settings the Reolink path uses so the
 *   two sound alike.
 * - **µ-law still cannot go in MP4.** ffmpeg 7.1: `Could not find tag for
 *   codec pcm_mulaw in stream #1`. The `mov` brand takes it as a `ulaw` sample
 *   entry and is otherwise the same boxes, so a `pcmu` stream is
 *   `video/quicktime` — the same rule D600 measured, reached again here.
 * - **The second input still must exist before the spawn.** ffmpeg probes
 *   every input before it writes a byte of output, so an audio pipe that never
 *   delivers holds the VIDEO hostage. The decision is taken once, from audio
 *   already in hand.
 *
 * ## `-r` is passed, never omitted
 *
 * See `clip-replay-rate.ts`. `null` omits the flag because that is what the
 * flag means, and no producer passes one: a pass that cannot measure its own
 * rate is refused before a byte reaches the peer.
 */

import type { Readable, Writable } from 'node:stream'

import type { RtspVideoCodec } from './rtsp/rtsp-sdp.js'

/** The fragmented container a STREAM is muxed into — no `moov` to wait for. */
export const CLIP_STREAM_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof'

/** The container a FILE is muxed into: `moov` first, so a player can seek. */
export const CLIP_FILE_MOVFLAGS = '+faststart'

/** The fd the µ-law payloads are written on — `pipe:3` to ffmpeg. */
export const CLIP_STREAM_AUDIO_FD = 3

/** Mono: a camera microphone is one channel and a session sends one. */
export const CLIP_STREAM_AUDIO_CHANNELS = 1
/** Opus has one rate, and it is the session's RTP clock. */
export const CLIP_STREAM_OPUS_RATE_HZ = 48_000
/** The PCMU RTP clock, and the rate the archive already is. */
export const CLIP_STREAM_PCMU_RATE_HZ = 8_000
/** What the Reolink clip path encodes Opus at, so the two sound alike. */
export const CLIP_STREAM_OPUS_BITRATE = '24k'

/**
 * How long a hop may sit on a `write()` that returned `false` before the
 * stream is cut (D447). Ten seconds, the same bound the Reolink path uses and
 * for the same reason: two orders of magnitude over any inter-packet gap, and
 * short enough that a peer that walked away does not hold the camera's replay
 * session for the length of the clip.
 */
export const CLIP_STREAM_DRAIN_TIMEOUT_MS = 10_000

/** Grace for ffmpeg to flush after its inputs were ended. */
export const CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS = 15_000

/**
 * How much of an input ffmpeg may READ before it will write a header.
 *
 * ffmpeg probes every input to discover what is in it, and both defaults are
 * enormous for this use — `probesize` 5 MB, `analyzeduration` 5 s — which here
 * are paid in the operator's wait, because a Hikvision replay arrives at 1×
 * and "5 MB of input" is seconds of wall clock. `-analyzeduration 0` goes with
 * it: the demuxer is named (`-f hevc`/`-f h264`, from the SDP's own
 * `a=rtpmap`), the rate is named (`-r`, measured), and the µ-law input is
 * named down to its sample rate. A probe can only re-derive what was stated.
 *
 * **256 KiB, and the number is a compromise between two measurements.** This
 * shipped at 32 KiB, which is six per cent of ONE access unit — the first unit
 * of a 3840×2160 HEVC replay on 1436 measures **550 354 bytes**, a whole 4K
 * keyframe with its parameter sets — and a bound that cannot hold a single
 * frame is uncomfortable whatever it gets away with. But widening it is not
 * free and it fixes nothing: measured against the pinned jellyfin 8.1.2 build
 * on the real camera, first byte to the peer was **721 ms at 32 KiB, 752 ms at
 * 256 KiB, 1 126 ms at 768 KiB**. 256 KiB buys eight times the headroom for
 * 31 ms.
 *
 * **It is explicitly NOT the cause of the header-and-no-media failure** that
 * cost the fleet an afternoon, and it was the first suspect. Every probe size
 * from 32 KiB to 768 KiB reproduced that fault identically, and removing the
 * flags altogether reproduced it too; the cause was
 * {@link CLIP_STREAM_MAX_INTERLEAVE_DELTA_US}. Written down so the hypothesis
 * is not re-tried.
 */
export const CLIP_MUX_PROBE_BYTES = 256 * 1024

/**
 * How long the muxer may hold one track's packets WAITING for the other.
 *
 * **This is the whole reason a clip with sound would not play.** Measured on
 * 1436, 2026-09-23, through the real producer against the real camera with the
 * pinned build: a SILENT stream delivered 1 299 KiB to the peer by the
 * halfway point of a six-second clip, and the same clip with `opus` or `pcmu`
 * delivered **1 KiB** — the init segment, and nothing else — until the inputs
 * ENDED, at which point all 3.78 MB arrived in one burst. From the operator's
 * own session: 129 access units in, `bytesOut: 1298` out, `pushed: 0` on the
 * broker, and a player that gave up after 10.6 s with nothing to show.
 *
 * ffmpeg buffers packets to interleave two inputs, and with video on stdin and
 * µ-law on `pipe:3` it decided to wait rather than write. It is not a rate
 * mismatch — the two timelines measured 4.80 s of video against 4.80 s of
 * audio, a ratio of 1.000 — it is the muxer's own interleaving window, and for
 * a LIVE fragmented stream any window at all is wrong.
 *
 * **`0` does not mean "no window". It means UNLIMITED**, and it reproduced the
 * fault exactly. The value has to be small and positive. 100 ms is two and a
 * half of this camera's 40 ms µ-law frames — long enough that ordinary jitter
 * does not split a fragment, short enough that no consumer notices.
 *
 * With it, all three audio asks deliver ~1 278 KiB by the same halfway point.
 */
export const CLIP_STREAM_MAX_INTERLEAVE_DELTA_US = 100_000

/**
 * How long a fragment may run before it is CLOSED, keyframe or not.
 *
 * `frag_keyframe` alone closes a fragment only at the next keyframe, so the
 * first fragment a peer can see spans a whole GOP. On 1436 the GOP is 50
 * frames at 12.5 fps — 4 s of media, and at 1× arrival that is 4 s of the
 * operator's wait for a first picture that was already decodable.
 *
 * Half a second, so a fragment closes on the frag_duration long before it
 * closes on a keyframe. Measured on the same clip: the first media fragment
 * moved from 2269 ms to 219 ms, and the whole 18 s output grew by 4 044 bytes
 * (0.04 %) — the cost of a `moof` every half second.
 *
 * Only the STREAM form takes it. The file form is not fragmented.
 */
export const CLIP_STREAM_FRAG_DURATION_US = 500_000

/** The audio codec a stream is muxed with — never `none`, which is absence. */
export type ClipStreamAudioCodec = 'opus' | 'pcmu'

/**
 * MEASURED, not chosen: ffmpeg's MP4 muxer refuses `pcm_mulaw` and its MOV
 * muxer takes it. The boxes a consumer walks are the same either way.
 */
export function clipStreamContainerFor(audio: ClipStreamAudioCodec | null): 'mp4' | 'mov' {
  return audio === 'pcmu' ? 'mov' : 'mp4'
}

/** What the route puts on `content-type` for {@link clipStreamContainerFor}. */
export function clipStreamContentTypeFor(audio: ClipStreamAudioCodec | null): string {
  return clipStreamContainerFor(audio) === 'mov' ? 'video/quicktime' : 'video/mp4'
}

export interface ClipMuxArgsInput {
  /** From the SDP's `a=rtpmap`, never from `search`'s `codecType`. */
  readonly videoCodec: RtspVideoCodec
  /** {@link ReplayRate.fps} — `null` omits `-r` entirely. */
  readonly fps: number | null
  /**
   * The codec the second input is encoded to, or `null` for a silent mux.
   *
   * `null` omits the input ENTIRELY rather than feeding an empty pipe.
   */
  readonly audio: ClipStreamAudioCodec | null
}

function audioArgs(audio: ClipStreamAudioCodec | null): readonly string[] {
  if (audio === null) return []
  if (audio === 'pcmu') {
    // A COPY. The archive IS µ-law at 8 kHz mono, which is exactly what a
    // `pcmu` session sends, so re-encoding it would be a decode and an encode
    // that cannot improve anything and can only lose.
    return ['-c:a', 'copy']
  }
  return [
    '-c:a',
    'libopus',
    '-ar',
    String(CLIP_STREAM_OPUS_RATE_HZ),
    '-ac',
    String(CLIP_STREAM_AUDIO_CHANNELS),
    '-b:a',
    CLIP_STREAM_OPUS_BITRATE,
  ]
}

function commonArgs(input: ClipMuxArgsInput): readonly string[] {
  const demuxer = input.videoCodec === 'h265' ? 'hevc' : 'h264'
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(input.fps !== null && Number.isFinite(input.fps) && input.fps > 0
      ? ['-r', String(input.fps)]
      : []),
    // Input options, so they apply to the input that FOLLOWS them — and they
    // are repeated on the audio input below for the same reason. See
    // {@link CLIP_MUX_PROBE_BYTES}.
    '-analyzeduration',
    '0',
    '-probesize',
    String(CLIP_MUX_PROBE_BYTES),
    '-f',
    demuxer,
    '-i',
    'pipe:0',
    // The second input: raw µ-law, declared with its rate and channel count
    // because a headerless PCM stream carries neither. Getting either wrong is
    // the audio bug that passes every unit test and arrives as a chipmunk.
    ...(input.audio !== null
      ? [
          '-analyzeduration',
          '0',
          '-probesize',
          String(CLIP_MUX_PROBE_BYTES),
          '-f',
          'mulaw',
          '-ar',
          String(CLIP_STREAM_PCMU_RATE_HZ),
          '-ac',
          String(CLIP_STREAM_AUDIO_CHANNELS),
          '-i',
          `pipe:${String(CLIP_STREAM_AUDIO_FD)}`,
        ]
      : []),
    // Explicit once there are two inputs: ffmpeg's default picks one stream
    // per type and would silently drop the second input's audio if the video
    // input ever carried one.
    ...(input.audio !== null ? ['-map', '0:v', '-map', '1:a'] : []),
    '-c:v',
    'copy',
    ...audioArgs(input.audio),
  ]
}

/** One ffmpeg, stdin to stdout, FRAGMENTED — the broker's stream (D597). */
export function buildClipStreamMuxArgs(input: ClipMuxArgsInput): readonly string[] {
  return [
    ...commonArgs(input),
    '-movflags',
    CLIP_STREAM_MOVFLAGS,
    '-frag_duration',
    String(CLIP_STREAM_FRAG_DURATION_US),
    // Without this, ffmpeg's AVIO buffer holds the init segment — 942 bytes on
    // a real clip — until 32 KiB has accumulated behind it, so the peer sees
    // nothing at all until the first media fragment closes. A fragmented
    // stream exists to be consumed as it is produced; a buffer in front of it
    // is the one thing that cannot be allowed.
    // THE flag that makes a two-track clip stream actually stream. See
    // {@link CLIP_STREAM_MAX_INTERLEAVE_DELTA_US}.
    '-max_interleave_delta',
    String(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US),
    '-flush_packets',
    '1',
    '-f',
    clipStreamContainerFor(input.audio),
    'pipe:1',
  ]
}

/**
 * One ffmpeg writing a FINISHED file — the player's URL and the export's
 * bytes.
 *
 * `+faststart` is a second pass that moves `moov` to the front, so the output
 * must be seekable: this form writes to a PATH and never to `pipe:1`. That is
 * the whole difference from the stream, and it is why the two shapes are two
 * functions rather than one with a flag.
 */
export function buildClipFileMuxArgs(
  input: ClipMuxArgsInput,
  outputPath: string,
): readonly string[] {
  // `-f mp4` EXPLICITLY. ffmpeg picks a muxer from the extension, and the
  // scratch writes to `<key>.mp4.<pid>.part` so a crash never leaves a
  // truncated file under the real key — an extension ffmpeg answers
  // `Unable to choose an output format` to. Measured on a real clip; the
  // spec's fixture path ended in `.mp4` and never reached it.
  return [...commonArgs(input), '-movflags', CLIP_FILE_MOVFLAGS, '-f', 'mp4', '-y', outputPath]
}

/**
 * The extra fd of a four-pipe spawn, as something that can be WRITTEN to.
 *
 * `ChildProcess.stdio` is typed `Readable | Writable | null` per slot because
 * a spawn may declare either direction. A type guard rather than a cast: a
 * producer that reached for the wrong direction should fail to compile, not
 * throw at the first audio frame of a live stream.
 */
export function writableStdio(stream: Readable | Writable | null | undefined): Writable | null {
  if (stream === null || stream === undefined) return null
  return 'write' in stream ? stream : null
}

/** The reason a hop stopped taking bytes, as it reaches the log line. */
export type ClipStreamHop = 'mux-stdin' | 'mux-audio-stdin' | 'peer'

export interface DrainGateDeps {
  readonly timeoutMs: number
  onStall(): void
  /**
   * Is the hop's consumer demonstrably still WORKING, though it is not taking
   * bytes from this pipe?
   *
   * Absent for a hop where the two questions are the same — a peer that is not
   * taking bytes is a peer that has stopped. They are NOT the same for
   * ffmpeg's µ-law input: fd 3 holds 64 KiB, which is eight seconds of 8 kHz
   * sound, and once the muxer is that far ahead on audio it stops reading and
   * Node never emits another `drain`. Measured on 1436, 2026-09-23: the gate
   * severed a stream that had already delivered 9 993 026 bytes over 251
   * access units. A hop that is quiet while its owner is still producing has
   * not stalled, so the timer RE-ARMS rather than firing — and a consumer
   * that then really dies is still caught one window later.
   */
  stillMoving?(): boolean
}

export interface DrainGate {
  /** Feed every `write()`'s return value here. */
  wrote(accepted: boolean): void
  /** The hop's `drain` event. */
  drained(): void
  waiting(): boolean
  dispose(): void
}

/**
 * The D447 rule as a state machine, so it can be proved without a socket.
 *
 * A `false` write ARMS the timer; `drain` disarms it; a timer that fires is a
 * peer that stopped taking bytes and the stream is cut, by name.
 *
 * **A gate must be DISPOSED when its hop stops taking bytes for good.** Node
 * emits no `drain` after `end()`, so a gate armed at EOF can never be
 * disarmed: it fires `timeoutMs` later and severs a stream that was already
 * served. That is D604's second defect, and it is not the rare case — it is
 * the ordinary one, measured on every run of the Reolink path.
 */
export function createDrainGate(deps: DrainGateDeps): DrainGate {
  let handle: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  const disarm = (): void => {
    if (handle !== null) clearTimeout(handle)
    handle = null
  }
  return {
    wrote(accepted) {
      if (accepted || handle !== null || stalled) return
      const arm = (): void => {
        handle = setTimeout(() => {
          handle = null
          if (stalled) return
          // Not hungry is not dead. Re-armed, never forgiven for ever.
          if (deps.stillMoving?.() === true) {
            arm()
            return
          }
          stalled = true
          deps.onStall()
        }, deps.timeoutMs)
      }
      arm()
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
