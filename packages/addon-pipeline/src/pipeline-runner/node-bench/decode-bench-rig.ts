/**
 * The real streams of the node benchmark's `decode` measurement (D1078).
 *
 * One profile, N streams, each the path a camera's session takes on this node:
 *
 *   pacer ─▶ RtspRestreamer ─▶ loopback RTSP ─▶ decode worker (forked, node-av)
 *            (the broker's own      (TCP)        same hwaccel offer and lease
 *             packetizer and SDP)                 knobs as a live session
 *
 * The encoded pictures are pushed at the profile's frame rate, in real time,
 * into the broker's own restream code — so the worker dials what it dials for
 * a camera (same SDP, same parameter sets in band, the detection intent on
 * the muted path) and decodes at the pace a camera imposes. A file or an
 * unpaced pipe would let it decode as fast as it can, which measures a
 * different thing.
 *
 * Decoded pixels stay in the worker (D9): the runner receives a frame HANDLE
 * per picture, and reads only the small gray motion view, at the session's
 * detection rate, to run the motion kernel on it — what a session does before
 * it decides whether to infer.
 *
 * What a stream reports is what the driver judges: frames delivered, how late
 * each arrived against its own media clock, the errors, and the decode backend
 * the worker named.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
  type SessionTeardownMode,
} from '../../session-decode/session-decode-coordinator.js'
import type { WorkerLeaseKnobs } from '../../session-decode/native-lease-knobs.js'
import type { SessionHwaccelOffer } from '../../session-decode/session-hwaccel.js'
import type { VideoFrame, VideoFrameSource } from '../../session-decode/video-frame-generator.js'
import { MUTED_PATH_SUFFIX, withDetectionIntent } from '../../stream-broker/rtsp/restream-intent.js'
import { RtspListenServer } from '../../stream-broker/rtsp/rtsp-listen-server.js'
import { RtspRestreamer } from '../../stream-broker/rtsp/rtsp-restreamer.js'
import { percentile } from '../capacity/capacity-runner.js'
import type { DecodeRig, DecodeScaleOutcome, DecodeStreamWindow } from './decode-bench-driver.js'
import type { DecodeBenchSource } from './decode-bench-source.js'

const LOOPBACK = '127.0.0.1'
/** Fork, hardware context, dial and the first keyframe (one a second) — generous. */
const FIRST_FRAME_TIMEOUT_MS = 20_000
/** How long close waits for a stopped stream's session to settle. */
const CLOSE_GRACE_MS = 3_000
/** The motion view's longer side — the size a session's motion pass reads. */
const MOTION_VIEW_SIDE = 320
/** Streams started in one step are spread over the keyframe interval by this many pictures. */
const STAGGER_PICTURES = 4

/** The motion kernel on two consecutive gray views of one stream. */
export type DecodeBenchMotionPass = (
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
) => void

export interface DecodeBenchRigDeps {
  readonly source: DecodeBenchSource
  /** The session's detection rate: the motion view is read at this cadence. */
  readonly motionFps: number
  readonly fork: (source: VideoFrameSource) => ForkedChildLike
  readonly lease: () => WorkerLeaseKnobs
  readonly hwaccel: () => SessionHwaccelOffer
  readonly logger: IScopedLogger
  /** The benchmark run and node the streams belong to; every line of the run carries them. */
  readonly runId: string
  readonly nodeId: string
  /** null = the motion kernel could not be loaded; the cell says motion did not run. */
  readonly motion: DecodeBenchMotionPass | null
  /** Asked before every fork: a reason to refuse the next stream, or null. */
  readonly admit: () => string | null
  readonly firstFrameTimeoutMs?: number
}

interface MotionView {
  readonly width: number
  readonly height: number
}

/** The picture fitted inside the motion square, aspect kept, even sides. */
function motionViewOf(width: number, height: number): MotionView {
  const scale = MOTION_VIEW_SIDE / Math.max(width, height, 1)
  const even = (v: number): number => Math.max(2, Math.round((v * scale) / 2) * 2)
  return { width: even(width), height: even(height) }
}

class BenchStream {
  readonly restreamer: RtspRestreamer
  private picture = 0
  private delay: number
  private frames = 0
  private ages: number[] = []
  private errors = 0
  private dead = false
  private decoder: string | null = null
  private stopped = false
  private previousGray: Uint8Array | null = null
  private lastMotionAt = 0
  private teardown: ((mode: SessionTeardownMode) => void) | null = null
  private finished: Promise<void> = Promise.resolve()
  private resolveFirst: (reason: string | null) => void = () => undefined
  readonly first: Promise<string | null>
  motionRuns = 0

  constructor(
    readonly ordinal: number,
    private readonly deps: DecodeBenchRigDeps,
  ) {
    this.restreamer = new RtspRestreamer(`node-bench-decode-${ordinal}`)
    this.delay = (ordinal * STAGGER_PICTURES) % Math.max(1, deps.source.profile.fps)
    this.first = new Promise((resolve) => {
      this.resolveFirst = resolve
    })
  }

  /** One pacer tick: the stream's next picture, at its own media time. */
  push(): void {
    if (this.delay > 0) {
      this.delay -= 1
      return
    }
    const { accessUnits, profile } = this.deps.source
    const unit = accessUnits[this.picture % accessUnits.length]
    if (unit === undefined) return
    const pts = (this.picture * 1000) / profile.fps
    this.picture += 1
    this.restreamer.pushPacket({
      type: 'video',
      data: unit.data,
      pts,
      dts: pts,
      keyframe: unit.keyframe,
      codec: profile.codec,
    })
  }

  /** Fork the worker and consume its frames until stopped. */
  start(port: number, token: string): void {
    const { profile } = this.deps.source
    const coordinator = createSessionDecodeCoordinator({
      fork: this.deps.fork,
      lease: this.deps.lease,
      hwaccel: this.deps.hwaccel,
      logger: this.deps.logger,
      teardownMode: () => 'immediate',
      onSessionTeardown: (teardown) => {
        this.teardown = teardown
      },
      onDialTiming: (timing) => {
        this.decoder = timing.decodeBackend ?? null
      },
    })
    const source: VideoFrameSource = {
      restreamUrl: withDetectionIntent(
        `rtsp://${LOOPBACK}:${port}/${token}${MUTED_PATH_SUFFIX}`,
        0,
      ),
      // No camera: a negative id can never collide with a device's.
      deviceId: -(this.ordinal + 1),
      codec: profile.codec,
    }
    // No delivery rate is asked for: the worker's throttle admits a picture
    // only when a full interval has passed since the last one, so asking for
    // the profile rate drops every picture that arrives a millisecond early
    // (measured: 10 of 15 delivered by an idle hardware decoder). Unthrottled,
    // what is delivered is what was decoded.
    this.finished = this.consume(coordinator.generateVideoFrames(source, {}))
  }

  private async consume(frames: AsyncGenerator<VideoFrame, void>): Promise<void> {
    try {
      for await (const frame of frames) {
        try {
          if (this.stopped) break
          const arrived = Date.now()
          this.frames += 1
          if (frame.capturedAt !== undefined) this.ages.push(arrived - frame.capturedAt)
          this.resolveFirst(null)
          await this.motion(frame, arrived)
        } finally {
          frame.image.close()
        }
      }
      if (!this.stopped) this.fail('the worker ended the stream')
    } catch (err) {
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  private fail(reason: string): void {
    this.errors += 1
    this.dead = true
    this.resolveFirst(reason)
    this.deps.logger.warn('node bench: decode stream failed', {
      tags: { runId: this.deps.runId, nodeId: this.deps.nodeId },
      meta: { stream: this.ordinal + 1, reason },
    })
  }

  /** The session's motion pass: the small gray view, at the detection rate. */
  private async motion(frame: VideoFrame, now: number): Promise<void> {
    const pass = this.deps.motion
    if (pass === null || now - this.lastMotionAt < 1000 / this.deps.motionFps) return
    this.lastMotionAt = now
    const view = motionViewOf(frame.image.width, frame.image.height)
    const gray = await frame.image.toBuffer({ resize: view, format: 'gray' })
    if (gray.length !== view.width * view.height) return
    if (this.previousGray !== null && this.previousGray.length === gray.length) {
      pass(this.previousGray, gray, view.width, view.height)
      this.motionRuns += 1
    }
    this.previousGray = gray
  }

  beginWindow(): void {
    this.frames = 0
    this.ages = []
    // A stream that died stays an error in every later window.
    this.errors = this.dead ? 1 : 0
  }

  window(): DecodeStreamWindow {
    return {
      frames: this.frames,
      ageP95Ms: this.ages.length === 0 ? null : percentile(this.ages, 0.95),
      errors: this.errors,
      decoder: this.decoder,
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.resolveFirst('stopped')
    // Nothing a bench stream holds is worth a drain: stop the worker now. The
    // grace only bounds a session that does not settle on its own.
    this.teardown?.('immediate')
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_GRACE_MS)
      timer.unref?.()
    })
    await Promise.race([this.finished, grace])
    if (timer !== undefined) clearTimeout(timer)
    this.restreamer.destroy()
  }
}

/** Open the rig of one profile: the loopback server and the pacer, no stream yet. */
export async function openDecodeBenchRig(deps: DecodeBenchRigDeps): Promise<DecodeRig> {
  const server = new RtspListenServer()
  server.setLogger(deps.logger)
  await server.start(0, LOOPBACK)
  const port = server.getPort()
  const streams: BenchStream[] = []
  const intervalMs = 1000 / deps.source.profile.fps
  const firstFrameTimeoutMs = deps.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS

  // Self-correcting pacer: a late tick pushes what it owes, so the media
  // clock of every stream stays real time whatever the event loop did.
  let pacing = true
  let due = Date.now() + intervalMs
  let timer: NodeJS.Timeout | undefined
  const tick = (): void => {
    if (!pacing) return
    const now = Date.now()
    while (due <= now) {
      for (const stream of streams) stream.push()
      due += intervalMs
    }
    timer = setTimeout(tick, Math.max(0, due - Date.now()))
    timer.unref?.()
  }
  tick()

  const awaitFirst = async (stream: BenchStream): Promise<string | null> => {
    let timeout: NodeJS.Timeout | undefined
    const late = new Promise<string>((resolve) => {
      timeout = setTimeout(
        () => resolve(`delivered no frame within ${Math.round(firstFrameTimeoutMs / 1000)} s`),
        firstFrameTimeoutMs,
      )
      timeout.unref?.()
    })
    const reason = await Promise.race([stream.first, late])
    if (timeout !== undefined) clearTimeout(timeout)
    return reason === null ? null : `unresolved: stream ${stream.ordinal + 1} ${reason}`
  }

  const scaleTo = async (count: number): Promise<DecodeScaleOutcome> => {
    const added: BenchStream[] = []
    while (streams.length < count) {
      const refused = deps.admit()
      if (refused !== null) return { ready: false, reason: refused }
      const stream = new BenchStream(streams.length, deps)
      const token = server.registerRestreamer(
        `node-bench-decode:${stream.ordinal}`,
        stream.restreamer,
      )
      streams.push(stream)
      added.push(stream)
      stream.start(port, token)
    }
    const reasons = await Promise.all(added.map(awaitFirst))
    const reason = reasons.find((r) => r !== null) ?? null
    return { ready: reason === null, reason }
  }

  return {
    scaleTo,
    beginWindow: () => {
      for (const stream of streams) stream.beginWindow()
    },
    endWindow: () => streams.map((stream) => stream.window()),
    motionRan: () => streams.some((stream) => stream.motionRuns > 0),
    close: async () => {
      // The pacer keeps feeding until the workers are gone: a worker with no
      // picture to pull would hold its session open to the frame timeout.
      await Promise.all(streams.map((stream) => stream.stop()))
      pacing = false
      if (timer !== undefined) clearTimeout(timer)
      for (const stream of streams)
        server.unregisterRestreamer(`node-bench-decode:${stream.ordinal}`)
      await Promise.race([
        server.stop(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, CLOSE_GRACE_MS)
          t.unref?.()
        }),
      ])
    },
  }
}
