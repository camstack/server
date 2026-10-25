/**
 * The composite's ffmpeg plan: N decodes, ONE composition, ONE encode, in ONE
 * child.
 *
 * This file composes the SHARED builder in `@camstack/types`
 * (`ffmpeg/invocation.ts`) — it deliberately builds no argv of its own. The
 * repo has already shipped two argv builders that disagreed about hardware,
 * and `scripts/check-ffmpeg-primitive.ts` exists to refuse a third.
 *
 * Why one child rather than one per source: frames never cross a process
 * boundary at frame-rate (D9/D18). A composition needs every source's DECODED
 * pixels at the same instant, so the composition has to happen where the
 * decodes already are. What leaves this child is a compressed elementary
 * stream in an MPEG-TS wrapper, and nothing else.
 */
import type {
  FfmpegInputPlan,
  FfmpegInvocation,
  FfmpegVideoEncodePlan,
  FfmpegVideoEncoderId,
} from '@camstack/types'
import { GRID_WIRE_CONTAINER } from './grid-wire-format.js'
import { buildGridFilterGraph, type GridLayout } from './grid-filter-graph.js'

/** One ffmpeg input: the camera it is, and the URL this child will dial. */
export interface GridStreamSource {
  /** The SOURCE camera. Carried so every log line about it can be tagged. */
  readonly deviceId: number
  /**
   * A broker restream URL, acquired through `streamBroker.getStreamWithCodec`.
   * That is the single demand-counted entry point: it rides the broker's ONE
   * source dial instead of opening a second connection to the camera.
   */
  readonly url: string
}

export interface GridStreamInvocationInput {
  readonly layout: GridLayout
  /** In ffmpeg INPUT ORDINAL order — `sources[n]` is the graph's `[n:v]`. */
  readonly sources: readonly GridStreamSource[]
  readonly decodeHwAccel: string | null
  readonly encoder: FfmpegVideoEncoderId
  readonly fps: number
  readonly bitrateKbps: number
}

/**
 * The encoder preset. `veryfast` because a composite is the one encode in the
 * cluster whose input cost already scales with the number of cameras in it —
 * the decode side of a 2x2 is four decodes — so the encode side is where a
 * cheap default matters most.
 */
const PRESET = 'veryfast'

/**
 * `-tune zerolatency`, and this one is worth several SECONDS.
 *
 * x264's defaults hold frames before emitting any: a rate-control lookahead of
 * ~40 frames plus B-frames. At a composite's 10 fps that lookahead alone is
 * about four seconds of picture sitting inside the encoder — the operator saw
 * it as "ritardi di secondi" and it was not the network, the relay or the
 * broker. `zerolatency` sets `rc-lookahead=0`, `sync-lookahead=0` and
 * `bframes=0`, which is exactly the trade a live composite wants: a few percent
 * more bitrate for the same picture, in exchange for the encoder emitting each
 * frame as it arrives.
 *
 * It is not a preset. `veryfast` says how hard the encoder searches; this says
 * how long it is allowed to WAIT, and the two are independent.
 */
const TUNE = 'zerolatency'

/** yuv420p: the only pixel format every consumer of a CamStack profile reads. */
const PIXEL_FORMAT = 'yuv420p'

/**
 * Key-frame cadence, in seconds.
 *
 * Two things ride on this and they pull the same way. A recorder cuts its
 * segments on a key frame, so a long GOP produces long segments and a scrub
 * that lands far from where the operator clicked. And every consumer — the
 * broker's reader included — starts at a key frame, so the GOP is the WORST
 * CASE wait before a grid appears at all: at two seconds a viewer could stare
 * at nothing for two seconds after pressing play.
 *
 * One second halves that wait. It costs bitrate (an IDR is expensive and there
 * are now twice as many), which is why it is not lower: below a second the
 * bitrate paid buys a wait nobody can feel.
 */
const GOP_SECONDS = 1

/**
 * `-analyzeduration` / `-probesize`, as small as ffmpeg allows.
 *
 * ## The probes are SEQUENTIAL, and this is what the tile skew was
 *
 * The sentence that used to be here said the probes are "PARALLEL inputs of one
 * child". They are not. ffmpeg opens its inputs one after another and each open
 * BLOCKS in `avformat_find_stream_info` until its budget is spent — so input 0
 * is already connected and receiving while ffmpeg is still opening input 1, its
 * frames pile up, and `overlay` (which pairs inputs BY PTS) marries input 0's
 * oldest frame to input 1's newest. The lag is fixed for the life of the child:
 * both tiles then advance one frame per output frame, so nothing ever closes it.
 * The FIRST cell is the most behind; the last is live.
 *
 * Reproduced in one command on 2026-09-18 — two sources hstacked, one frame,
 * reading the cameras' own burnt-in clocks out of the composed picture:
 *
 * ```
 * 13:11:21 | 13:11:23      two seconds, and the earlier input is the late one
 * ```
 *
 * ## Why the old numbers cost seconds
 *
 * `-probesize` is a BYTE budget, and 1 MB of a 640x360 sub-stream is tens of
 * seconds of video — so `-analyzeduration 1s` never got the chance to stop it
 * and each open ran until the byte budget filled. Zero and 32 make the probe
 * return from the SDP, which already declares the codec, without reading media.
 *
 * Measured on this hub, the two sources of the live grid, three runs each,
 * production input args otherwise identical — time to the first composed frame,
 * and the skew read off the two burnt-in clocks in that frame:
 *
 * ```
 *   1 s / 1 MB     8986, 9728, 9712 ms      skew 5 s, 5 s, 4 s
 *   0   / 32       2281, 2270, 2304 ms      skew 1 s, 1 s, 0 s
 * ```
 *
 * The same numbers are the ~9 s cold start the operator had accepted: it was a
 * SUM of the opens, never the wait for the slowest source.
 *
 * Checked before shipping, because a probe that reads nothing has to survive
 * what it is not told: h264, h265 and a derived (`mid-to-low`) source all open
 * with `rc=0`, a 20 s run produces 200 frames of 200 either way (so the pacing
 * this file already lost once is untouched), and the skew is still 0 at 25 s
 * into a run — it is set at start-up and does not drift.
 *
 * What remains is the spread in when each source's first key frame arrives, and
 * a `/muted` dial waits for the next IDR. That spread is small here; if it ever
 * is not, the answer is to start the inputs from a join point we hold, NOT to
 * re-time the inputs (see `useWallclockTimestamps` below).
 */
const ANALYZE_DURATION_US = 0
const PROBE_SIZE_BYTES = 32

function inputPlanFor(source: GridStreamSource): FfmpegInputPlan {
  return {
    url: source.url,
    rtspTransport: 'tcp',
    // A consumer joins the restream mid-GOP, so the first decoded frames
    // reference pictures this child never saw. Drop them rather than compose a
    // corrupt tile into an otherwise good picture.
    // `+discardcorrupt` — see above, and NOTHING ELSE.
    //
    // `+nobuffer` was added here on 2026-09-18 by reasoning ("it stops the
    // demuxer smoothing jitter the composition re-times anyway") and MEASURED
    // on the same day to be the single worst thing in the input args: median
    // first frame per source, four runs each, on this hub —
    //
    //   probe + discardcorrupt                 4050 ms
    //   probe + discardcorrupt + low_delay     1796 ms
    //   probe + discardcorrupt + low_delay
    //                          + nobuffer      6292 ms
    //
    // It costs about 4.5 seconds of COLD start per source and buys nothing the
    // composition needs; `low_delay` alone is where the win is.
    fflags: ['+discardcorrupt'],
    lowDelay: true,
    // NO `-use_wallclock_as_timestamps`. It was added on 2026-09-18 to make the
    // tiles agree about WHEN, and measured the same day to wreck the PACING —
    // 18-second runs of this exact composition, arrival gaps between output
    // frames:
    //
    //   without:  median 84 ms, max 196 ms, zero gaps over a second
    //   with:     median  0 ms, max 1644 ms, TEN gaps over a second
    //
    // Stamping by arrival makes the output follow the inputs' arrival jitter
    // instead of their own clocks, and `overlay` + `-r 10` turn that into
    // bursts: forty frames at once, then a stall. The operator saw it as a grid
    // that "works quite badly", which is exactly what those numbers are.
    //
    // The skew it was meant to fix is real, WAS then observed on screen, and
    // was not what this flag assumed. It was not the spread in join times: it
    // was the probe budget above, paid one input at a time while the inputs
    // already open kept receiving. Fixing the budget fixed the skew at no cost
    // to the pacing, which is the bar anything here has to clear.
    analyzeDurationUs: ANALYZE_DURATION_US,
    probeSizeBytes: PROBE_SIZE_BYTES,
  }
}

/**
 * @throws when the layout addresses an input the sources do not contain, or
 * when there is nothing to compose. Both are plan errors: ffmpeg would refuse
 * them at start-up with a message about a filter pad, which names the graph
 * rather than the configuration that produced it.
 */
export function gridStreamInvocation(input: GridStreamInvocationInput): FfmpegInvocation {
  if (input.sources.length === 0 || input.layout.cells.length === 0) {
    throw new Error(
      'camera-grid: a composite needs at least one cell with a source before it can emit anything',
    )
  }
  for (const cell of input.layout.cells) {
    if (cell.inputIndex < 0 || cell.inputIndex >= input.sources.length) {
      throw new Error(
        `camera-grid: cell addresses input ordinal ${cell.inputIndex}, but only ` +
          `${input.sources.length} input(s) were acquired`,
      )
    }
  }

  const graph = buildGridFilterGraph(input.layout)
  const [first, ...rest] = input.sources
  if (first === undefined) {
    throw new Error('camera-grid: a composite needs at least one cell with a source')
  }

  const video: FfmpegVideoEncodePlan = {
    kind: 'encode',
    encoder: input.encoder,
    preset: PRESET,
    tune: TUNE,
    pixelFormat: PIXEL_FORMAT,
    fps: input.fps,
    gopFrames: input.fps * GOP_SECONDS,
    bitrateKbps: input.bitrateKbps,
    // The composition already decided the picture's size; a `-vf` scale on an
    // output a complex graph feeds is refused by ffmpeg, and the builder throws
    // rather than dropping it silently.
    scale: null,
  }

  return {
    logLevel: 'error',
    decodeHwAccel: input.decodeHwAccel,
    input: inputPlanFor(first),
    extraInputs: rest.map(inputPlanFor),
    filterGraph: graph,
    video,
    // No audio at all. A composite has no microphone: the sources each have
    // their own, and mixing four of them into one track is a recording nobody
    // can attribute. Mapping ONE of them would be worse — it would attribute a
    // sound to a camera that is not the one that heard it.
    audio: { kind: 'none' },
    threadCount: 0,
    outputArgs: [],
    // FLV, not MPEG-TS, and not a taste: the consumer is the broker's ffmpeg
    // source reader, which re-muxes with `-c copy -f mpegts`, and the bundled
    // ffmpeg 7.0.2 static SEGFAULTS reading MPEG-TS on that path. Measured on
    // the hub 2026-09-17 — a synthetic 3-second TS crashes it as readily as a
    // real composition, while FLV→TS and RTSP→TS copy both exit 0. A grid that
    // emitted TS was handing every consumer a crash, and the stream never
    // loaded once.
    sink: { kind: 'stdout', container: GRID_WIRE_CONTAINER },
  }
}
