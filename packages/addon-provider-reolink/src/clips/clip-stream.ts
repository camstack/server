/**
 * A clip's bytes reach the peer as they arrive from the camera.
 *
 * This is the STREAMING producer, beside `produceTwin` in `clip-service.ts`
 * and not in its place. `produceTwin` makes a file and is the one authority
 * for the rules that make a file honest (D567, D568, D576). A stream cannot
 * be a file, so each of those rules is either reused here or named as not
 * applying, with the reason — never dropped:
 *
 * | rule | file (`produceTwin`) | stream (here) |
 * | --- | --- | --- |
 * | the gates (device, sleeping, uid, row) | `gateClipDevice` | the SAME function, in the service |
 * | cmd 5 on `CLIP_IDLE_WINDOW_MS` (D568) | ends the fetch | ends the STREAM — nothing on the wire ends a transfer, so the 300 ms silence is the end-of-stream signal too |
 * | decoded duration proved against the row (D568) | a short pass is retried | a short pass is JUDGED and LOGGED after the last byte — `stream-short` — and never retried, because the bytes are already at the peer and a second pass would restart the file inside a response the peer has half consumed |
 * | one retry on `CLIP_IDLE_WINDOW_RETRY_MS` (D568) | yes | inapplicable — same reason: there is no buffer to replace |
 * | `fetchClipBytes` retries under a bound (D58) | yes | ONLY while no access unit has been decoded (the camera answered nothing); once media flowed a failure is a CUT — or, before the status line, a named refusal — never a second pass |
 * | the MEASURED rate (D567) | over the whole file | over a probe of the first access units (`clip-stream-mux.ts`), widened while it cannot measure and then REFUSED — a stream muxed without `-r` is muxed at the nominal rate D567 refuses (D604) |
 * | one transfer's frames | a whole buffer, judged once | the camera is never told to stop, so a CUT transfer's frames arrive inside the NEXT one: a backwards timestamp before the mux DROPS what was held and probes again, and after it is named and makes the duration unknown (D604) |
 * | the codec DETECTED from the NALs (D567) | yes | yes — the first access unit names the demuxer |
 * | the AAC (D567) | COPIED into the file | TRANSCODED (D600) to the codec the dial asked for — the consumer is a WebRTC sender, which never speaks AAC — or served silent WITH A NAMED REASON |
 * | `+faststart` (D549 22) | yes | cannot exist for a stream: fragmented MP4 |
 * | the scratch (D549 22, D576) | written | NOTHING is written — no scratch, no cache, no prefetch |
 * | the 50 MiB unary bound (D9/D18) | `readClipBytes` | untouched; a stream is not a unary answer |
 *
 * ## The one session, and why streams queue per host
 *
 * The library serialises `downloadRecording` on a replay queue because two
 * binary transfers on one socket interleave. `fileInfoListReplayBinaryDownload`
 * — the only entry that exposes `onChunk` — sits UNDER that queue, so this
 * producer keeps its own lane per host: a second stream on the same host waits
 * for the first, and says so. A buffered fetch on the same host is still
 * serialised only by the library's queue; the overlap is stage 2's to close
 * (or the library's, by taking `onChunk` on `downloadRecording`).
 *
 * ## Stopping
 *
 * The library offers no abort. The one lever is the one it documents: a
 * consumer that THROWS from `onChunk` fails the transfer loudly. So a cut
 * stream throws from its next chunk, and the camera's own end (the idle
 * window) closes what the throw could not.
 */
import type { Readable, Writable } from 'node:stream'

import { BcMediaAnnexBDecoder, estimateVideoTiming } from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'

import type { ReolinkClipRow } from './clip-catalog.js'
import { CLIP_FETCH_BACKOFF_MS, CLIP_FETCH_MAX_ATTEMPTS } from './clip-mux.js'
import {
  buildClipStreamMuxArgs,
  CLIP_STREAM_AUDIO_FD,
  CLIP_STREAM_DRAIN_TIMEOUT_MS,
  CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS,
  CLIP_STREAM_RATE_PROBE_ACCESS_UNITS,
  CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS,
  clipStreamContentTypeFor,
  createDrainGate,
  probeClipStreamRate,
  type ClipStreamAudioCodec,
  type ClipStreamRate,
} from './clip-stream-mux.js'
import {
  CLIP_IDLE_WINDOW_MS,
  judgeClipDuration,
  type ClipDurationVerdict,
} from './clip-truncation.js'
import type {
  ClipBytesRefusalCode,
  ClipDeviceRef,
  ClipTwin,
} from './reolink-videoclips-provider.js'

/** One decoded access unit — the library's `BcMediaVideoFrame`, narrowed. */
export interface ClipStreamAccessUnit {
  readonly videoType: 'H264' | 'H265'
  readonly annexB: Buffer
  readonly microseconds: number
  readonly isKeyframe: boolean
}

/** One decoded audio frame — the library's `BcMediaAudioFrame`, narrowed. */
export interface ClipStreamAudioFrame {
  /** `Aac` frames are self-delimiting ADTS; `Adpcm` carries no header at all. */
  readonly audioType: 'Aac' | 'Adpcm'
  readonly data: Buffer
}

export interface ClipStreamDecoderHandlers {
  onVideoAccessUnit(unit: ClipStreamAccessUnit): void
  onAudioFrame(frame: ClipStreamAudioFrame): void
}

/** What a caller asks this stream to carry as sound. `none` is silence asked for. */
export type ClipStreamAudioAsk = ClipStreamAudioCodec | 'none'

/**
 * Why a stream is silent. Never a bare "no audio" — a stream nobody asked
 * sound of, a recording with no microphone, a codec we will not carry and a
 * transcode that was decided too late are four different answers, and only
 * one of them is anybody's fault.
 */
export type ClipStreamSilentReason =
  /** The dial asked for `none`; the consumer wanted video. */
  | 'not-requested'
  /** Asked, and no audio frame had reached the decoder when the mux was spawned. */
  | 'no-audio-track'
  /** Asked, and what arrived was ADPCM — no ADTS header, nothing to declare. */
  | 'audio-not-copyable'

/** What the stream did with the sound it was handed. On every outcome. */
export interface ClipStreamAudioReport {
  readonly asked: ClipStreamAudioAsk
  /** The codec actually muxed, or `null` for a silent stream. */
  readonly muxed: ClipStreamAudioCodec | null
  /** Present iff {@link muxed} is `null` — never absent, never a bare boolean. */
  readonly reason: ClipStreamSilentReason | null
  /** Every audio frame the decoder handed over, of any codec. */
  readonly framesIn: number
  /**
   * Frames the decoder handed over and this stream did NOT carry: everything
   * on a silent stream, the ADPCM on a muxed one, and anything past the probe
   * bound while the mux had not been spawned. Accepted work that produced
   * nothing, counted (D391).
   */
  readonly framesDropped: number
  /**
   * Frames that arrived AFTER the mux was spawned silent — the loudest case,
   * because the recording did have sound and the decision had already been
   * taken. Zero on every other branch.
   */
  readonly framesAfterMux: number
}

/** The BcMedia demuxer, push-fed. Injected so the producer is provable
 *  without a camera; the default is the library's own. */
export interface ClipStreamDecoder {
  push(chunk: Buffer): void
}

export type ClipStreamDecoderFactory = (handlers: ClipStreamDecoderHandlers) => ClipStreamDecoder

/** The ffmpeg child, narrowed to what a stream drives. `ChildProcess` fits. */
export interface ClipStreamMuxProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /**
   * The extra pipes, so the audio input can be reached by fd. Declared as the
   * union `ChildProcess.stdio` really carries — a spawn's fd 3 is a `Readable`
   * or a `Writable` depending on how it was configured, and which one it is
   * is a runtime question ({@link writableAt}), never a cast.
   */
  readonly stdio: ReadonlyArray<Writable | Readable | null | undefined>
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

function isWritable(stream: Writable | Readable): stream is Writable {
  return 'write' in stream && typeof stream.write === 'function'
}

/** The stream at `index`, if it is one this process can be WRITTEN to. */
function writableAt(
  stdio: ReadonlyArray<Writable | Readable | null | undefined>,
  index: number,
): Writable | null {
  const candidate = stdio[index]
  if (candidate === null || candidate === undefined) return null
  return isWritable(candidate) ? candidate : null
}

export type ClipStreamMuxSpawner = (args: readonly string[]) => ClipStreamMuxProcess

/** The spawner a stream may use, or why there is none. */
export type ClipStreamMuxAnswer =
  | { readonly kind: 'ready'; readonly spawn: ClipStreamMuxSpawner }
  | { readonly kind: 'refused'; readonly detail: string }

/**
 * The peer, as the producer sees it. The data-plane route wraps the real
 * `res` in this; a spec wraps a `PassThrough`.
 */
export interface ClipStreamSink {
  /**
   * Exactly once, before the first byte — the route writes its status line
   * here, with the content type the mux really produced. A `pcmu` stream is
   * `video/quicktime` and everything else is `video/mp4`; the boxes are the
   * same and the header is not guessed.
   */
  begin(contentType: string): void
  /** The socket's own word on whether it took the chunk (D447). */
  write(chunk: Buffer): boolean
  onceDrain(listener: () => void): void
  /** The peer went away before the stream ended. */
  onceClose(listener: () => void): void
  end(): void
  /** Sever a stream that cannot be completed — never `end()`, which would
   *  hand the peer a truncated file that looks whole. */
  destroy(): void
}

export interface ClipStreamInput {
  /** Already through the gates — the service ran `gateClipDevice` first. */
  readonly device: ClipDeviceRef
  readonly row: ReolinkClipRow
  /** The byte handle for {@link twin} — a PATH on the camera. */
  readonly fileName: string
  readonly twin: ClipTwin
  /**
   * Which audio the consumer negotiated, from the dial (D600). Required, and
   * `'none'` is a real answer — the data-plane route, which nobody negotiates
   * with, states it rather than leaving the producer to guess.
   */
  readonly audio: ClipStreamAudioAsk
  readonly sink: ClipStreamSink
}

/** Why a stream that had started was severed. Every one is logged. */
export type ClipStreamCutReason =
  /** The peer sat on a refused write past the drain window. */
  | 'peer-stalled'
  /** The peer closed the connection. */
  | 'peer-closed'
  /** ffmpeg stopped taking access units past the drain window. */
  | 'mux-stalled'
  /** ffmpeg stopped taking AUDIO frames past the drain window. */
  | 'mux-audio-stalled'
  /** ffmpeg failed, or could not be spawned. */
  | 'mux-failed'
  /**
   * No frame rate could be measured over the probe, extended to its bound.
   *
   * Refused rather than muxed: `-r` omitted does not mean "no rate", it means
   * ffmpeg's own default — the stream's nominal header number, which is the
   * one D567 exists to refuse. Measured on this fleet's own bytes: a real
   * camera elementary stream muxed without `-r` came out 63.0 s long against
   * 42.1 s of its own audio. (D604)
   */
  | 'rate-unmeasured'
  /** ffmpeg did not exit after its input ended. */
  | 'mux-hung'
  /** The camera failed the transfer after media had already been served. */
  | 'camera-failed'
  /** The BcMedia demuxer threw on the camera's bytes. */
  | 'decode-failed'

export type ClipStreamOutcome =
  | {
      readonly kind: 'served'
      readonly accessUnits: number
      /** What became of the sound — asked, muxed, dropped (D600). */
      readonly audio: ClipStreamAudioReport
      readonly bytesOut: number
      /** MEASURED from the access units' timestamps, or `null` (D393). */
      readonly durationSeconds: number | null
      readonly verdict: ClipDurationVerdict
      readonly rate: ClipStreamRate
      readonly attempts: number
    }
  /** Nothing reached the peer: the route still owns the status line. */
  | {
      readonly kind: 'refused'
      readonly code: Extract<ClipBytesRefusalCode, 'camera-refused' | 'fetch-failed'>
      readonly detail: string
      readonly attempts: number
    }
  /** Bytes had reached the peer; the sink is destroyed. */
  | {
      readonly kind: 'cut'
      readonly reason: ClipStreamCutReason
      readonly detail: string
      readonly bytesOut: number
    }

export interface ClipStreamProducerDeps {
  readonly logger: IScopedLogger
  /** Seam for the spec: used as-is, synchronously. */
  readonly spawnMux?: ClipStreamMuxSpawner
  /**
   * Production: the node's PINNED ffmpeg as a spawner, asked once per stream
   * BEFORE the camera is dialled (D540). A refusal is named per camera and
   * nothing is dialled; the next stream asks again, so a later successful
   * resolution is picked up.
   */
  readonly resolveMuxSpawner?: () => Promise<ClipStreamMuxAnswer>
  readonly createDecoder?: ClipStreamDecoderFactory
  readonly sleep?: (ms: number) => Promise<void>
  readonly drainTimeoutMs?: number
  readonly flushTimeoutMs?: number
  /** Silence after a cut before the lane it still holds is named. */
  readonly cutGraceMs?: number
}

export interface ClipStreamProducer {
  stream(input: ClipStreamInput): Promise<ClipStreamOutcome>
  /** Streams running or queued on this host right now. */
  active(hostKey: string): number
}

/**
 * Audio frames held while the rate probe runs, before the mux exists.
 *
 * The video probe is 16 access units ≈ one second, which is ≈ 45 AAC frames
 * at 1024 samples and 16 kHz — a few tens of kilobytes. The bound is two
 * orders above that so an ordinary stream never touches it, and it exists so
 * a camera that delivers audio without video cannot grow this buffer without
 * end. Held in memory, like the video probe: nothing is written.
 */
export const CLIP_STREAM_AUDIO_PROBE_MAX_FRAMES = 4_096
export const CLIP_STREAM_AUDIO_PROBE_MAX_BYTES = 4 * 1024 * 1024

/**
 * How long a CUT run may go on holding its host's lane before it is named.
 *
 * `sever()` is not a stop. The only lever a consumer has over a cmd 5 replay
 * is to throw from `onChunk`, so a run whose camera has gone quiet stays
 * inside `fileInfoListReplayBinaryDownload` until the library's own 120 s
 * deadline — and the lane, which is strictly serial per host, is unusable for
 * all of it. Measured on 592, 2026-09-23: severed `peer-closed` at 18:18:10.444,
 * lane released at 18:19:40.753.
 *
 * Five seconds is well past any legitimate post-cut settle (a cut caused BY a
 * chunk throws on that same chunk, synchronously) and well short of the
 * deadline, so a line here always means the hold is real.
 */
export const CLIP_STREAM_CUT_GRACE_MS = 5_000

const defaultDecoder: ClipStreamDecoderFactory = (handlers) =>
  new BcMediaAnnexBDecoder({
    strict: false,
    onVideoAccessUnit: handlers.onVideoAccessUnit,
    onAudioFrame: (frame) =>
      handlers.onAudioFrame({ audioType: frame.audioType, data: frame.data }),
  })

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** One attempt's verdict, before the retry rule is applied. */
type AttemptResult =
  | ClipStreamOutcome
  /** The camera failed before any media was decoded — the only retryable shape. */
  | { readonly kind: 'no-media'; readonly detail: string }

export function createClipStreamProducer(deps: ClipStreamProducerDeps): ClipStreamProducer {
  const sleep = deps.sleep ?? defaultSleep
  const createDecoder = deps.createDecoder ?? defaultDecoder
  const drainTimeoutMs = deps.drainTimeoutMs ?? CLIP_STREAM_DRAIN_TIMEOUT_MS
  const flushTimeoutMs = deps.flushTimeoutMs ?? CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS
  const cutGraceMs = deps.cutGraceMs ?? CLIP_STREAM_CUT_GRACE_MS
  const lanes = new Map<string, Promise<void>>()
  const activeByHost = new Map<string, number>()

  const muxSpawner = async (): Promise<ClipStreamMuxAnswer> => {
    if (deps.spawnMux !== undefined) return { kind: 'ready', spawn: deps.spawnMux }
    if (deps.resolveMuxSpawner !== undefined) return await deps.resolveMuxSpawner()
    return { kind: 'refused', detail: 'no ffmpeg spawner is wired into the clip stream producer' }
  }

  const runAttempt = (
    input: ClipStreamInput,
    attempt: number,
    spawnMux: ClipStreamMuxSpawner,
  ): Promise<AttemptResult> =>
    new ClipStreamRun(
      {
        logger: deps.logger,
        spawnMux,
        createDecoder,
        drainTimeoutMs,
        flushTimeoutMs,
        cutGraceMs,
      },
      input,
      attempt,
    ).run()

  const runAttempts = async (input: ClipStreamInput): Promise<ClipStreamOutcome> => {
    const { deviceId } = input.device
    // The cheap question first: no pinned binary, no dial (D540).
    const mux = await muxSpawner()
    if (mux.kind === 'refused') {
      deps.logger.error('videoclips: clip stream refused — no pinned ffmpeg on this node (D540)', {
        tags: { deviceId },
        meta: { clipKey: input.row.clipKey, twin: input.twin, detail: mux.detail },
      })
      return { kind: 'refused', code: 'fetch-failed', detail: mux.detail, attempts: 0 }
    }
    let lastDetail = 'no reason given'
    for (let attempt = 1; attempt <= CLIP_FETCH_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(CLIP_FETCH_BACKOFF_MS * 2 ** (attempt - 2))
      const result = await runAttempt(input, attempt, mux.spawn)
      if (result.kind !== 'no-media') return result
      lastDetail = result.detail
      deps.logger.warn('videoclips: a clip stream produced no media — retrying', {
        tags: { deviceId },
        meta: {
          clipKey: input.row.clipKey,
          twin: input.twin,
          branch: 'stream-no-media',
          attempt,
          error: lastDetail,
        },
      })
    }
    deps.logger.warn('videoclips: the camera never delivered this clip stream', {
      tags: { deviceId },
      meta: {
        clipKey: input.row.clipKey,
        twin: input.twin,
        branch: 'camera-refused',
        attempts: CLIP_FETCH_MAX_ATTEMPTS,
        error: lastDetail,
      },
    })
    return {
      kind: 'refused',
      code: 'camera-refused',
      detail: `clip stream never landed after ${CLIP_FETCH_MAX_ATTEMPTS} attempts — ${lastDetail}`,
      attempts: CLIP_FETCH_MAX_ATTEMPTS,
    }
  }

  return {
    active: (hostKey) => activeByHost.get(hostKey) ?? 0,
    stream: (input) => {
      const { hostKey, deviceId } = input.device
      const ahead = activeByHost.get(hostKey) ?? 0
      if (ahead > 0) {
        deps.logger.info('videoclips: a clip stream is queued behind another on this host', {
          tags: { deviceId },
          meta: { clipKey: input.row.clipKey, twin: input.twin, branch: 'stream-queued', ahead },
        })
      }
      activeByHost.set(hostKey, ahead + 1)

      // A consumer that leaves WHILE IT WAITS must not be served, and must
      // not hold the lane behind it.
      //
      // The lane is strictly serial per host and had no cancellation: once
      // an entry was enqueued, `runAttempts` ran for it no matter how long
      // ago the peer went away — with its full retry budget, against a
      // camera that may be asleep. Measured 2026-09-23 on 3628 (a battery
      // Reolink): the operator moved along a list and the depth climbed
      // 5, 6, 7, 8 and never came back down. Nothing played, because every
      // tap waited behind every abandoned tap before it.
      //
      // Registered at ENQUEUE, not at run: the close is what we are trying
      // to catch and it arrives during the wait. `onceClose` is a real
      // emitter (`res.once('close')`), so this does not displace the
      // listener the run installs for itself.
      let abandonedAt: number | null = null
      input.sink.onceClose(() => {
        abandonedAt ??= Date.now()
      })
      const queuedAt = Date.now()

      const tail = lanes.get(hostKey) ?? Promise.resolve()
      const run = tail
        .then(async (): Promise<ClipStreamOutcome> => {
          if (abandonedAt !== null) {
            const waitedMs = abandonedAt - queuedAt
            deps.logger.info('videoclips: a queued clip stream was dropped, its peer had gone', {
              tags: { deviceId },
              meta: {
                clipKey: input.row.clipKey,
                twin: input.twin,
                branch: 'queued-peer-gone',
                waitedMs,
                aheadWhenQueued: ahead,
              },
            })
            return {
              kind: 'refused',
              code: 'fetch-failed',
              detail: `the peer left after ${String(waitedMs)} ms in the queue, so this clip was never fetched`,
              attempts: 0,
            }
          }
          return await runAttempts(input)
        })
        .finally(() => {
          const left = (activeByHost.get(hostKey) ?? 1) - 1
          if (left <= 0) activeByHost.delete(hostKey)
          else activeByHost.set(hostKey, left)
        })
      lanes.set(
        hostKey,
        run.then(
          () => undefined,
          () => undefined,
        ),
      )
      return run
    },
  }
}

interface ClipStreamRunDeps {
  readonly logger: IScopedLogger
  readonly spawnMux: ClipStreamMuxSpawner
  readonly createDecoder: ClipStreamDecoderFactory
  readonly drainTimeoutMs: number
  readonly flushTimeoutMs: number
  readonly cutGraceMs: number
}

interface CutState {
  readonly reason: ClipStreamCutReason
  readonly detail: string
}

/**
 * One transfer: camera → decoder → ffmpeg → peer, with a cut on every hop.
 *
 * A class because the run is a state machine with a dozen fields the chunk
 * callback and the download promise both touch; passing them around as
 * closures over `let`s was less readable, not more immutable.
 */
class ClipStreamRun {
  private accessUnits = 0
  /** Armed by {@link sever}; cleared when the run finally returns. */
  private cutWatch: ReturnType<typeof setTimeout> | null = null
  /** Every audio frame the decoder handed over, of any codec. */
  private audioFrames = 0
  private audioFramesDropped = 0
  private audioFramesAfterMux = 0
  /** ADTS frames held until the mux exists — the audio half of the probe. */
  private audioProbe: Buffer[] = []
  private audioProbeBytes = 0
  private audioMuxed: ClipStreamAudioCodec | null = null
  private audioSilentReason: ClipStreamSilentReason | null = null
  private audioIn: Writable | null = null
  private readonly timestampsUs: number[] = []
  /** Access units held until the rate is probed — the frames in flight. */
  private probe: ClipStreamAccessUnit[] = []
  private mux: ClipStreamMuxProcess | null = null
  private muxStderr = ''
  private muxClosed: Promise<number | null> | null = null
  private rate: ClipStreamRate = { fps: null, fpsSource: 'unmeasured', accessUnits: 0 }
  private videoType: 'H264' | 'H265' | null = null
  /** The last access unit's timestamp, to catch a transfer that went BACK. */
  private lastUs: number | null = null
  /** Units of a PREVIOUS transfer, dropped before the mux existed (D604). */
  private residueUnits = 0
  private residueAudioFrames = 0
  /** A backwards timestamp that arrived too late to drop: the duration of
   *  this pass cannot be measured, and is never guessed (D393). */
  private timestampsBroken = false
  private begun = false
  private ended = false
  /** The run is over. Every late callback is silent from here (D604). */
  private done = false
  private bytesOut = 0
  private cut: CutState | null = null
  private readonly stdinGate
  private readonly audioStdinGate
  private readonly peerGate
  private readonly tags: { readonly deviceId: number }

  constructor(
    private readonly deps: ClipStreamRunDeps,
    private readonly input: ClipStreamInput,
    private readonly attempt: number,
  ) {
    this.tags = { deviceId: input.device.deviceId }
    this.stdinGate = createDrainGate({
      timeoutMs: deps.drainTimeoutMs,
      onStall: () => this.sever('mux-stalled', 'ffmpeg stopped taking access units'),
    })
    // The audio hop has the SAME rule as the video hop and its OWN gate: two
    // pipes into one process can deadlock separately, and a line that named
    // only "mux-stalled" could not say which one stopped.
    this.audioStdinGate = createDrainGate({
      timeoutMs: deps.drainTimeoutMs,
      onStall: () => this.sever('mux-audio-stalled', 'ffmpeg stopped taking audio frames'),
    })
    this.peerGate = createDrainGate({
      timeoutMs: deps.drainTimeoutMs,
      onStall: () => this.sever('peer-stalled', 'the peer stopped taking bytes'),
    })
  }

  async run(): Promise<AttemptResult> {
    const { device, row, fileName, twin, sink } = this.input
    sink.onceClose(() => {
      if (!this.ended) this.sever('peer-closed', 'the peer closed the connection')
    })
    const decoder = this.deps.createDecoder({
      onVideoAccessUnit: (unit) => this.onAccessUnit(unit),
      onAudioFrame: (frame) => this.onAudioFrame(frame),
    })
    this.deps.logger.info('videoclips: streaming a clip file from the camera', {
      tags: this.tags,
      meta: {
        clipKey: row.clipKey,
        twin,
        fileName,
        startMs: row.startMs,
        endMs: row.endMs,
        attempt: this.attempt,
        audioAsked: this.input.audio,
        idleTimeoutMs: CLIP_IDLE_WINDOW_MS,
      },
    })
    let api
    try {
      api = await device.getApi()
    } catch (err: unknown) {
      return { kind: 'no-media', detail: describe(err) }
    }
    try {
      try {
        await api.fileInfoListReplayBinaryDownload({
          channel: device.channel,
          ...(device.uid !== undefined ? { uid: device.uid } : {}),
          fileName,
          idleTimeoutMs: CLIP_IDLE_WINDOW_MS,
          onChunk: (chunk) => this.onChunk(decoder, chunk),
        })
      } catch (err: unknown) {
        return this.onTransferFailed(err)
      }
      return await this.onTransferEnded()
    } finally {
      // Nothing this run armed may outlive it: a gate that fires after the
      // answer has been given would sever a stream that was already served,
      // and a peer closing its own finished response would be logged as a
      // cut. Both were live (D604).
      this.done = true
      if (this.cutWatch !== null) clearTimeout(this.cutWatch)
      this.cutWatch = null
      this.disposeGates()
    }
  }

  /** Every hop's drain gate, silenced. Idempotent. */
  private disposeGates(): void {
    this.stdinGate.dispose()
    this.audioStdinGate.dispose()
    this.peerGate.dispose()
  }

  /** The camera's bytes, as they arrive. A cut run THROWS here: the only stop. */
  private onChunk(decoder: ClipStreamDecoder, chunk: Buffer): void {
    if (this.cut !== null) throw new Error(`clip stream cut: ${this.cut.reason}`)
    try {
      decoder.push(chunk)
    } catch (err: unknown) {
      this.sever('decode-failed', describe(err))
      throw err
    }
  }

  private onAccessUnit(unit: ClipStreamAccessUnit): void {
    if (this.cut !== null) return
    const previousUs = this.lastUs
    this.lastUs = unit.microseconds
    if (previousUs !== null && unit.microseconds < previousUs) {
      this.onTimestampsWentBack(previousUs, unit.microseconds)
    }
    this.accessUnits += 1
    this.timestampsUs.push(unit.microseconds)
    if (this.mux !== null) {
      this.feed(unit.annexB)
      return
    }
    this.probe = [...this.probe, unit]
    if (this.probe.length < CLIP_STREAM_RATE_PROBE_ACCESS_UNITS) return
    // The probe is a WINDOW, not a deadline: a window that cannot measure is
    // widened, up to its bound, rather than muxed at a rate nobody measured.
    if (
      probeClipStreamRate(this.timestampsUs).fpsSource === 'timestamps' ||
      this.probe.length >= CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS
    ) {
      this.startMux()
    }
  }

  /**
   * A timestamp that went BACKWARD: this is a second transfer's first frame.
   *
   * The library's replay listener cannot tell one transfer from the next —
   * every cmd 5 replay carries `msgNum: 0` and, on a hub child, the same
   * header channel id — and a CUT transfer is never stopped at the camera
   * (nothing on the wire aborts one; the producer's only lever is to throw
   * from the next chunk). So the frames still in flight for the previous,
   * aborted stream are handed to THIS one, ahead of its own first frame.
   *
   * Measured on 3628, 2026-09-22 16:41: a stream cut at 55 access units was
   * followed 1 ms later by another, which decoded 640 units instead of 635
   * and 666 audio frames instead of 661 — the same five extra of each — and
   * spanned 38.52 s instead of 42.21 s, exactly the 3.69 s the cut stream had
   * already delivered. Its rate probe therefore measured a NEGATIVE span and
   * refused to name a rate, which is the only way `estimateVideoTiming` can
   * answer anything but `timestamps` here.
   *
   * Before the mux exists the answer is to DROP what was held and probe
   * again: nothing has reached the peer, so the residue can simply not be
   * part of this stream. After it exists there is nothing to drop — the bytes
   * are out — so it is named, counted, and this pass's duration becomes
   * unmeasurable rather than a number measured across two transfers.
   */
  private onTimestampsWentBack(previousUs: number, currentUs: number): void {
    const { row, twin } = this.input
    const meta = {
      clipKey: row.clipKey,
      twin,
      previousUs,
      currentUs,
    }
    if (this.mux !== null) {
      if (this.timestampsBroken) return
      this.timestampsBroken = true
      this.deps.logger.warn('videoclips: a clip stream’s timestamps went backwards mid-mux', {
        tags: this.tags,
        meta: { ...meta, branch: 'stream-timestamp-jump', accessUnits: this.accessUnits },
      })
      return
    }
    this.residueUnits += this.probe.length
    this.residueAudioFrames += this.audioProbe.length
    this.audioFramesDropped += this.audioProbe.length
    this.probe = []
    this.audioProbe = []
    this.audioProbeBytes = 0
    this.timestampsUs.length = 0
    this.accessUnits = 0
    this.deps.logger.warn('videoclips: a clip stream dropped the previous transfer’s frames', {
      tags: this.tags,
      meta: {
        ...meta,
        branch: 'stream-transfer-residue',
        residueAccessUnits: this.residueUnits,
        residueAudioFrames: this.residueAudioFrames,
      },
    })
  }

  /**
   * One audio frame from the decoder.
   *
   * Before the mux exists the ADTS frames are HELD, exactly as the video
   * probe holds access units, because the spawn cannot gain an input later
   * and ffmpeg will not write a byte until every input it was given has been
   * probed. After it exists they are either fed or counted as dropped — and
   * a frame that arrives after a SILENT spawn is counted apart, because that
   * one is a recording whose sound was there and was decided away.
   */
  private onAudioFrame(frame: ClipStreamAudioFrame): void {
    if (this.cut !== null) return
    this.audioFrames += 1
    if (this.input.audio === 'none' || frame.audioType !== 'Aac' || frame.data.byteLength === 0) {
      this.audioFramesDropped += 1
      return
    }
    if (this.mux === null) {
      if (
        this.audioProbe.length >= CLIP_STREAM_AUDIO_PROBE_MAX_FRAMES ||
        this.audioProbeBytes + frame.data.byteLength > CLIP_STREAM_AUDIO_PROBE_MAX_BYTES
      ) {
        this.audioFramesDropped += 1
        return
      }
      this.audioProbe = [...this.audioProbe, frame.data]
      this.audioProbeBytes += frame.data.byteLength
      return
    }
    if (this.audioMuxed === null) {
      this.audioFramesDropped += 1
      this.audioFramesAfterMux += 1
      return
    }
    this.feedAudio(frame.data)
  }

  /**
   * What the mux will carry as sound, decided ONCE, before the spawn.
   *
   * The gate is `an ADTS frame is already in hand`, not `the ask was not
   * none`: ffmpeg probes `pipe:3` before it writes output, so declaring an
   * input that never delivers would hold the VIDEO hostage for a recording
   * that simply has no microphone. An ADPCM-only camera is named separately
   * from a silent one — the file path draws the same distinction
   * (`decideClipAudio`) and for the same reason.
   */
  private decideAudio(): void {
    const asked = this.input.audio
    if (asked === 'none') {
      this.audioSilentReason = 'not-requested'
      return
    }
    if (this.audioProbe.length > 0) {
      this.audioMuxed = asked
      return
    }
    this.audioSilentReason = this.audioFrames > 0 ? 'audio-not-copyable' : 'no-audio-track'
  }

  /** Spawn ffmpeg with the probed rate and hand it what was held. */
  private startMux(): void {
    const first = this.probe[0]
    if (first === undefined || this.mux !== null) return
    this.videoType = first.videoType
    this.rate = probeClipStreamRate(this.timestampsUs)
    this.decideAudio()
    const { row, twin } = this.input
    if (this.rate.fps === null || this.rate.fpsSource !== 'timestamps') {
      // REFUSED, not muxed. Omitting `-r` reads as "no rate" and is not one:
      // ffmpeg then takes the elementary stream's own nominal number, which
      // is exactly what D567 measured wrong (declared 30, delivered 15.019).
      // On this fleet's own bytes, one real camera stream muxed without `-r`
      // came out 63.0 s of video against 42.1 s of its own audio.
      this.deps.logger.warn('videoclips: no measured frame rate for this clip stream', {
        tags: this.tags,
        meta: {
          clipKey: row.clipKey,
          twin,
          branch: 'fps-unmeasured',
          probeAccessUnits: this.rate.accessUnits,
          residueAccessUnits: this.residueUnits,
        },
      })
      this.sever(
        'rate-unmeasured',
        `no frame rate could be measured over ${String(this.rate.accessUnits)} access units`,
      )
      return
    }
    let mux: ClipStreamMuxProcess
    try {
      mux = this.deps.spawnMux(
        buildClipStreamMuxArgs({
          videoType: this.videoType,
          fps: this.rate.fps,
          audio: this.audioMuxed,
        }),
      )
    } catch (err: unknown) {
      this.sever('mux-failed', `ffmpeg could not be spawned: ${describe(err)}`)
      return
    }
    this.mux = mux
    if (this.audioMuxed !== null) {
      this.audioIn = writableAt(mux.stdio, CLIP_STREAM_AUDIO_FD)
      if (this.audioIn === null) {
        // The spawner gave us no fd 3 although the args declare `pipe:3`.
        // ffmpeg would block probing an input nobody can write, so the whole
        // stream — video included — would stall. Refuse the SOUND, by name,
        // and keep the clip: the args are rebuilt without the input below.
        this.audioMuxed = null
        this.audioSilentReason = 'no-audio-track'
        this.deps.logger.warn('videoclips: a clip stream mux exposed no audio pipe', {
          tags: this.tags,
          meta: { clipKey: row.clipKey, twin, branch: 'audio-pipe-missing' },
        })
        this.sever('mux-failed', 'the mux was spawned with an audio input it does not expose')
        return
      }
      this.audioIn.on('error', (err: Error) =>
        this.sever('mux-failed', `ffmpeg audio stdin: ${err.message}`),
      )
      this.audioIn.on('drain', () => this.audioStdinGate.drained())
    }
    this.muxClosed = new Promise<number | null>((resolve) => {
      mux.on('close', (code) => resolve(code))
      mux.on('error', (err) => {
        this.sever('mux-failed', `ffmpeg failed: ${err.message}`)
        resolve(null)
      })
    })
    mux.stderr?.on('data', (chunk: Buffer) => {
      if (this.muxStderr.length < 2_000) this.muxStderr += chunk.toString('utf8')
    })
    mux.stdin?.on('error', (err: Error) => this.sever('mux-failed', `ffmpeg stdin: ${err.message}`))
    mux.stdin?.on('drain', () => this.stdinGate.drained())
    mux.stdout?.on('data', (chunk: Buffer) => this.onMuxOut(chunk))
    mux.stdout?.on('end', () => this.finishSink())
    this.deps.logger.info('videoclips: a clip stream is muxing', {
      tags: this.tags,
      meta: {
        clipKey: row.clipKey,
        twin,
        videoType: this.videoType,
        fps: this.rate.fps,
        fpsSource: this.rate.fpsSource,
        probeAccessUnits: this.rate.accessUnits,
        audioAsked: this.input.audio,
        audioMuxed: this.audioMuxed,
        audioSilentReason: this.audioSilentReason,
        probeAudioFrames: this.audioProbe.length,
      },
    })
    const held = this.probe
    this.probe = []
    const heldAudio = this.audioProbe
    this.audioProbe = []
    this.audioProbeBytes = 0
    // Video first, then the audio it was interleaved with: ffmpeg reads the
    // input whose next timestamp is lowest, and handing it the whole audio
    // probe before any video would make it wait on a pipe we are not writing.
    for (const unit of held) this.feed(unit.annexB)
    if (this.audioMuxed === null) this.audioFramesDropped += heldAudio.length
    else for (const frame of heldAudio) this.feedAudio(frame)
  }

  private feed(annexB: Buffer): void {
    if (this.cut !== null || this.mux?.stdin === null || this.mux?.stdin === undefined) return
    this.stdinGate.wrote(this.mux.stdin.write(annexB))
  }

  private feedAudio(adts: Buffer): void {
    const audioIn = this.audioIn
    if (this.cut !== null || audioIn === null) return
    this.audioStdinGate.wrote(audioIn.write(adts))
  }

  /** ffmpeg's output, to the peer, honouring `write()`'s return (D447). */
  private onMuxOut(chunk: Buffer): void {
    if (this.cut !== null) return
    const { sink } = this.input
    if (!this.begun) {
      this.begun = true
      sink.begin(clipStreamContentTypeFor(this.audioMuxed))
    }
    const accepted = sink.write(chunk)
    this.bytesOut += chunk.byteLength
    this.peerGate.wrote(accepted)
    if (accepted) return
    // Native flow control on the one hop that HAS a pause: ffmpeg's stdout
    // waits for the peer to drain. The camera hop has none, hence the gate.
    const stdout = this.mux?.stdout
    stdout?.pause()
    sink.onceDrain(() => {
      this.peerGate.drained()
      stdout?.resume()
    })
  }

  private finishSink(): void {
    if (this.cut !== null || this.ended) return
    this.ended = true
    this.input.sink.end()
  }

  /** Sever every hop, once, and say why. */
  /**
   * The lane this run is still holding, some time after it was cut.
   *
   * D391: a branch that ACCEPTED work and produces nothing is the same branch
   * as one that drops it. `sever()` already says the stream was cut; it does
   * not say that the camera never let go, which is the part that makes every
   * later tap on this host fail.
   */
  private armCutWatch(reason: ClipStreamCutReason): void {
    const cutAt = Date.now()
    this.cutWatch = setTimeout(() => {
      this.cutWatch = null
      if (this.done) return
      this.deps.logger.warn('videoclips: a cut clip stream is still holding its camera lane', {
        tags: this.tags,
        meta: {
          clipKey: this.input.row.clipKey,
          twin: this.input.twin,
          branch: 'cut-not-honoured',
          reason,
          hostKey: this.input.device.hostKey,
          heldSinceCutMs: Date.now() - cutAt,
          accessUnits: this.accessUnits,
          bytesOut: this.bytesOut,
          begun: this.begun,
        },
      })
    }, this.deps.cutGraceMs)
    this.cutWatch.unref?.()
  }

  private sever(reason: ClipStreamCutReason, detail: string): void {
    // A run that has ANSWERED cannot be cut: the outcome is already with the
    // caller and the bytes are already at the peer, so a late sever would
    // only destroy a finished response and file a served stream as a defect.
    if (this.cut !== null || this.done) return
    this.cut = { reason, detail }
    this.disposeGates()
    this.mux?.kill('SIGKILL')
    this.deps.logger.warn('videoclips: a clip stream was cut', {
      tags: this.tags,
      meta: {
        clipKey: this.input.row.clipKey,
        twin: this.input.twin,
        branch: reason,
        detail,
        accessUnits: this.accessUnits,
        bytesOut: this.bytesOut,
        begun: this.begun,
        audioMuxed: this.audioMuxed,
        audioFramesIn: this.audioFrames,
        audioFramesDropped: this.audioFramesDropped,
      },
    })
    if (this.begun) this.input.sink.destroy()
    this.armCutWatch(reason)
  }

  private cutOutcome(cut: CutState): ClipStreamOutcome {
    if (this.begun) {
      return { kind: 'cut', reason: cut.reason, detail: cut.detail, bytesOut: this.bytesOut }
    }
    // Nothing reached the peer, so the route may still answer with a status.
    // A mux that failed is not a camera flake and is not retried.
    return {
      kind: 'refused',
      code: 'fetch-failed',
      detail: `${cut.reason}: ${cut.detail}`,
      attempts: this.attempt,
    }
  }

  private onTransferFailed(err: unknown): AttemptResult {
    if (this.cut !== null) return this.cutOutcome(this.cut)
    if (this.accessUnits === 0) return { kind: 'no-media', detail: describe(err) }
    this.sever('camera-failed', describe(err))
    return this.cutOutcome({ reason: 'camera-failed', detail: describe(err) })
  }

  private async onTransferEnded(): Promise<AttemptResult> {
    if (this.cut !== null) return this.cutOutcome(this.cut)
    if (this.accessUnits === 0) {
      return { kind: 'no-media', detail: 'the camera answered the transfer with no access unit' }
    }
    // A clip shorter than the probe: mux what there is, measured over all of it.
    if (this.mux === null) this.startMux()
    const cutAtStart = this.cut
    if (cutAtStart !== null) return this.cutOutcome(cutAtStart)
    const mux = this.mux
    if (mux === null || this.muxClosed === null) {
      return this.cutOutcome({ reason: 'mux-failed', detail: 'no mux after the transfer ended' })
    }
    mux.stdin?.end()
    // BOTH inputs, or ffmpeg waits for an EOF that never comes on pipe:3 and
    // the flush timer turns a whole served clip into `mux-hung`.
    this.audioIn?.end()
    // An ENDED input is FLUSHING, not stalling. Two reasons this cannot be
    // left to the run's own end: Node emits no `drain` after `end()`
    // (`afterWrite` guards it with `!state.ending`), so a gate armed here can
    // never be disarmed; and the flush window is LONGER than the drain
    // window (15 s against 10 s), so an armed gate fires INSIDE the run and
    // cuts a stream whose mux is merely finishing. The flush timer below is
    // what bounds this phase, and it is the only thing that should (D604).
    this.stdinGate.dispose()
    this.audioStdinGate.dispose()
    const flush = setTimeout(
      () =>
        this.sever(
          'mux-hung',
          `ffmpeg did not exit ${this.deps.flushTimeoutMs} ms after its input ended`,
        ),
      this.deps.flushTimeoutMs,
    )
    const code = await this.muxClosed
    clearTimeout(flush)
    const cutAfter = this.cut
    if (cutAfter !== null) return this.cutOutcome(cutAfter)
    if (code !== 0) {
      this.sever('mux-failed', `ffmpeg exited ${String(code)}: ${this.muxStderr.slice(0, 300)}`)
      return this.cutOutcome({ reason: 'mux-failed', detail: this.muxStderr.slice(0, 300) })
    }
    this.finishSink()
    return this.served()
  }

  /** The stream landed: judge it against the row, out loud, and answer. */
  private served(): ClipStreamOutcome {
    const { row, twin } = this.input
    const timing = estimateVideoTiming({ timestampsUs: this.timestampsUs })
    // A pass whose timestamps went backwards after the mux spanned TWO
    // transfers, so its span is not this recording's duration and the row it
    // would be judged against is not the one it measured. Unknown, by name —
    // never a number, and never the `short` this defect used to file (D393).
    const durationSeconds =
      this.timestampsBroken || timing.fpsSource !== 'timestamps' ? null : timing.durationSeconds
    const verdict = judgeClipDuration({
      expectedMs: row.endMs - row.startMs,
      decodedSeconds: durationSeconds,
      ...(row.inProgress === true ? { inProgress: true } : {}),
    })
    const audio = this.audioReport()
    const meta = {
      clipKey: row.clipKey,
      twin,
      attempt: this.attempt,
      accessUnits: this.accessUnits,
      audioMuxed: audio.muxed,
      bytesOut: this.bytesOut,
      durationSeconds,
      expectedMs: row.endMs - row.startMs,
      fps: this.rate.fps,
      fpsSource: this.rate.fpsSource,
      videoType: this.videoType,
      // What was NOT this stream: frames of a previous, cut transfer that the
      // camera was still delivering. Zero on every ordinary pass.
      residueAccessUnits: this.residueUnits,
      timestampsBroken: this.timestampsBroken,
    }
    if (verdict.kind === 'short') {
      // SERVED — the peer already has it — but named, so a short stream is
      // never mistaken for a short recording. The file path would retry on
      // the long window here; a stream has nothing to replace.
      this.deps.logger.warn('videoclips: a clip stream came up short against its row', {
        tags: this.tags,
        meta: {
          ...meta,
          branch: 'stream-short',
          shortfallSeconds: verdict.shortfallSeconds,
          retried: false,
        },
      })
    } else if (verdict.kind === 'unknown') {
      this.deps.logger.warn('videoclips: a clip stream could not be checked for truncation', {
        tags: this.tags,
        meta: { ...meta, branch: 'completeness-unverified', reason: verdict.reason },
      })
    } else {
      this.deps.logger.info('videoclips: a clip stream landed whole', {
        tags: this.tags,
        meta: { ...meta, branch: 'stream-served' },
      })
    }
    this.reportAudio(audio)
    return {
      kind: 'served',
      accessUnits: this.accessUnits,
      audio,
      bytesOut: this.bytesOut,
      durationSeconds,
      verdict,
      rate: this.rate,
      attempts: this.attempt,
    }
  }

  private audioReport(): ClipStreamAudioReport {
    return {
      asked: this.input.audio,
      muxed: this.audioMuxed,
      reason: this.audioSilentReason,
      framesIn: this.audioFrames,
      framesDropped: this.audioFramesDropped,
      framesAfterMux: this.audioFramesAfterMux,
    }
  }

  /**
   * Say what became of the sound, on EVERY served stream — including the one
   * that carried it.
   *
   * A branch that accepts work and produces nothing is the branch that has to
   * speak (D391), and silence is exactly what that looks like here. But a
   * stream that DID carry audio says so too, with the frame count, because
   * "the clip was silent" and "the clip had sound and you did not hear it"
   * are answered from this line and nowhere else.
   */
  private reportAudio(audio: ClipStreamAudioReport): void {
    const { row, twin } = this.input
    const meta = {
      clipKey: row.clipKey,
      twin,
      audioAsked: audio.asked,
      audioMuxed: audio.muxed,
      audioFramesIn: audio.framesIn,
      audioFramesDropped: audio.framesDropped,
      audioFramesAfterMux: audio.framesAfterMux,
    }
    if (audio.muxed !== null) {
      this.deps.logger.info('videoclips: a clip stream carried sound', {
        tags: this.tags,
        meta: { ...meta, branch: 'stream-with-audio' },
      })
      return
    }
    if (audio.framesAfterMux > 0) {
      // The worst of the silent branches: the recording HAD sound, and the
      // decision had already been taken when it arrived. Named apart so it
      // can never be read as a camera with no microphone.
      this.deps.logger.warn('videoclips: a clip stream dropped sound that arrived too late', {
        tags: this.tags,
        meta: { ...meta, branch: 'stream-audio-after-mux' },
      })
      return
    }
    if (audio.asked === 'none') {
      this.deps.logger.info('videoclips: a clip stream was served without sound', {
        tags: this.tags,
        meta: { ...meta, branch: 'stream-video-only' },
      })
      return
    }
    this.deps.logger.warn('videoclips: a clip stream was asked for sound and had none', {
      tags: this.tags,
      meta: { ...meta, branch: `stream-silent:${audio.reason ?? 'unknown'}` },
    })
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
