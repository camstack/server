/**
 * The two argv the compositor spawns: a tile DECODER, and the canvas ENCODER.
 *
 * Both go through the shared builder in `@camstack/types`. This addon builds no
 * argv of its own — the repo has already shipped two builders that disagreed
 * about hardware, and `scripts/check-ffmpeg-primitive.ts` refuses a third.
 *
 * ## The decoder pays no codec on the way out
 *
 * A tile is copied into a canvas this process owns, so encoding it and decoding
 * it again would be two codecs paid to deliver frames that were already there.
 * It emits raw yuv420p — the format the canvas is in, so the composition is a
 * strided memcpy rather than a convert.
 *
 * The input flags are the ones D527 measured: the probe returns from the SDP
 * (`0` / `32`) instead of reading media, which is what took the old single
 * child's start from ~9 s to 2.3 s. They matter less here — a compositor does
 * not pair inputs, so a slow open costs that tile's first frame and nothing
 * else — but a tile that appears in 300 ms instead of 4 s is still the
 * difference the operator sees.
 *
 * ## The encoder never decodes
 *
 * It reads the canvas as raw frames on stdin and encodes once. `zerolatency`
 * and a one-second GOP are carried over from the single-child invocation, where
 * they were measured: without `zerolatency` about four seconds of picture sat
 * inside the encoder, which the operator reported as "ritardi di secondi".
 */
import type { FfmpegInvocation, FfmpegVideoEncodePlan, FfmpegVideoEncoderId } from '@camstack/types'
import { GRID_WIRE_CONTAINER } from './grid-wire-format.js'
import { TILE_PIXEL_FORMAT, type GridTile } from './grid-tile-plan.js'
import type { PixelSize } from './grid-canvas.js'

/** See D527: the probe returns from the SDP instead of reading media. */
const ANALYZE_DURATION_US = 0
const PROBE_SIZE_BYTES = 32

/**
 * Threads per child, and why they are BOUNDED rather than automatic.
 *
 * ffmpeg's default is one thread per core, applied to decode, the filter graph
 * and the output — and it applies it per CHILD. A compositor has N+1 of them,
 * so on the hub's 20-core CPU two tiles reading 640x360 sub-streams were
 * measured holding 71 and 56 threads (2026-09-18). That is not a CPU problem:
 * the container's pid cgroup counts THREADS, its ceiling is 2048, and it was
 * sitting at 1858. Every new `pthread_create` then fails with EAGAIN, which
 * ffmpeg reports as `ff_frame_thread_encoder_init failed` — the grid stopped
 * working, and nothing about the message says "out of pids".
 *
 * A tile decodes one small stream and scales it once; one thread does that at a
 * few percent of a core (measured: 2.2-2.4%). The encoder gets a few more
 * because it is the only piece whose work scales with the canvas.
 *
 * The DECODER needs its own number. `threadCount` lands after the video args,
 * so it bounds the encoder only — a tile set to `threadCount: 1` still carried
 * `min(cores, 16)` decoder frame threads plus a filter pool, and measured 72.
 * With all three set it measures 26.
 */
const TILE_THREADS = 1
/** libavfilter's own slice pool, which neither of the other two touches. */
const FILTER_THREADS = 1
const ENCODER_THREADS = 4

const PRESET = 'veryfast'
const TUNE = 'zerolatency'
const GOP_SECONDS = 1

export interface GridTileDecoderInput {
  readonly tile: GridTile
  /** A broker restream URL, acquired through `streamBroker.getStreamWithCodec`. */
  readonly url: string
  readonly fps: number
}

/** One tile's decoder: dial in, raw yuv420p frames out. */
export function gridTileDecoderInvocation(input: GridTileDecoderInput): FfmpegInvocation {
  return {
    logLevel: 'error',
    // Software decode. Resolving a hardware backend is the DECODER ADDON's
    // answer, per node, and asking for one here would be the kernel resolver's
    // qsv-first order — the known-bad one.
    decodeHwAccel: null,
    input: {
      url: input.url,
      rtspTransport: 'tcp',
      // A consumer joins mid-GOP, so the first decoded frames reference
      // pictures this child never saw. Drop them rather than compose a corrupt
      // tile into an otherwise good picture.
      fflags: ['+discardcorrupt'],
      // The h264 decoder reorders output it has nothing to reorder on a stream
      // encoded without B-frames; measured at 4050 → 1796 ms to first frame.
      lowDelay: true,
      analyzeDurationUs: ANALYZE_DURATION_US,
      probeSizeBytes: PROBE_SIZE_BYTES,
      decodeThreadCount: TILE_THREADS,
    },
    video: {
      kind: 'raw',
      pixelFormat: TILE_PIXEL_FORMAT,
      filter: input.tile.filter,
      // Pace the tile at the canvas rate. A source running faster would spend
      // decode on frames the next tick throws away; one running slower simply
      // repeats, which is what a still tile already looks like.
      fps: input.fps,
    },
    audio: { kind: 'none' },
    threadCount: TILE_THREADS,
    filterThreadCount: FILTER_THREADS,
    outputArgs: [],
    sink: { kind: 'stdout', container: 'rawvideo' },
  }
}

export interface GridCanvasEncoderInput {
  readonly canvas: PixelSize
  readonly fps: number
  readonly encoder: FfmpegVideoEncoderId
  readonly bitrateKbps: number
}

/** The canvas encoder: raw frames on stdin, one compressed stream out. */
export function gridCanvasEncoderInvocation(input: GridCanvasEncoderInput): FfmpegInvocation {
  const video: FfmpegVideoEncodePlan = {
    kind: 'encode',
    encoder: input.encoder,
    preset: PRESET,
    tune: TUNE,
    pixelFormat: TILE_PIXEL_FORMAT,
    fps: input.fps,
    gopFrames: input.fps * GOP_SECONDS,
    bitrateKbps: input.bitrateKbps,
    // The canvas already IS the picture's size.
    scale: null,
  }
  return {
    logLevel: 'error',
    decodeHwAccel: null,
    input: {
      url: 'pipe:0',
      rawVideo: {
        pixelFormat: TILE_PIXEL_FORMAT,
        width: input.canvas.width,
        height: input.canvas.height,
        framerate: input.fps,
      },
    },
    video,
    // No audio at all. A composite has no microphone: mixing four sources into
    // one track is a recording nobody can attribute, and mapping ONE of them
    // would attribute a sound to a camera that did not hear it.
    audio: { kind: 'none' },
    threadCount: ENCODER_THREADS,
    filterThreadCount: FILTER_THREADS,
    outputArgs: [],
    // FLV, not MPEG-TS: the consumer is the broker's ffmpeg source reader,
    // which re-muxes with `-c copy -f mpegts`, and the bundled ffmpeg 7.0.2
    // static SEGFAULTS reading MPEG-TS on that path (measured 2026-09-17).
    sink: { kind: 'stdout', container: GRID_WIRE_CONTAINER },
  }
}
