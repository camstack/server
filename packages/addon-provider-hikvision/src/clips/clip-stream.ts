/**
 * One clip STREAM: camera → replay → ffmpeg → peer, with a cut on every hop.
 *
 * The forward-only fMP4 D597 defined, produced from a Hikvision RTSP replay
 * instead of a Reolink cmd-5 transfer. What is the same is deliberate — the
 * broker dials this, demuxes it and paces it with code that must not know
 * which vendor is behind the socket. What differs is measured, and each
 * difference is named where it lands.
 *
 * ## The run, in order
 *
 * 1. **Open the replay.** A refusal here is the camera's and is reported with
 *    its status; nothing has reached the peer, so it is a clean refusal.
 * 2. **Probe the rate.** Access units are HELD, not forwarded, until the
 *    replay's own RTP timestamps can say what rate the clip is
 *    (`clip-replay-rate.ts`). A window that cannot measure is WIDENED to
 *    {@link CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS} and then the stream is
 *    REFUSED by name (`rate-unmeasured`), never handed to ffmpeg's own default
 *    — which is 25 fps for a raw elementary stream and would play a 13 fps
 *    clip at half speed with nothing in the file to say so (D567, D604).
 * 3. **Decide the sound, once.** The audio input exists only if a µ-law
 *    payload is already held. ffmpeg probes every input before it writes a
 *    byte of output, so an audio pipe that never delivers holds the VIDEO
 *    hostage (D600). A recording with no microphone is muxed silent and says
 *    which kind of silence it is.
 * 4. **Spawn, flush what is held, and stream.**
 * 5. **End.** The camera closing the replay socket IS the end of the segment —
 *    this firmware sends no end marker and zero RTCP — so the close ends
 *    ffmpeg's inputs, and ffmpeg's exit ends the peer.
 *
 * ## The three hops that can stall (D447)
 *
 * The access units into ffmpeg's stdin, the µ-law into `pipe:3`, and ffmpeg's
 * stdout into the socket. None may pile up in process memory: the SOURCE
 * cannot be paused mid-segment without tearing the replay down. Each hop has
 * its own {@link createDrainGate}, and **every gate is disposed the moment its
 * input is ended** — Node emits no `drain` after `end()`, so a gate armed at
 * EOF can never be disarmed and would sever a stream that was already served,
 * 10 s after it finished. That is D604's second defect, and it was measured as
 * the ordinary case rather than a rare one.
 *
 * **On fd 3 the gate asks a second question before it fires.** 64 KiB of
 * µ-law is eight seconds of sound, so a muxer that is merely AHEAD on audio
 * stops reading the pipe and Node emits no further `drain` — indistinguishable,
 * from the pipe alone, from a muxer that has died. ffmpeg's own output settles
 * it: while bytes are still reaching the peer the window RE-ARMS instead of
 * severing. Measured on 1436, 2026-09-23: 9 993 026 bytes and 251 access units
 * delivered, and the stream cut at 24.9 s for `mux-audio-stalled`.
 *
 * ## A run that has ANSWERED can no longer be cut
 *
 * `answered` is checked by every sever. A late sever would destroy a finished
 * response and file a served stream as a defect, which is exactly what one
 * operator log did.
 */
import type { ChildProcess } from 'node:child_process'

import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { type PinnedFfmpegSpawnAnswer, resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import { estimateReplayFps, replayFpsIsExact } from './clip-replay-rate.js'
import type { HikvisionClipRow } from './clip-catalog.js'
import {
  buildClipStreamMuxArgs,
  clipStreamContentTypeFor,
  CLIP_STREAM_AUDIO_FD,
  CLIP_STREAM_DRAIN_TIMEOUT_MS,
  CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS,
  createDrainGate,
  writableStdio,
  type ClipStreamAudioCodec,
  type ClipStreamHop,
  type DrainGate,
} from './clip-stream-mux.js'
import { openRtspReplay, type RtspReplaySession } from './rtsp/rtsp-replay-session.js'
import type { VideoAccessUnit } from './rtsp/rtp-depacketize.js'

/**
 * Access units held back before ffmpeg is spawned, so `-r` can be measured.
 *
 * Sixteen is about a second at the 13 fps this fleet's replays deliver, and
 * the RTP clock is 90 kHz, so fifteen intervals is a precise average rather
 * than a rounded one.
 */
export const CLIP_STREAM_RATE_PROBE_ACCESS_UNITS = 16

/**
 * How far the probe may be EXTENDED when the first window could not measure.
 *
 * A window is not a deadline. 128 units is about ten seconds at 13 fps and a
 * few MiB of held access units; past it, a stream that still cannot say its
 * own rate is refused rather than muxed at a number nobody measured.
 */
export const CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS = 128

/**
 * How many access units may go INTO the mux before its output must contain
 * media, not just a header.
 *
 * **A mux that accepts frames and emits only an init segment is the branch
 * D391 names, and until this existed it was completely silent.** Measured on
 * 1436, 2026-09-23, from the operator's own attempt: 129 access units in,
 * `bytesOut: 1298` out — ten bytes per frame of 4K HEVC — and the only
 * evidence anywhere was `pushed: 0` on the broker and a peer that gave up
 * after 10.6 s. Nothing said the mux had failed, because nothing was asked.
 *
 * Sixty-four units is 5.1 s of media at this fleet's 12.5 fps, which is more
 * than one GOP (50 frames, 4 s) — so a healthy stream has closed a fragment
 * well before it, `-frag_duration` aside. Past it, a stream still sitting on
 * its header is cut BY NAME with ffmpeg's own words attached.
 */
export const CLIP_STREAM_NO_MEDIA_ACCESS_UNITS = 64

/**
 * What counts as "still only a header".
 *
 * A two-track fMP4 init segment measured 1 298 bytes; one 4K fragment is half
 * a megabyte. 64 KiB is two orders of magnitude clear of the first and one
 * clear of the second, so neither a large init nor a small first fragment can
 * be mistaken for the other.
 */
export const CLIP_STREAM_INIT_ONLY_BYTES = 64 * 1024

/** What a caller may ask a stream to carry. `none` is a real ask. */
export type ClipStreamAudioAsk = ClipStreamAudioCodec | 'none'

/** The peer, as the producer sees it. */
export interface ClipStreamSink {
  begin(contentType: string): void
  write(chunk: Buffer): boolean
  onceDrain(listener: () => void): void
  onceClose(listener: () => void): void
  end(): void
  destroy(): void
}

/** Why a stream did not happen. A SUBSET of the clip-export vocabulary. */
export type ClipStreamRefusalCode = 'camera-refused' | 'fetch-failed'

export type ClipStreamOutcome =
  | { readonly kind: 'served' }
  /** Bytes had reached the peer; the sink is already destroyed. */
  | { readonly kind: 'cut' }
  | {
      readonly kind: 'refused'
      readonly code: ClipStreamRefusalCode
      readonly detail: string
    }

/** Everything the producer needs to know about one camera. */
export interface ClipStreamCamera {
  readonly deviceId: number
  readonly host: string
  readonly username: string
  readonly password: string
}

export interface ClipStreamRequest {
  readonly camera: ClipStreamCamera
  readonly row: HikvisionClipRow
  readonly audio: ClipStreamAudioAsk
  readonly sink: ClipStreamSink
}

export interface ClipStreamProducerDeps {
  readonly logger: IScopedLogger
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /** Seam for the spec: the real spawn otherwise. */
  readonly spawnMux?: (args: readonly string[]) => ChildProcess
  readonly openReplay?: typeof openRtspReplay
  readonly probeAccessUnits?: number
  readonly maxProbeAccessUnits?: number
  readonly drainTimeoutMs?: number
  readonly flushTimeoutMs?: number
}

export interface ClipStreamProducer {
  stream(request: ClipStreamRequest): Promise<ClipStreamOutcome>
}

/** Why a stream that was ASKED for sound is not carrying it. */
export type ClipStreamSilence = 'not-requested' | 'no-audio-track' | 'audio-after-mux'

export function createClipStreamProducer(deps: ClipStreamProducerDeps): ClipStreamProducer {
  const openReplay = deps.openReplay ?? openRtspReplay
  const probeTarget = deps.probeAccessUnits ?? CLIP_STREAM_RATE_PROBE_ACCESS_UNITS
  const probeMax = deps.maxProbeAccessUnits ?? CLIP_STREAM_RATE_PROBE_MAX_ACCESS_UNITS
  const drainTimeoutMs = deps.drainTimeoutMs ?? CLIP_STREAM_DRAIN_TIMEOUT_MS
  const flushTimeoutMs = deps.flushTimeoutMs ?? CLIP_STREAM_MUX_FLUSH_TIMEOUT_MS

  return {
    stream: async (request): Promise<ClipStreamOutcome> => {
      // Asked per stream, so a later successful resolution is picked up.
      // An injected seam is used SYNCHRONOUSLY, as before; only the real
      // spawn waits for the resolver.
      const mux: PinnedFfmpegSpawnAnswer =
        deps.spawnMux !== undefined
          ? { kind: 'ready', spawn: deps.spawnMux }
          : await resolvePinnedFfmpegSpawner(undefined, deps.resolveFfmpeg, {
              // Four pipes, always. An unused fd costs nothing, and a spawner
              // that had to read the args would be a second authority on
              // whether this stream carries sound.
              stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            })
      if (mux.kind === 'refused') {
        // Refused before the replay is dialled, named per camera — never a
        // PATH `ffmpeg` in place of the pinned one (D540).
        deps.logger.error(
          'videoclips: clip stream refused — no pinned ffmpeg on this node (D540)',
          {
            tags: { deviceId: request.camera.deviceId },
            meta: { clipKey: request.row.clipKey, detail: mux.detail },
          },
        )
        return { kind: 'refused', code: 'fetch-failed', detail: mux.detail }
      }
      const spawnMux = mux.spawn
      return await new ClipStreamRun(request, {
        logger: deps.logger,
        openReplay,
        spawnMux,
        probeTarget,
        probeMax,
        drainTimeoutMs,
        flushTimeoutMs,
      }).run()
    },
  }
}

interface RunDeps {
  readonly logger: IScopedLogger
  readonly openReplay: typeof openRtspReplay
  readonly spawnMux: (args: readonly string[]) => ChildProcess
  readonly probeTarget: number
  readonly probeMax: number
  readonly drainTimeoutMs: number
  readonly flushTimeoutMs: number
}

class ClipStreamRun {
  /** Held while the rate is being probed. Nothing has reached the peer yet. */
  private heldVideo: VideoAccessUnit[] = []
  private heldAudio: Buffer[] = []
  private mux: ChildProcess | null = null
  private replay: RtspReplaySession | null = null
  private muxedAudio: ClipStreamAudioCodec | null = null
  private silence: ClipStreamSilence | null = null
  private videoGate: DrainGate | null = null
  private audioGate: DrainGate | null = null
  private peerGate: DrainGate | null = null
  private answered = false
  /** Settles when this run no longer holds the camera's one replay slot. */
  private slotFreed: Promise<void> = Promise.resolve()
  private settle: ((outcome: ClipStreamOutcome) => void) | null = null
  private bytesOut = 0
  /** {@link bytesOut} the last time the audio gate's window elapsed. */
  private bytesOutAtAudioWindow = 0
  private audioNotHungryLogged = false
  private accessUnits = 0
  private audioFramesAfterMux = 0
  private audioFramesDropped = 0
  private firstByteAt: number | null = null
  /** The span the replay really delivered, from its own clock. Never the
   *  row's, which is a projection (D393). */
  private deliveredMs: number | null = null
  private begun = false
  /** ffmpeg's own words, bounded. Kept so EVERY exit can carry them, not just
   *  the one that happened to be holding the closure. */
  private stderr = ''
  private readonly startedAt = Date.now()

  constructor(
    private readonly request: ClipStreamRequest,
    private readonly deps: RunDeps,
  ) {}

  private get tags(): { deviceId: number } {
    return { deviceId: this.request.camera.deviceId }
  }

  private get meta(): Record<string, unknown> {
    return { clipKey: this.request.row.clipKey, audio: this.request.audio }
  }

  async run(): Promise<ClipStreamOutcome> {
    const outcome = await new Promise<ClipStreamOutcome>((resolve) => {
      this.settle = resolve
      void this.start().catch((err: unknown) => {
        this.refuse('fetch-failed', err instanceof Error ? err.message : String(err))
      })
    })
    this.disposeGates()
    // The run does not answer until the camera's slot is really free: the
    // caller serialises replays per camera on the strength of this promise,
    // and "the run returned" is a different fact from "the socket is gone".
    await this.slotFreed
    return outcome
  }

  private async start(): Promise<void> {
    this.request.sink.onceClose(() => {
      // The peer walked away. Bytes already written are gone either way, and
      // holding the camera's replay open for a socket nobody reads is the one
      // thing a bounded producer must not do.
      this.sever('peer-closed', 'the peer closed the stream')
    })

    let replay: RtspReplaySession
    try {
      replay = await this.deps.openReplay(
        {
          host: this.request.camera.host,
          username: this.request.camera.username,
          password: this.request.camera.password,
          playbackPath: this.request.row.playbackPath,
        },
        {
          onVideo: (unit) => this.onVideo(unit),
          // Asked for nothing ⇒ the track is not followed at all, which is
          // also what keeps a silent ask from paying for a second channel.
          ...(this.request.audio === 'none'
            ? {}
            : { onAudio: (payload: Buffer) => this.onAudio(payload) }),
        },
        { logger: this.deps.logger, deviceId: this.request.camera.deviceId },
      )
    } catch (err: unknown) {
      // The replay logged its own branch. This is the producer's refusal.
      this.refuse('camera-refused', err instanceof Error ? err.message : String(err))
      return
    }
    this.replay = replay
    if (this.request.audio !== 'none' && !replay.hasAudio) {
      this.silence = 'no-audio-track'
    }
    if (this.request.audio === 'none') this.silence = 'not-requested'

    void replay.ended.then((end) => {
      if (end.kind === 'failed') {
        // A replay that failed BEFORE the mux existed has reached no peer.
        if (this.mux === null) {
          this.refuse('camera-refused', end.detail)
          return
        }
        this.sever('replay-failed', end.detail)
        return
      }
      this.finishInputs(end.kind === 'complete' ? end.deliveredMs : null)
    })
  }

  private onVideo(unit: VideoAccessUnit): void {
    if (this.answered) return
    if (this.mux !== null) {
      this.writeVideo(unit)
      return
    }
    this.heldVideo.push(unit)
    const timestamps = this.heldVideo.map((held) => held.timestamp)
    // The window is a BOUND on how long we wait for an answer, not a quota to
    // fill: a metronomic clock has already given the answer and every further
    // unit costs 80 ms of the operator's wait, because this replay arrives at
    // 1× (D616). A clock that is not metronomic falls through to the full
    // window, unchanged.
    if (this.heldVideo.length < this.deps.probeTarget && !replayFpsIsExact(timestamps)) return
    const rate = estimateReplayFps(timestamps, this.replay?.video.clockRate ?? 90_000)
    if (rate.fps === null) {
      // The window is widened, not judged. Past the bound the stream is
      // refused rather than muxed at a rate nobody measured.
      if (this.heldVideo.length < this.deps.probeMax) return
      this.refuse(
        'fetch-failed',
        `rate-unmeasured: ${String(this.heldVideo.length)} access units and the replay's own ` +
          "timestamps still cannot say this clip's frame rate",
      )
      return
    }
    this.startMux(rate.fps)
  }

  private onAudio(payload: Buffer): void {
    if (this.answered) return
    if (this.mux === null) {
      this.heldAudio.push(payload)
      return
    }
    if (this.muxedAudio === null) {
      // Sound that arrived after the decision was taken. Counted, not
      // written: the mux has no input to take it (D600's loudest case).
      this.audioFramesAfterMux += 1
      if (this.silence === null) this.silence = 'audio-after-mux'
      return
    }
    this.writeAudio(payload)
  }

  private startMux(fps: number): void {
    const askedAudio = this.request.audio
    // Decided ONCE, from audio already in hand.
    this.muxedAudio = askedAudio === 'none' || this.heldAudio.length === 0 ? null : askedAudio
    if (this.muxedAudio === null && askedAudio !== 'none' && this.silence === null) {
      this.silence = 'no-audio-track'
    }
    const args = buildClipStreamMuxArgs({
      videoCodec: this.replay?.video.codec ?? 'h265',
      fps,
      audio: this.muxedAudio,
    })
    let child: ChildProcess
    try {
      child = this.deps.spawnMux(args)
    } catch (err: unknown) {
      this.refuse('fetch-failed', `ffmpeg could not be spawned: ${describe(err)}`)
      return
    }
    this.mux = child
    this.deps.logger.info('videoclips: a clip stream is muxing', {
      tags: this.tags,
      meta: {
        ...this.meta,
        fps,
        codec: this.replay?.video.codec ?? null,
        probeUnits: this.heldVideo.length,
        probeAudioFrames: this.heldAudio.length,
        muxedAudio: this.muxedAudio,
        silence: this.silence,
      },
    })

    this.videoGate = createDrainGate({
      timeoutMs: this.deps.drainTimeoutMs,
      onStall: () => this.sever('mux-stalled', 'ffmpeg stopped taking access units'),
    })
    if (this.muxedAudio !== null) {
      this.audioGate = createDrainGate({
        timeoutMs: this.deps.drainTimeoutMs,
        onStall: () => this.sever('mux-audio-stalled', 'ffmpeg stopped taking audio frames'),
        stillMoving: () => this.muxProducedSinceLastAudioWindow(),
      })
    }
    this.peerGate = createDrainGate({
      timeoutMs: this.deps.drainTimeoutMs,
      onStall: () => this.sever('peer-stalled', 'the peer stopped taking bytes'),
    })

    child.on('error', (err: Error) => this.sever('mux-failed', `ffmpeg failed: ${err.message}`))
    child.stdin?.on('error', (err: Error) =>
      this.sever('mux-failed', `ffmpeg stdin: ${err.message}`),
    )
    child.stdin?.on('drain', () => this.videoGate?.drained())
    const audioPipe = writableStdio(child.stdio[CLIP_STREAM_AUDIO_FD])
    if (audioPipe !== null) {
      audioPipe.on('error', (err: Error) =>
        this.sever('mux-failed', `ffmpeg audio stdin: ${err.message}`),
      )
      audioPipe.on('drain', () => this.audioGate?.drained())
    }
    child.stdout?.on('data', (chunk: Buffer) => this.onMuxOutput(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2000)
    })
    child.on('close', (code) => this.onMuxClosed(code, this.stderr))

    for (const unit of this.heldVideo) this.writeVideo(unit)
    this.heldVideo = []
    if (this.muxedAudio !== null) {
      for (const payload of this.heldAudio) this.writeAudio(payload)
    } else {
      this.audioFramesDropped += this.heldAudio.length
    }
    this.heldAudio = []
  }

  /**
   * Has this mux taken frames and produced no MEDIA?
   *
   * Checked as units go in, because that is the only place that knows the mux
   * is being fed. A header and nothing else is not a slow stream, it is a
   * broken one, and the peer will otherwise sit on it until it gives up with
   * nothing to show the operator but a blank player.
   */
  private checkMuxProducedMedia(): void {
    if (this.answered || this.mux === null) return
    if (this.accessUnits < CLIP_STREAM_NO_MEDIA_ACCESS_UNITS) return
    if (this.bytesOut > CLIP_STREAM_INIT_ONLY_BYTES) return
    this.sever(
      'mux-no-media',
      `ffmpeg took ${String(this.accessUnits)} access units and produced ` +
        `${String(this.bytesOut)} bytes — a header and no media` +
        (this.stderr.trim() === ''
          ? ' (ffmpeg said nothing)'
          : `: ${this.stderr.trim().slice(-300)}`),
    )
  }

  private writeVideo(unit: VideoAccessUnit): void {
    const stdin = this.mux?.stdin
    if (stdin === null || stdin === undefined || stdin.destroyed) return
    this.accessUnits += 1
    this.checkMuxProducedMedia()
    if (this.answered) return
    this.videoGate?.wrote(stdin.write(unit.bytes))
  }

  /**
   * Did the mux hand the peer anything during the window the audio gate just
   * waited out?
   *
   * The gate's question is "has this hop stopped for good", and on fd 3 the
   * answer cannot be read from the pipe alone: 64 KiB of µ-law is eight
   * seconds of sound, so a muxer that is merely AHEAD on audio looks exactly
   * like one that has died. ffmpeg's own output settles it — bytes on stdout
   * are proof it is running — and each window is judged on its own, so a
   * mux that really stops is still cut one window later.
   */
  private muxProducedSinceLastAudioWindow(): boolean {
    const moved = this.bytesOut > this.bytesOutAtAudioWindow
    this.bytesOutAtAudioWindow = this.bytesOut
    if (moved && !this.audioNotHungryLogged) {
      this.audioNotHungryLogged = true
      // The branch is LOUD once: a gate that keeps re-arming on a healthy run
      // is invisible otherwise, and it is the only thing standing between a
      // quiet µ-law pipe and a severed stream (D391).
      this.deps.logger.info('videoclips: the mux is not taking audio but is still producing', {
        tags: this.tags,
        meta: { ...this.meta, bytesOut: this.bytesOut, accessUnits: this.accessUnits },
      })
    }
    return moved
  }

  private writeAudio(payload: Buffer): void {
    const pipe = writableStdio(this.mux?.stdio[CLIP_STREAM_AUDIO_FD])
    if (pipe === null) return
    this.audioGate?.wrote(pipe.write(payload))
  }

  private onMuxOutput(chunk: Buffer): void {
    if (this.answered) return
    if (!this.begun) {
      this.begun = true
      this.firstByteAt = Date.now()
      // The status line is written on the FIRST MUXED BYTE, never before:
      // until then every refusal still owns it, and a camera that serves
      // nothing must answer a status with a reason, not an empty 200.
      this.request.sink.begin(clipStreamContentTypeFor(this.muxedAudio))
    }
    this.bytesOut += chunk.byteLength
    const accepted = this.request.sink.write(chunk)
    this.peerGate?.wrote(accepted)
    if (accepted) return
    // ── Re-armed per refusal, never once at spawn (D618) ──────────────────
    // `onceDrain` is `res.once`: firing CONSUMES the listener. Registered a
    // single time at spawn, the first back-pressure episode used it up and
    // every later one armed a gate nothing alive could disarm — the stream
    // was cut for "a peer that stopped taking bytes" while 4.68 MB and 137
    // access units were flowing through it. Measured on 1436 at elapsedMs
    // 11 176 / 11 265 / 11 286 / 11 301 across four attempts: 10 s of gate
    // plus the ~1.2 s to the broker's SECOND pause. Reolink has always
    // re-registered here, which is why only Hikvision clips died.
    //
    // And the mux is PAUSED while the peer is behind, as Reolink pauses it:
    // ffmpeg's stdout has native flow control and the camera hop has none,
    // so without this the provider buffers the backlog in its own heap
    // instead of letting it rest in the pipe.
    this.mux?.stdout?.pause()
    this.request.sink.onceDrain(() => {
      this.peerGate?.drained()
      this.mux?.stdout?.resume()
    })
  }

  private finishInputs(deliveredMs: number | null): void {
    if (this.answered) return
    this.deliveredMs = deliveredMs
    const stdin = this.mux?.stdin
    if (stdin !== null && stdin !== undefined && !stdin.destroyed) stdin.end()
    // An ENDED input is flushing, not stalling, and Node emits no `drain`
    // after `end()` — a gate left armed here can never be disarmed (D604).
    this.videoGate?.dispose()
    writableStdio(this.mux?.stdio[CLIP_STREAM_AUDIO_FD])?.end()
    this.audioGate?.dispose()
    if (this.mux === null) {
      // The replay ended before the probe could measure. Nothing was served.
      this.refuse(
        'fetch-failed',
        `the replay ended after ${String(this.heldVideo.length)} access units, before the ` +
          'frame rate could be measured',
      )
      return
    }
    const flush = setTimeout(() => {
      this.sever('mux-flush-timeout', 'ffmpeg did not exit after its inputs ended')
    }, this.deps.flushTimeoutMs)
    this.mux.once('close', () => clearTimeout(flush))
  }

  private onMuxClosed(code: number | null, stderr: string): void {
    if (this.answered) return
    if (!this.begun) {
      this.refuse(
        'fetch-failed',
        `ffmpeg produced no output (exit ${String(code)}): ${stderr.trim().slice(0, 300)}`,
      )
      return
    }
    this.answer({ kind: 'served' })
    this.request.sink.end()
    this.deps.logger.info('videoclips: a clip stream was served', {
      tags: this.tags,
      meta: {
        ...this.meta,
        accessUnits: this.accessUnits,
        bytesOut: this.bytesOut,
        muxedAudio: this.muxedAudio,
        silence: this.silence,
        audioFramesAfterMux: this.audioFramesAfterMux,
        audioFramesDropped: this.audioFramesDropped,
        firstByteMs: this.firstByteAt === null ? null : this.firstByteAt - this.startedAt,
        elapsedMs: Date.now() - this.startedAt,
        muxExit: code,
        deliveredMs: this.deliveredMs,
        rowMs: this.request.row.endMs - this.request.row.startMs,
        short: this.isShort(),
      },
    })
    if (this.isShort() === true) {
      // The bytes are at the peer and a second pass cannot replace them, so
      // this is a STATEMENT, not a retry — but a pass that delivered less than
      // the catalog said the segment was must not be indistinguishable from a
      // whole one. `null` is unknown and is never judged short (D393).
      this.deps.logger.warn('videoclips: a clip stream came up short of its catalog row', {
        tags: this.tags,
        meta: {
          ...this.meta,
          branch: 'stream-short',
          deliveredMs: this.deliveredMs,
          rowMs: this.request.row.endMs - this.request.row.startMs,
        },
      })
    }
  }

  /**
   * Did this pass deliver less than the catalog said the segment was?
   *
   * `null` when nothing measured the span — unknown is not short. The
   * tolerance is one second, which is under a single GOP at this fleet's
   * 12.5 fps and over the rounding the two clocks disagree by.
   */
  private isShort(): boolean | null {
    if (this.deliveredMs === null) return null
    const rowMs = this.request.row.endMs - this.request.row.startMs
    if (rowMs <= 0) return null
    return this.deliveredMs < rowMs - 1_000
  }

  /** A stream that had already reached the peer, stopped. */
  private sever(branch: string, detail: string): void {
    if (this.answered) return
    if (!this.begun) {
      // Nothing reached the peer, so this is still a refusal with somewhere to
      // put its reason.
      this.refuse('fetch-failed', `${branch}: ${detail}`)
      return
    }
    this.answer({ kind: 'cut' })
    this.deps.logger.warn('videoclips: a clip stream was cut', {
      tags: this.tags,
      meta: {
        ...this.meta,
        branch,
        reason: detail,
        // ffmpeg's own words travel with EVERY cut, not only with the refusal
        // that happened to be holding them. A mux that failed and said why,
        // into a log line that dropped it, is the silence D391 forbids.
        muxStderr: this.stderr.trim().slice(-500),
        accessUnits: this.accessUnits,
        bytesOut: this.bytesOut,
        elapsedMs: Date.now() - this.startedAt,
      },
    })
    this.request.sink.destroy()
  }

  private refuse(code: ClipStreamRefusalCode, detail: string): void {
    if (this.answered) return
    this.answer({ kind: 'refused', code, detail })
    this.deps.logger.warn('videoclips: a clip stream was refused', {
      tags: this.tags,
      meta: { ...this.meta, branch: code, reason: detail },
    })
  }

  /** The one place `answered` is set — and after it, nothing can sever. */
  private answer(outcome: ClipStreamOutcome): void {
    this.answered = true
    this.disposeGates()
    this.slotFreed = this.replay?.close() ?? Promise.resolve()
    if (outcome.kind !== 'served') this.mux?.kill('SIGKILL')
    this.settle?.(outcome)
    this.settle = null
  }

  /** Hygiene: no timer outlives the run. Not a gate — see D604's own note. */
  private disposeGates(): void {
    this.videoGate?.dispose()
    this.audioGate?.dispose()
    this.peerGate?.dispose()
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every hop a stall can be named at. Exported so the spec can enumerate. */
export const CLIP_STREAM_HOPS: readonly ClipStreamHop[] = ['mux-stdin', 'mux-audio-stdin', 'peer']
