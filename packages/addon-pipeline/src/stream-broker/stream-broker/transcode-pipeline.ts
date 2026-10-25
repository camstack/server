/**
 * Transcode-pipeline manager — backs `streamBroker.getStreamWithCodec`.
 *
 * Responsibilities:
 *   1. Source-select: profile-driven only. With `profile` the assigned
 *      camStreamId IS the source; without it the first published stream.
 *   2. Passthrough (no ffmpeg, `-c copy`): when `video:'copy'`, OR when the
 *      source codec already matches the requested codec AND `audio:'copy'`
 *      AND no `outputArgs`. Returns the broker restream URL.
 *   3. Spawn + refcount transcode pipelines otherwise: one `TranscodeEgress`
 *      per unique (deviceId, source, videoCodec, audioCodec, resolution,
 *      outputArgs) tuple, multi-consumer via refcount. Stops the egress N
 *      seconds after the refcount drops to 0 (`releaseGraceMs`).
 *   4. Pick the right encoder + decode hw-accel: consults
 *      `platform-probe.getHardwareEncoders` / `resolveHwAccel` (typed, cached)
 *      and the system `ffmpeg` config (binaryPath / hwAccel / threadCount),
 *      falling back to `libx264` / `libx265` and software decode.
 *
 * Egress: ffmpeg runs as an RTSP *server* (`-rtsp_flags listen`) on an internal
 * The transcoded Annex-B stream is read from ffmpeg's stdout and pushed into a
 * restreamer registered under a consumer token (see `TranscodeEgress`). The
 * broker's RTSP server is restream-only, so the old "ffmpeg publishes to the
 * broker" path 404'd, and ffmpeg's RTSP listen mode is unreliable — the stdout
 * pipe is the pattern proven by the WebRTC transcode feed.
 */
import { randomUUID } from 'node:crypto'
import type {
  AudioCodecTarget,
  CameraStream,
  CamProfile,
  GetStreamWithCodecInput,
  IKernelHwAccel,
  IScopedLogger,
  RtpSource,
} from '@camstack/types'
import { errMsg, makeSourceBrokerId } from '@camstack/types'
// Node-only: it SPAWNS ffmpeg to ask what it can encode.
import { probeFfmpegBinary, type FfmpegBinaryCapabilities } from '@camstack/types/node'
import { DEFAULT_VAAPI_RENDER_DEVICE, rankDecodeHwAccels } from '../../shared/ffmpeg-decode-args.js'
import {
  brokerTranscodeInvocation,
  classifyDecodeHwAccel,
  type FfmpegHwAccelPrefer,
  type FfmpegHwAccelSetting,
  type FfmpegSystemConfig,
  chooseVideoEncoder,
  requireBrokerFfmpeg,
  toAudioSidecarCodec,
  type FfmpegSpawnFn,
  defaultFfmpegSpawn,
} from './ffmpeg-invocation.js'
import { withSentryIntent } from '../rtsp/restream-intent.js'
import { type EgressChannel, TranscodeEgress } from './transcode-egress.js'

type CameraStreamLookup = (deviceId: number) => readonly CameraStream[]
type RtspEntryLookup = (brokerId: string) => { url: string; mutedUrl: string } | null
/** Resolve the camStreamId assigned to a device's profile slot, or null. */
type ProfileSourceLookup = (deviceId: number, profile: CamProfile) => string | null
/** Create + register an egress channel (restreamer + token URL) for a brokerId. */
type AcquireChannelFn = (brokerId: string) => EgressChannel
/**
 * Resolve a per-source-stream decode `hwaccel` override, or `null` when the
 * stream has no override (→ fall back to the global `ffmpeg.hwAccel` config).
 */
type StreamHwAccelLookup = (deviceId: number, camStreamId: string) => FfmpegHwAccelSetting | null

/** Answers "may this camera be dialled in sentry?" — see `sentry-eligibility.ts`. */
type SentryOfferedLookup = (deviceId: number) => Promise<boolean>

interface PipelineEntry {
  readonly key: string
  readonly source: RtpSource
  readonly egress: TranscodeEgress | null
  refcount: number
  releaseTimer: NodeJS.Timeout | null
}

const DEFAULT_FFMPEG_CONFIG: FfmpegSystemConfig = {
  // No binary until the addon hands one over: a transcode then REFUSES by
  // name rather than spawning a PATH `ffmpeg` (D540).
  binaryPath: null,
  // Software decode is the safe default: it decodes every HEVC source rather
  // than hard-failing on a fragile one (the forced-backend trap). Operators
  // opt into hw decode via `ffmpeg.hwAccel` ('auto' or a specific backend) or a
  // per-source-stream override.
  hwAccel: 'copy',
  threadCount: 0,
}

export interface TranscodePipelineManagerOptions {
  readonly logger: IScopedLogger
  /**
   * Ask an ffmpeg binary what it can do. Injected so a test never spawns one —
   * and so the answer can be faked for a binary this machine does not have.
   */
  readonly probeFfmpeg?: (binaryPath: string) => Promise<FfmpegBinaryCapabilities>
  /**
   * This node's LOCAL hwaccel resolver (`ctx.kernel.hwaccel`). The decode
   * hw-accel pick and the hardware-encoder pick both resolve from THIS node's
   * hardware in-process — never the `platform-probe` singleton, whose per-node
   * `nodePin` does not survive a forked agent child's link chain (it answers
   * with the HUB's hardware). Omitted → software decode/encode.
   */
  readonly hwaccel?: IKernelHwAccel
  readonly cameraStreamLookup: CameraStreamLookup
  readonly rtspEntryLookup: RtspEntryLookup
  /** Resolve a device profile to its assigned source camStreamId. When
   *  omitted, `getStreamWithCodec` cannot honour a `profile` target. */
  readonly resolveProfileSource?: ProfileSourceLookup
  readonly releaseGraceMs?: number
  /** Live accessor for the system `ffmpeg` config (binaryPath / hwAccel / threadCount). */
  readonly ffmpegConfig?: () => FfmpegSystemConfig
  /**
   * Called when a child is refused for want of the pinned ffmpeg — the host
   * starts its one shared, bounded re-resolve (`FfmpegReresolver`). Absent in a
   * spec that does not care.
   */
  readonly onFfmpegMissing?: () => void
  /**
   * Resolve a per-source-stream decode `hwaccel` override. When it returns a
   * setting, it wins over the global `ffmpeg.hwAccel`; when it returns `null`
   * (or is omitted), the global config applies. The effective default — no
   * per-stream override and no operator-set global — is `'copy'` (software),
   * the safe choice that decodes every HEVC source rather than hard-failing on
   * a fragile one.
   */
  readonly resolveStreamHwAccel?: StreamHwAccelLookup
  /** Injectable for tests; defaults to `node:child_process` spawn. */
  readonly spawnFn?: FfmpegSpawnFn
  /** Create + register the egress restreamer on the broker's main listen
   *  server. Required for the transcode path (the manager is decoupled from
   *  the listen server); when omitted, a transcode request throws. */
  readonly acquireChannel?: AcquireChannelFn
  /**
   * Whether this camera is offered a SENTRY dial — `sentryEligible`, asked by
   * the manager that owns those facts. Omitted ⇒ nobody wired the question, and
   * an unasked question is a NO: a made-up sentry url is a url nothing serves,
   * and a live url substituted for it is the wake the sentry exists to avoid.
   */
  readonly sentryOffered?: SentryOfferedLookup
}

function normaliseCodec(codec: string | undefined): 'H264' | 'H265' | null {
  if (!codec) return null
  const c = codec.toLowerCase()
  if (c === 'h264' || c === 'avc' || c === 'avc1') return 'H264'
  if (c === 'h265' || c === 'hevc' || c === 'hvc1' || c === 'hev1') return 'H265'
  return null
}

function videoTargetToCodec(v: 'h264' | 'h265'): 'H264' | 'H265' {
  return v === 'h264' ? 'H264' : 'H265'
}

function pipelineKeyFor(
  deviceId: number,
  camStreamId: string,
  videoCodec: 'H264' | 'H265' | 'copy',
  audioCodec: AudioCodecTarget,
  outResolution: { width: number; height: number },
  outputArgs: readonly string[],
  audioEgress: boolean,
): string {
  const ae = audioEgress ? '|ae=1' : ''
  const base = `${deviceId}|src=${camStreamId}|v=${videoCodec}|a=${audioCodec}|r=${outResolution.width}x${outResolution.height}${ae}`
  return outputArgs.length > 0 ? `${base}|o=${JSON.stringify(outputArgs)}` : base
}

export class TranscodePipelineManager {
  private readonly entries = new Map<string, PipelineEntry>()
  /** In-flight transcode starts, keyed by pipeline key — single-flight the
   *  async egress start so concurrent acquires share one egress. */
  private readonly pending = new Map<string, Promise<RtpSource>>()
  /** What the ffmpeg at a path can do, asked once. `null` = could not ask. */
  private readonly binaryCapabilities = new Map<string, Promise<FfmpegBinaryCapabilities | null>>()
  private readonly probeFfmpeg: (binaryPath: string) => Promise<FfmpegBinaryCapabilities>
  private readonly logger: IScopedLogger
  private readonly hwaccel: IKernelHwAccel | null
  private readonly cameraStreamLookup: CameraStreamLookup
  private readonly rtspEntryLookup: RtspEntryLookup
  private readonly resolveProfileSource: ProfileSourceLookup | null
  private readonly releaseGraceMs: number
  private readonly ffmpegConfig: () => FfmpegSystemConfig
  private readonly onFfmpegMissing: (() => void) | null
  private readonly resolveStreamHwAccel: StreamHwAccelLookup | null
  private readonly spawnFn: FfmpegSpawnFn
  private readonly acquireChannel: AcquireChannelFn | null
  private readonly sentryOffered: SentryOfferedLookup | null

  constructor(opts: TranscodePipelineManagerOptions) {
    this.logger = opts.logger
    this.hwaccel = opts.hwaccel ?? null
    this.cameraStreamLookup = opts.cameraStreamLookup
    this.rtspEntryLookup = opts.rtspEntryLookup
    this.resolveProfileSource = opts.resolveProfileSource ?? null
    this.releaseGraceMs = opts.releaseGraceMs ?? 5_000
    this.ffmpegConfig = opts.ffmpegConfig ?? (() => DEFAULT_FFMPEG_CONFIG)
    this.onFfmpegMissing = opts.onFfmpegMissing ?? null
    this.probeFfmpeg = opts.probeFfmpeg ?? probeFfmpegBinary
    this.resolveStreamHwAccel = opts.resolveStreamHwAccel ?? null
    this.spawnFn = opts.spawnFn ?? defaultFfmpegSpawn
    this.acquireChannel = opts.acquireChannel ?? null
    this.sentryOffered = opts.sentryOffered ?? null
  }

  async acquire(input: GetStreamWithCodecInput): Promise<RtpSource> {
    const wantedAudio: AudioCodecTarget = input.audio ?? 'aac'
    const outputArgs = input.outputArgs ?? []
    const audioEgress = input.audioEgress === true

    // Source selection precedence:
    //   - `profile` → the profile's assigned camStreamId IS the source.
    //   - else `targetResolution` → the published source closest by area.
    //   - else → the first published stream.
    const sourceStream =
      input.profile !== undefined
        ? this.resolveTargetedStream(input.deviceId, input.profile)
        : input.targetResolution !== undefined
          ? (this.pickClosestSource(input.deviceId, input.targetResolution) ??
            this.firstPublished(input.deviceId))
          : this.firstPublished(input.deviceId)
    if (!sourceStream) {
      throw new Error(
        input.profile === undefined
          ? `getStreamWithCodec: no published stream for device ${input.deviceId}`
          : `getStreamWithCodec: no assigned source for device ${input.deviceId}`,
      )
    }

    const sourceCodec = normaliseCodec(sourceStream.codec)
    // Effective output resolution: explicit target wins, else native source.
    const outResolution = input.targetResolution ??
      sourceStream.resolution ?? { width: 1280, height: 720 }

    // A `copy` cannot be rescaled, so `targetResolution` is ignored for copy
    // SCALING (still honoured for source selection above). The codec-match
    // passthrough branch additionally requires that no rescale is needed.
    const sourceRes = sourceStream.resolution
    const resMatchesTarget =
      input.targetResolution === undefined ||
      (sourceRes !== undefined &&
        sourceRes.width === input.targetResolution.width &&
        sourceRes.height === input.targetResolution.height)

    // Passthrough (no ffmpeg): explicit `copy`, OR the source codec already
    // matches the requested codec AND audio is copy AND no extra output args
    // AND no rescale is needed.
    const wantsPassthrough =
      input.video === 'copy' ||
      (sourceCodec !== null &&
        videoTargetToCodec(input.video) === sourceCodec &&
        wantedAudio === 'copy' &&
        outputArgs.length === 0 &&
        resMatchesTarget)
    if (wantsPassthrough) {
      if (sourceCodec === null) {
        this.logger.warn(
          'copy-passthrough requested but source codec is unknown — reporting H264',
          {
            tags: { deviceId: input.deviceId },
            meta: { deviceId: input.deviceId, camStreamId: sourceStream.camStreamId },
          },
        )
      }
      const passVideoCodec: 'H264' | 'H265' = sourceCodec ?? 'H264'
      // `audio: 'none'` takes the VIDEO-ONLY (`/muted`) restream, and that
      // suffix buys it TWO things: no audio, and the LIVE-EDGE join rule. They
      // used to be one predicate (`RtspSession.isMuted()`); since D525 they are
      // two (`isMuted()` and `isLiveEdgeOnly()`), and `/muted` still answers
      // yes to both — so nothing on this path changed.
      // Handing the non-muted URL to the per-session decode worker — the one
      // consumer that asks for `audio: 'none'` — made the restreamer treat it
      // as a viewer and serve it the catch-up GOP burst that
      // `LIVE_EDGE_MAX_SPAN_MS` exists to withhold from a local decoder, so the
      // protection written for that population had never once applied to it.
      //
      // NOTE: the DETECTION decode later opts back OUT of that withhold — but
      // by declaring an explicit intent on the URL it dials
      // (`stream-broker/rtsp/restream-intent.ts`), not by getting a non-muted
      // one. It is still muted here, and every other muted consumer is
      // unaffected.
      const url = this.resolveSourceUrl(
        input.deviceId,
        sourceStream.camStreamId,
        wantedAudio === 'none',
      )
      const key = pipelineKeyFor(
        input.deviceId,
        sourceStream.camStreamId,
        'copy',
        wantedAudio,
        outResolution,
        outputArgs,
        false,
      )
      // Asked only on a COLD share. An existing passthrough entry already
      // carries the answer, and re-asking would put a registry read on the hot
      // path of every acquire in the fleet.
      return await this.shareOrCreatePassthroughAsync(key, async () => ({
        url,
        sentryUrl: await this.resolveSentryUrl(input.deviceId, url),
        videoCodec: passVideoCodec,
        audioCodec: 'passthrough',
        resolution: outResolution,
        transcoded: false,
        encoder: 'copy',
        pipelineKey: key,
      }))
    }

    const targetCodec: 'H264' | 'H265' = videoTargetToCodec(
      input.video === 'copy' ? 'h264' : input.video,
    )
    const key = pipelineKeyFor(
      input.deviceId,
      sourceStream.camStreamId,
      targetCodec,
      wantedAudio,
      outResolution,
      outputArgs,
      audioEgress,
    )

    const existing = this.entries.get(key)
    if (existing) {
      return this.shareEntry(existing).source
    }

    // Single-flight: a concurrent acquire for the same key shares the in-flight
    // egress start rather than spawning a second ffmpeg.
    const inflight = this.pending.get(key)
    if (inflight) {
      await inflight
      const after = this.entries.get(key)
      if (after) return this.shareEntry(after).source
      // creation failed — fall through and retry below.
    }

    const start = this.startTranscode({
      key,
      deviceId: input.deviceId,
      camStreamId: sourceStream.camStreamId,
      targetCodec,
      audio: wantedAudio,
      audioEgress,
      scale: input.targetResolution ?? null,
      outResolution,
      outputArgs,
    })
    this.pending.set(key, start)
    try {
      return await start
    } finally {
      this.pending.delete(key)
    }
  }

  private async startTranscode(opts: {
    key: string
    deviceId: number
    camStreamId: string
    targetCodec: 'H264' | 'H265'
    audio: AudioCodecTarget
    audioEgress: boolean
    scale: { width: number; height: number } | null
    outResolution: { width: number; height: number }
    outputArgs: readonly string[]
  }): Promise<RtpSource> {
    if (!this.acquireChannel) {
      throw new Error('getStreamWithCodec: transcode egress not wired (acquireChannel missing)')
    }
    const cfg = this.ffmpegConfig()
    const ffmpegBinaryPath = requireBrokerFfmpeg(cfg.binaryPath, {
      logger: this.logger,
      deviceId: opts.deviceId,
      purpose: 'transcode egress',
      ...(this.onFfmpegMissing === null ? {} : { onMissing: this.onFfmpegMissing }),
    })
    // Effective decode preference: per-source-stream override > global
    // `ffmpeg.hwAccel`. The egress + encoder both follow this single value so a
    // per-stream `copy` yields a fully software (max-compat) transcode.
    const effectiveHwAccel = this.effectiveHwAccelSetting(
      opts.deviceId,
      opts.camStreamId,
      cfg.hwAccel,
    )
    // The ENCODER is decided separately from the decode preference: a software
    // decode can feed the GPU, and the encode is where the CPU goes. Gated on
    // what this NODE has and what THIS BINARY can do — the two questions D536
    // separated.
    const choice = chooseVideoEncoder({
      target: opts.targetCodec,
      backend: await this.resolveHardwareBackend(),
      binaryEncoders: await this.resolveBinaryEncoders(ffmpegBinaryPath),
      hwAccelSetting: effectiveHwAccel,
      renderNode: DEFAULT_VAAPI_RENDER_DEVICE,
    })
    const encoder = choice.encoder
    if (choice.softwareReason !== null) {
      // ERROR, not warn, and on every start: the operator's standing rule is
      // that a software transcode must not happen on this fleet. One of these
      // lines is a core spent on work the GPU was there to do, and before this
      // there was no line at all — the fallback was invisible for months.
      this.logger.error(
        'transcode is running on the CPU — a software encode is work the hardware was supposed to do',
        {
          tags: { deviceId: opts.deviceId },
          meta: {
            reason: choice.softwareReason,
            encoder,
            camStreamId: opts.camStreamId,
            targetCodec: opts.targetCodec,
            hwAccelSetting: effectiveHwAccel,
            ffmpeg: cfg.binaryPath,
          },
        },
      )
    } else {
      this.logger.info('transcode encodes on the GPU', {
        tags: { deviceId: opts.deviceId },
        meta: { encoder, camStreamId: opts.camStreamId, device: choice.hwEncodeDevice?.renderNode },
      })
    }
    const decodeHwAccel = await this.resolveDecodeHwAccel(effectiveHwAccel)
    const sourceUrl = this.resolveSourceUrl(opts.deviceId, opts.camStreamId)
    const brokerId = `transcode:${opts.deviceId}:${randomUUID().slice(0, 8)}`

    // Opt-in audio sidecar: only for a re-encoded, sidecar-capable audio target.
    const sidecarCodec = opts.audioEgress ? toAudioSidecarCodec(opts.audio) : null

    const egress = new TranscodeEgress(
      {
        logger: this.logger.child('egress'),
        ffmpegBinaryPath,
        spawnFn: this.spawnFn,
        acquireChannel: this.acquireChannel,
      },
      {
        brokerId,
        targetCodec: opts.targetCodec,
        // Built for the ONE shared builder (`@camstack/types`
        // `ffmpeg/invocation.ts`). The broker used to have its own
        // `buildFfmpegArgs` here; it was deleted, and the WebRTC/derived legs
        // that had a SECOND, hardware-blind one now come through this same
        // shape. `brokerTranscodeInvocation` is the adapter, not a builder.
        invocation: brokerTranscodeInvocation({
          sourceUrl,
          targetCodec: opts.targetCodec,
          encoder,
          hwEncodeDevice: choice.hwEncodeDevice,
          decodeHwAccel,
          scale: opts.scale,
          audio: opts.audio,
          threadCount: cfg.threadCount,
          outputArgs: opts.outputArgs,
        }),
        audio: sidecarCodec ? { codec: sidecarCodec } : undefined,
      },
    )

    const url = await egress.start()

    const source: RtpSource = {
      url,
      // A transcode egress is fed by the broker itself; there is no sentry
      // counterpart of it, and inventing one would be a url nothing serves.
      sentryUrl: null,
      videoCodec: opts.targetCodec,
      audioCodec: opts.audio,
      resolution: opts.outResolution,
      transcoded: true,
      encoder,
      pipelineKey: opts.key,
    }
    const entry: PipelineEntry = { key: opts.key, source, egress, refcount: 1, releaseTimer: null }
    this.entries.set(opts.key, entry)
    this.logger.info('Transcode pipeline started', {
      tags: { deviceId: opts.deviceId },
      meta: { key: opts.key, encoder, decodeHwAccel, sourceUrl, url },
    })
    return source
  }

  private firstPublished(deviceId: number): CameraStream | null {
    return this.cameraStreamLookup(deviceId).find((s) => !!s.url) ?? null
  }

  /**
   * Pick the published source whose pixel area is closest to `target`. Only
   * considers streams that have a `url`. Returns null when none qualify (the
   * caller falls back to `firstPublished`).
   */
  private pickClosestSource(
    deviceId: number,
    target: { width: number; height: number },
  ): CameraStream | null {
    const targetArea = target.width * target.height
    let best: CameraStream | null = null
    let bestDelta = Number.MAX_SAFE_INTEGER
    for (const s of this.cameraStreamLookup(deviceId)) {
      if (!s.url) continue
      const w = s.resolution?.width ?? 1280
      const h = s.resolution?.height ?? 720
      const delta = Math.abs(w * h - targetArea)
      if (delta < bestDelta) {
        bestDelta = delta
        best = s
      }
    }
    return best
  }

  release(pipelineKey: string): { released: boolean; refcount: number } {
    const entry = this.entries.get(pipelineKey)
    if (!entry) return { released: false, refcount: 0 }
    entry.refcount = Math.max(0, entry.refcount - 1)
    if (entry.refcount > 0) {
      return { released: true, refcount: entry.refcount }
    }
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
    }
    entry.releaseTimer = setTimeout(() => {
      const cur = this.entries.get(pipelineKey)
      if (!cur || cur.refcount > 0) return
      void this.shutdownEntry(cur)
    }, this.releaseGraceMs)
    return { released: true, refcount: 0 }
  }

  shutdownAll(): void {
    for (const entry of this.entries.values()) {
      void this.shutdownEntry(entry)
    }
    this.entries.clear()
  }

  /**
   * Resolve a source stream to its broker restream URL
   * (`${deviceId}/${camStreamId}`), so every consumer rides the broker's one
   * source dial. Throws when no restream entry exists — a targeted source
   * must be dialed before it can be consumed.
   */
  private resolveSourceUrl(deviceId: number, camStreamId: string, videoOnly = false): string {
    const brokerId = makeSourceBrokerId(deviceId, camStreamId)
    const entry = this.rtspEntryLookup(brokerId)
    const url = videoOnly ? (entry?.mutedUrl ?? entry?.url) : entry?.url
    if (url) return url
    throw new Error(`getStreamWithCodec: no broker restream for ${brokerId} (source not dialed)`)
  }

  /**
   * Resolve a profile target to its assigned, published source stream.
   * Throws when the profile has no assignment or the assigned source is not
   * currently published — a targeted request must not silently fall back to
   * a different source.
   *
   * Publication is "in the catalog", NOT `!!stream.url`. A `derived:*` stream
   * is broker-owned metadata with no camera pull URL; consumers ride the
   * broker restream (`resolveSourceUrl`), and the broker starts the transcode
   * feeder on demand. Requiring a catalog `url` made recording/WebRTC throw
   * `not published` for a live derived assignment (618, 2026-08-17).
   */
  private resolveTargetedStream(deviceId: number, profile: CamProfile): CameraStream {
    const camStreamId = this.resolveProfileSource?.(deviceId, profile) ?? null
    if (!camStreamId) {
      throw new Error(
        `getStreamWithCodec: profile "${profile}" has no assigned source for device ${deviceId}`,
      )
    }
    const stream = this.cameraStreamLookup(deviceId).find((s) => s.camStreamId === camStreamId)
    if (!stream) {
      throw new Error(
        `getStreamWithCodec: profile "${profile}" source "${camStreamId}" not published for device ${deviceId}`,
      )
    }
    return stream
  }

  /**
   * The h264/hevc hardware ENCODER defaults for THIS node — derived locally
   * from `ctx.kernel.hwaccel` (os.platform + GPU-vendor probe) via a static
   * backend→encoder map, NOT the `platform-probe` singleton's `ffmpeg -encoders`
   * probe (whose per-node `nodePin` answers with the HUB's encoders). `null` →
   * software encode (also the outcome when no local resolver is wired). vaapi is
   * ranked above qsv (qsv is broken on the Intel stack) so an Intel node
   * transcodes with `h264_vaapi`.
   */
  /**
   * The node's hardware backend name (`vaapi`, `qsv`, `videotoolbox`, …), or
   * `null`. Resolved LOCALLY from `ctx.kernel.hwaccel` for the reason the
   * sibling method's docblock gives: the `platform-probe` singleton answers
   * with the HUB's hardware on a forked agent child.
   */
  private async resolveHardwareBackend(): Promise<string | null> {
    if (!this.hwaccel) return null
    try {
      const res = await this.hwaccel.resolve(null)
      return rankDecodeHwAccels(res.preferred, [])[0] ?? null
    } catch (err) {
      this.logger.warn('local hardware resolve failed — the encoder falls back to software', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * What THIS ffmpeg can encode with, asked of the binary once and latched.
   *
   * `null` means we could not ask, which is not the same as "it cannot" — see
   * {@link chooseVideoEncoder}. Keyed by binary PATH, so an operator who
   * repoints `binaryPath` gets a fresh answer without a restart.
   */
  private async resolveBinaryEncoders(binaryPath: string): Promise<ReadonlySet<string> | null> {
    const caps = await this.resolveBinaryCapabilities(binaryPath)
    return caps === null || caps.encoders.size === 0 ? null : caps.encoders
  }

  /**
   * What the ffmpeg at this path reports about itself, asked once and latched
   * per PATH — so an operator who repoints `binaryPath` gets a fresh answer
   * without a restart.
   *
   * A probe that answers nothing is `null`: "we could not ask" must never be
   * read as "it cannot", or one bad probe pins a capable node in software.
   */
  private async resolveBinaryCapabilities(
    binaryPath: string,
  ): Promise<FfmpegBinaryCapabilities | null> {
    const cached = this.binaryCapabilities.get(binaryPath)
    if (cached !== undefined) return await cached
    const probing = this.probeFfmpeg(binaryPath).then((caps): FfmpegBinaryCapabilities | null => {
      if (caps.encoders.size === 0 && caps.hwaccels.size === 0) {
        this.logger.warn(
          'ffmpeg answered nothing about itself — hardware is attempted anyway, and its own failure is the answer',
          { meta: { ffmpeg: binaryPath } },
        )
        return null
      }
      this.logger.info('ffmpeg capabilities probed for transcoding', {
        meta: {
          ffmpeg: binaryPath,
          version: caps.version,
          hwaccels: [...caps.hwaccels].join(',') || 'none',
        },
      })
      return caps
    })
    this.binaryCapabilities.set(binaryPath, probing)
    return await probing
  }

  /**
   * Resolve the effective decode `hwaccel` setting for a (deviceId, camStreamId)
   * source. Precedence: per-source-stream override > global `ffmpeg.hwAccel`.
   * The global default itself is `'copy'` (software) out of the box.
   */
  private effectiveHwAccelSetting(
    deviceId: number,
    camStreamId: string,
    globalSetting: FfmpegHwAccelSetting,
  ): FfmpegHwAccelSetting {
    const override = this.resolveStreamHwAccel?.(deviceId, camStreamId) ?? null
    return override ?? globalSetting
  }

  /**
   * Resolve the decode `hwaccel` VALUE that reaches the ffmpeg builder:
   * - `'auto'` → the literal `'auto'` (ffmpeg self-selects + software-fallbacks
   *   in-process); NEVER collapsed to a forced backend.
   * - `'copy'`/`'none'` → `null` (software decode, no `-hwaccel`).
   * - a specific backend → gated by what the configured ffmpeg can actually
   *   decode (`getHardwareDecodeAccels`); force only when the build supports it,
   *   else software. Per-stream fragility on a supported backend is still caught
   *   by the egress's software fallback.
   */
  private async resolveDecodeHwAccel(setting: FfmpegHwAccelSetting): Promise<string | null> {
    const strategy = classifyDecodeHwAccel(setting)
    if (strategy.kind === 'auto') return 'auto'
    if (strategy.kind === 'software') return null
    return this.resolveSpecificDecodeHwAccel(strategy.prefer)
  }

  /**
   * Resolve a specific operator-forced decode backend against THIS node's local
   * hwaccel resolver. `ctx.kernel.hwaccel.resolve(prefer)` echoes the forced
   * backend (re-ranked so vaapi precedes qsv); the egress's per-stream software
   * fallback still catches a backend the actual ffmpeg build can't drive. Null
   * when no local resolver is wired.
   */
  private async resolveSpecificDecodeHwAccel(prefer: FfmpegHwAccelPrefer): Promise<string | null> {
    if (!this.hwaccel) return null
    try {
      const res = await this.hwaccel.resolve(prefer)
      const backend = rankDecodeHwAccels(res.preferred, [])[0] ?? null
      if (backend === null) return null
      // The node having the hardware and the BINARY being able to use it are
      // two different questions (D536), and only the first one was ever asked.
      // A binary without the backend compiled in fails with
      // `Device creation failed: -12 … Cannot allocate memory` — which READS
      // as a resource shortage and is a build property, so every child paid
      // ~3 s dying before its software retry, forever.
      const binaryPath = this.ffmpegConfig().binaryPath
      // No binary: nothing will be spawned to decode, so there is nothing to
      // gate — the spawn site refuses by name.
      const caps = binaryPath === null ? null : await this.resolveBinaryCapabilities(binaryPath)
      if (caps !== null && !caps.hwaccels.has(backend)) {
        this.logger.warn(
          'this ffmpeg has no such decode backend compiled in — decoding in software instead of dying on a device that cannot exist',
          {
            meta: {
              backend,
              ffmpeg: binaryPath,
              hwaccels: [...caps.hwaccels].join(',') || 'none',
            },
          },
        )
        return null
      }
      return backend
    } catch (err) {
      this.logger.warn('local decode hw-accel resolve failed — software decode fallback', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  private shareEntry(entry: PipelineEntry): PipelineEntry {
    entry.refcount += 1
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    return entry
  }

  /**
   * The SENTRY counterpart of a passthrough url, or `null`.
   *
   * `sentryEligible` is asked through the injected lookup — the broker manager
   * owns those facts — and an unwired lookup is a NO. A refusal is silent on
   * purpose: "this mains camera has no sentry" is the answer for most of the
   * fleet and logging it per acquire would be noise. A FAILED ask is not: it is
   * a question that could not be answered, and it is reported as such before
   * being resolved to `null`.
   */
  private async resolveSentryUrl(deviceId: number, url: string): Promise<string | null> {
    if (this.sentryOffered === null) return null
    try {
      if (!(await this.sentryOffered(deviceId))) return null
    } catch (error) {
      this.logger.warn('getStreamWithCodec: could not decide whether a sentry dial is offered', {
        tags: { deviceId },
        meta: { error: errMsg(error) },
      })
      return null
    }
    return withSentryIntent(url)
  }

  private async shareOrCreatePassthroughAsync(
    key: string,
    factory: () => Promise<RtpSource>,
  ): Promise<RtpSource> {
    const existing = this.entries.get(key)
    if (existing) {
      this.shareEntry(existing)
      return existing.source
    }
    return this.shareOrCreatePassthrough(key, await factory())
  }

  private shareOrCreatePassthrough(key: string, made: RtpSource): RtpSource {
    const existing = this.entries.get(key)
    if (existing) {
      this.shareEntry(existing)
      return existing.source
    }
    const source = made
    const entry: PipelineEntry = { key, source, egress: null, refcount: 1, releaseTimer: null }
    this.entries.set(key, entry)
    return source
  }

  private async shutdownEntry(entry: PipelineEntry): Promise<void> {
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    this.entries.delete(entry.key)
    if (entry.egress) {
      try {
        await entry.egress.stop()
      } catch (err) {
        this.logger.warn('transcode egress shutdown error', {
          meta: { key: entry.key, error: errMsg(err) },
        })
      }
    }
  }
}
