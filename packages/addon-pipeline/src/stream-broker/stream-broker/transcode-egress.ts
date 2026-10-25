/**
 * TranscodeEgress — the egress half of `getStreamWithCodec`.
 *
 * The broker's RTSP listen server is restream-only (no ANNOUNCE/RECORD), so an
 * ffmpeg that *publishes* to it 404s. ffmpeg's `-rtsp_flags listen` server mode
 * is unreliable across builds (it attempts to connect, not listen). So we use
 * the pattern already proven in this codebase (the WebRTC transcode feed):
 * ffmpeg writes the transcoded **Annex-B elementary stream to stdout**, and we
 * push those bytes into a `RtspRestreamer` via `pushPacket` (which deframes +
 * repacketizes). The consumer gets back a normal broker token URL.
 *
 * VIDEO-ONLY: `pushPacket` handles video; audio in the restreamer travels a
 * separate RTP path, so the transcode egress drops audio (matching the WebRTC
 * transcode feed). Audio-in-transcode is a future enhancement.
 *
 * Decode hw-accel is tried first (big CPU win) but is fragile for some HEVC
 * streams (VideoToolbox can fail to decode). If ffmpeg dies before producing any
 * output and a decode backend was set, we respawn once with software decode.
 *
 * Every collaborator is injected so the wiring is unit-testable without real
 * ffmpeg or sockets.
 */
import type { SpawnedFfmpegProcess } from '@camstack/types/node'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EncodedPacket,
  FfmpegAudioCodecId,
  FfmpegAudioSidecar,
  FfmpegInvocation,
  IScopedLogger,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import { NO_COST_CLAIM, type ChildCostClaimHandle } from '@camstack/types/node'
import { buildBrokerEgressArgs, type FfmpegSpawnFn } from './ffmpeg-invocation.js'

/** The audio codecs that can ride the RTP sidecar. */
type AudioSidecarCodec = FfmpegAudioCodecId

import { extractAudioMediaBlock } from '../rtsp/egress-audio-sdp.js'
import { type AudioRtpReceiver, UdpAudioRtpReceiver } from '../rtsp/udp-audio-rtp-receiver.js'

/** Minimal surface of RtspRestreamer the egress feeds (Annex-B chunks + optional audio). */
export interface RtspRestreamerLike {
  pushPacket(packet: EncodedPacket): void
  /** Forward an RTP audio datagram (transcode-egress audio sidecar). */
  pushAudioRtpPassthrough?(rtp: Buffer): void
  /** Graft the egress audio track onto the push-mode SDP. */
  setEgressAudioBlock?(block: string | null): void
}

/**
 * A registered egress channel: a restreamer already registered on the broker's
 * main listen server, its shareable consumer URL, and a release hook that
 * unregisters + destroys it. Created by production code that holds the concrete
 * `RtspRestreamer` type, so the egress only ever sees the structural `*Like`.
 */
export interface EgressChannel {
  readonly restreamer: RtspRestreamerLike
  readonly consumerUrl: string
  release(): void
}

export interface TranscodeEgressDeps {
  readonly logger: IScopedLogger
  readonly ffmpegBinaryPath: string
  readonly spawnFn: FfmpegSpawnFn
  /** Create + register a restreamer for this brokerId on the main listen server. */
  readonly acquireChannel: (brokerId: string) => EgressChannel
  /**
   * Claim this egress's ffmpeg as the broker addon's cost, for THIS camera.
   *
   * Taken on every spawn attempt (the hardware→software fallback spawns twice)
   * and released the moment that generation exits or fails to start, so a
   * fallback never leaves the abandoned hardware child claimed. Optional: an
   * unclaimed ffmpeg still shows up in the node's process snapshot, in the
   * unattributed bucket.
   */
  readonly claimCost?: (pid: number | undefined) => ChildCostClaimHandle
  /** How long to wait for ffmpeg's first output byte before declaring it dead. */
  readonly firstDataTimeoutMs?: number
  /**
   * The child exited AFTER it went live. Not a start failure and not a `stop()`
   * — the stream simply ended, and whoever refcounts this egress needs to stop
   * handing it out. Silence here is how a dead child stayed shareable until its
   * refcount happened to drain.
   */
  readonly onChildExit?: (error: Error) => void
  /** Audio-sidecar collaborators — injected so the wiring is testable. */
  readonly audioReceiverFactory?: () => AudioRtpReceiver
  readonly readSdpFile?: (path: string) => Promise<string>
  readonly makeSdpFilePath?: () => string
}

export interface TranscodeEgressArgs {
  readonly brokerId: string
  /** Output codec — decides the elementary container and the packet codec. */
  readonly targetCodec: 'H264' | 'H265'
  /** Invocation minus the sink + audioSidecar — the egress fills those in. */
  readonly invocation: Omit<FfmpegInvocation, 'sink' | 'audioSidecar'>
  /**
   * Opt-in audio sidecar. When set, the egress maps the source audio to an RTP
   * output (UDP) and forwards it to the restreamer, grafting ffmpeg's audio SDP
   * onto the push-mode video SDP. Off by default — the default egress is the
   * live-verified video-only path. NOT live-verified end-to-end (no A+V
   * consumer drives it yet).
   */
  readonly audio?: { readonly codec: AudioSidecarCodec }
}

const DEFAULT_FIRST_DATA_TIMEOUT_MS = 8_000

export class TranscodeEgress {
  private child: SpawnedFfmpegProcess | null = null
  private channel: EgressChannel | null = null
  private stopped = false
  private startedAtMs = 0
  private audioReceiver: AudioRtpReceiver | null = null
  private audioSidecar: FfmpegAudioSidecar | null = null
  private audioGrafted = false
  /**
   * The backend the RUNNING child decodes with — `null` once the software
   * fallback below has fired. Reported rather than assumed: a consumer that
   * asked for hardware and silently got software is the exact failure the
   * primitive exists to make loud, and it cannot see it from the request.
   */
  private activeHwAccel: string | null = null

  constructor(
    private readonly deps: TranscodeEgressDeps,
    private readonly args: TranscodeEgressArgs,
  ) {}

  /** Spawn ffmpeg, stream its stdout into the restreamer. Returns the consumer URL. */
  async start(): Promise<string> {
    const channel = this.deps.acquireChannel(this.args.brokerId)
    this.channel = channel
    try {
      // Only the audio path needs the async UDP bind before spawning; the
      // default video-only egress spawns synchronously.
      if (this.args.audio) {
        await this.setupAudioSidecar(channel.restreamer)
      }
      await this.spawnWithDecodeFallback(channel.restreamer)
    } catch (err) {
      // ffmpeg never produced output — don't leak the process or channel.
      await this.stop()
      throw err
    }
    this.deps.logger.info('transcode egress ready', { meta: { brokerId: this.args.brokerId } })
    return channel.consumerUrl
  }

  /**
   * The decode backend the child ACTUALLY ran with — `null` for software,
   * including after the hardware→software retry below has fired.
   */
  activeDecodeHwAccel(): string | null {
    const value = this.activeHwAccel
    return value === null || value === 'none' || value === 'copy' ? null : value
  }

  /** Tear down ffmpeg and release the channel registration. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.killChild()
    if (this.audioReceiver) {
      this.audioReceiver.stop()
      this.audioReceiver = null
    }
    if (this.channel) {
      this.channel.release()
      this.channel = null
    }
  }

  /**
   * Set up the audio sidecar (opt-in): bind a UDP RTP receiver that forwards
   * each datagram to the restreamer, and allocate the `-sdp_file` path. ffmpeg
   * is later told to map source audio to `rtpUrl`. No-op when audio isn't
   * requested. NOT live-verified end-to-end (no A+V consumer drives it yet).
   */
  private async setupAudioSidecar(restreamer: RtspRestreamerLike): Promise<void> {
    const audio = this.args.audio
    if (!audio) return
    const factory =
      this.deps.audioReceiverFactory ?? ((): AudioRtpReceiver => new UdpAudioRtpReceiver())
    const makePath =
      this.deps.makeSdpFilePath ??
      ((): string => join(tmpdir(), `camstack-egress-${randomUUID()}.sdp`))
    const receiver = factory()
    this.audioReceiver = receiver
    const { rtpUrl } = await receiver.start((rtp) => restreamer.pushAudioRtpPassthrough?.(rtp))
    this.audioSidecar = { codec: audio.codec, rtpUrl, sdpFile: makePath() }
    this.deps.logger.info('transcode egress: audio sidecar listening', {
      meta: { brokerId: this.args.brokerId, rtpUrl, codec: audio.codec },
    })
  }

  /**
   * Read ffmpeg's `-sdp_file` (written when the RTP audio output opens), extract
   * the `m=audio` block and graft it onto the restreamer SDP. Best-effort: a
   * miss just means the consumer negotiates video only.
   */
  private async graftAudioSdp(restreamer: RtspRestreamerLike, sdpFile: string): Promise<void> {
    const read = this.deps.readSdpFile ?? ((p: string): Promise<string> => readFile(p, 'utf8'))
    try {
      const sdpText = await read(sdpFile)
      const block = extractAudioMediaBlock(sdpText)
      if (block) {
        restreamer.setEgressAudioBlock?.(block)
        this.deps.logger.info('transcode egress: audio track grafted onto SDP', {
          meta: { brokerId: this.args.brokerId },
        })
      } else {
        this.deps.logger.warn('transcode egress: ffmpeg SDP had no audio media block', {
          meta: { brokerId: this.args.brokerId },
        })
      }
    } catch (err) {
      this.deps.logger.warn('transcode egress: failed to graft audio SDP', {
        meta: { brokerId: this.args.brokerId, error: errMsg(err) },
      })
    }
  }

  /**
   * Try decode hw-accel first; if ffmpeg dies before producing output and a
   * decode backend was requested, respawn once with software decode.
   */
  private async spawnWithDecodeFallback(restreamer: RtspRestreamerLike): Promise<void> {
    const decode = this.args.invocation.decodeHwAccel
    this.activeHwAccel = decode
    try {
      await this.spawnAttempt(restreamer, decode)
    } catch (err) {
      if (this.stopped) throw err
      if (decode && decode !== 'none') {
        this.activeHwAccel = null
        this.deps.logger.warn(
          'transcode egress: hw decode produced no output — retrying software decode',
          {
            meta: { brokerId: this.args.brokerId, decodeHwAccel: decode, error: errMsg(err) },
          },
        )
        await this.spawnAttempt(restreamer, null)
        return
      }
      throw err
    }
  }

  /**
   * Spawn ffmpeg writing the transcoded Annex-B stream to stdout, piping each
   * chunk into the restreamer. Resolves on the FIRST output byte (the pipeline
   * is live); rejects if ffmpeg exits / errors / is silent before then.
   */
  private spawnAttempt(
    restreamer: RtspRestreamerLike,
    decodeHwAccel: string | null,
  ): Promise<void> {
    const container: 'h264' | 'hevc' = this.args.targetCodec === 'H264' ? 'h264' : 'hevc'
    const packetCodec = this.args.targetCodec === 'H264' ? 'h264' : 'h265'
    const args = buildBrokerEgressArgs(
      { ...this.args.invocation, decodeHwAccel },
      { kind: 'stdout', container },
      this.audioSidecar,
    )

    return new Promise<void>((resolve, reject) => {
      const child = this.deps.spawnFn(this.deps.ffmpegBinaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      this.startedAtMs = Date.now()
      // One claim per GENERATION. `spawnWithDecodeFallback` may spawn a second
      // child after a hardware backend produces nothing; without a
      // per-generation release the abandoned one would keep reporting cost for
      // a camera whose ffmpeg is already dead.
      const costClaim = this.deps.claimCost?.(child.pid) ?? NO_COST_CLAIM
      let settled = false

      const timeoutMs = this.deps.firstDataTimeoutMs ?? DEFAULT_FIRST_DATA_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.killChild()
        reject(new Error(`transcode egress: no output within ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
          // Pipeline is live: graft the audio SDP once (ffmpeg has opened the
          // RTP output and written -sdp_file by now).
          if (this.audioSidecar && !this.audioGrafted) {
            this.audioGrafted = true
            void this.graftAudioSdp(restreamer, this.audioSidecar.sdpFile)
          }
        }
        const ptsMs = Date.now() - this.startedAtMs
        restreamer.pushPacket({
          type: 'video',
          data: chunk,
          pts: ptsMs,
          dts: ptsMs,
          keyframe: false, // the restreamer's deframer detects real keyframes
          codec: packetCodec,
        })
      })

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (line: string) => {
        this.deps.logger.debug('transcode egress ffmpeg', {
          meta: { brokerId: this.args.brokerId, line: line.trim() },
        })
      })

      child.once('error', (err: Error) => {
        costClaim.release()
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      child.once('exit', (code, signal) => {
        costClaim.release()
        if (settled) {
          // Exited after going live: the data just stops, and until now nothing
          // said so. A deliberate `stop()` is not a death.
          if (this.stopped) return
          const error = new Error(
            `transcode egress: ffmpeg exited while live (code=${code} signal=${signal})`,
          )
          this.deps.logger.warn('transcode egress: ffmpeg exited while live', {
            meta: { brokerId: this.args.brokerId, code, signal },
          })
          this.deps.onChildExit?.(error)
          return
        }
        settled = true
        clearTimeout(timer)
        reject(
          new Error(
            `transcode egress: ffmpeg exited before output (code=${code} signal=${signal})`,
          ),
        )
      })
    })
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch (err) {
        this.deps.logger.warn('transcode egress ffmpeg kill error', {
          meta: { brokerId: this.args.brokerId, error: errMsg(err) },
        })
      }
    }
  }
}
