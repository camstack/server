import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  hydrateSchema,
  intercomCapability,
  motionCapability,
  hubMotionNativeProvider,
  providerMotionEvent,
  snapshotCapability,
  streamCatalogCapability,
} from '@camstack/types'
import type {
  CamStreamDescriptor,
  ConfigUISchemaWithValues,
  DeviceContext,
  ICameraDevice,
  InferNativeProvider,
  PinnedFfmpegResolver,
  StreamSourceEntry,
} from '@camstack/types'

/**
 * Local mirror of the `snapshot` cap's `SnapshotImage` shape (the schema
 * type is not re-exported from `@camstack/types`). Structural — the cap
 * dispatch is structural, not zod-identity, across the addon boundary.
 */
interface SnapshotImage {
  readonly base64: string
  readonly contentType: string
}
import type { WyzeCamera as WyzeCloudCamera } from '@apocaliss92/wyze-bridge-js'
import { WyzeCloudClient } from './cloud-client.js'
import {
  WYZE_ADDON_ID,
  WYZE_NATIVE_STREAM_ID,
  buildLazyRfc4571Url,
  buildSyntheticSdp,
} from './constants.js'
import { classifyCloudError } from './error-classifier.js'
import {
  bitrateFor,
  cameraConfigFromCloud,
  codecFromVideoType,
  frameSizeFor,
  latestThumbnailUrl,
} from './mapping.js'
import { keyframeToJpeg } from './snapshot-ffmpeg.js'
import { wyzeCameraSchema } from './schema.js'
import { WyzeStreamServerManager } from './wyze-stream-server.js'

/**
 * Resolver the addon injects so the camera can pull its cloud descriptor
 * (refreshed IP) + cloud events without holding a provider reference.
 */
export interface WyzeCameraDeps {
  /** Latest cloud camera blob for this camera's MAC (refreshed IP). */
  readonly resolveCloudCamera: () => Promise<WyzeCloudCamera | null>
  /** The shared cloud client (events API for cloud-motion + thumbnails). */
  readonly cloud: () => WyzeCloudClient | null
  /** The node's pinned ffmpeg (D540) for the live keyframe → JPEG. Rejects
   *  rather than naming PATH; the snapshot then says so and falls back to the
   *  cloud thumbnail. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
}

/**
 * A Wyze camera reached over the local P2P/DTLS protocol via the
 * `@apocaliss92/wyze-bridge-js` lib. Structural twin of `ReolinkCamera`:
 * a `pull-rfc4571` lazy-publish stream-catalog entry + a dial-time
 * `materializeStreamSocket` that opens the P2P session and re-publishes
 * the real loopback URL, plus snapshot / motion / (experimental) intercom.
 */
export class WyzeCamera extends BaseDevice<typeof wyzeCameraSchema> implements ICameraDevice {
  readonly type = DeviceType.Camera as const
  features = [DeviceFeature.NativeSnapshot] as readonly DeviceFeature[]

  private readonly streamManager: WyzeStreamServerManager
  private deps: WyzeCameraDeps | null = null
  private readonly publishedStreamIds = new Set<string>()
  private cloudMotionTimer: ReturnType<typeof setInterval> | null = null
  private lastMotionEventTs = 0
  /** Codec of the materialised stream — h264 until the lib reports H265. */
  private currentCodec: 'h264' | 'h265' = 'h264'

  constructor(ctx: DeviceContext) {
    super(ctx, wyzeCameraSchema, { type: DeviceType.Camera })
    this.streamManager = new WyzeStreamServerManager({
      logger: ctx.logger.child('stream'),
    })
    this.registerNativeCapabilities()
  }

  /** Wire the cloud resolvers (called by the provider after create/restore). */
  setDeps(deps: WyzeCameraDeps): void {
    this.deps = deps
  }

  // ── Native capabilities ────────────────────────────────────────────────

  private registerNativeCapabilities(): void {
    this.registerStreamCatalogProvider()
    this.registerSnapshotProvider()
    this.registerMotionProvider()
    this.registerIntercomProvider()
  }

  // ── Streaming (pull-rfc4571 lazy publish) ──────────────────────────────

  /**
   * The single native cam-stream descriptor. Lazy: carries the
   * `lazy:rfc4571:` sentinel URL + a synthetic SDP. The broker dials this
   * placeholder, emits `StreamBrokerOnRequestStreamSourceRefresh`, and the
   * provider responds by materialising the real loopback URL. We do NOT
   * open the P2P session here (keeps idle cameras un-connected).
   */
  buildStreamCatalog(): CamStreamDescriptor[] {
    return [
      {
        camStreamId: WYZE_NATIVE_STREAM_ID,
        kind: 'pull-rfc4571',
        url: buildLazyRfc4571Url(WYZE_NATIVE_STREAM_ID),
        codec: this.currentCodec,
        label: 'Wyze',
        autoEligible: true,
        deviceFeatures: [...this.features],
        metadata: { sdp: buildSyntheticSdp(this.currentCodec) },
      },
    ]
  }

  private registerStreamCatalogProvider(): void {
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.buildStreamCatalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
  }

  /**
   * Materialize the upstream rfc4571 streaming session on broker demand.
   * Opens / reuses the P2P server, then re-publishes the entry with the
   * real `tcp://127.0.0.1:<port>` URL + the lib's accurate SDP. Handles
   * BOTH H264 and H265 from `server.videoType`. Self-healing is owned by
   * the stream manager (`onServerClose` eviction).
   */
  async materializeStreamSocket(camStreamId: string): Promise<void> {
    if (camStreamId !== WYZE_NATIVE_STREAM_ID) return

    const camera = await this.resolveCamera()
    if (!camera) {
      this.ctx.logger.warn('materializeStreamSocket: no cloud descriptor resolvable', {
        tags: { deviceId: this.id },
      })
      return
    }

    const server = await this.streamManager.ensure({
      camera,
      frameSize: frameSizeFor(this.config.get('resolution')),
      bitrate: bitrateFor(this.config.get('bitrate')),
    })
    if (!server) {
      this.ctx.logger.warn('materializeStreamSocket: P2P server could not be opened', {
        tags: { deviceId: this.id, camStreamId },
      })
      return
    }

    const codec = codecFromVideoType(server.videoType)
    this.currentCodec = codec
    const url = `tcp://${server.host}:${server.port}`
    await this.publishOne({
      camStreamId,
      kind: 'pull-rfc4571',
      label: 'Wyze',
      url,
      codec,
      autoEligible: true,
      deviceFeatures: [...this.features],
      metadata: { sdp: server.sdp },
    })
    this.ctx.logger.info('materialized wyze rfc4571 stream socket on broker demand', {
      tags: { deviceId: this.id, camStreamId },
      meta: { url, videoType: server.videoType },
    })
  }

  private async publishOne(entry: CamStreamDescriptor): Promise<void> {
    try {
      await this.ctx.api.streamBroker.publishCameraStream.mutate({
        deviceId: this.id,
        camStreamId: entry.camStreamId,
        kind: entry.kind,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.resolution ? { resolution: entry.resolution } : {}),
        ...(entry.fps !== undefined ? { fps: entry.fps } : {}),
        ...(entry.codec !== undefined ? { codec: entry.codec } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
        deviceFeatures: entry.deviceFeatures ?? [...this.features],
        autoEligible: entry.autoEligible ?? true,
      })
      this.publishedStreamIds.add(entry.camStreamId)
    } catch (err) {
      this.ctx.logger.warn('publishCameraStream failed', {
        tags: { deviceId: this.id, camStreamId: entry.camStreamId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // ── Snapshot (native snapshot cap) ─────────────────────────────────────
  //
  // Prefer `grabKeyframe` off a LIVE P2P session → ffmpeg → JPEG. When no
  // session is open, fall back to the newest cloud-event thumbnail so a
  // sleeping camera still has a device image without waking it.

  private registerSnapshotProvider(): void {
    const provider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => {
        if (deviceId !== this.id) return null
        return this.captureSnapshot()
      },
      invalidateCache: async () => {
        /* the snapshot orchestrator owns the cache */
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, provider)
  }

  private async captureSnapshot(): Promise<SnapshotImage | null> {
    const server = this.streamManager.current
    const ffmpegPath = server ? await this.pinnedFfmpegForSnapshot() : null
    if (server && ffmpegPath !== null) {
      try {
        const annexB = await server.connection.grabKeyframe(8000)
        const jpeg = await keyframeToJpeg(annexB, { videoType: server.videoType, ffmpegPath })
        return { base64: jpeg.toString('base64'), contentType: 'image/jpeg' }
      } catch (err) {
        this.ctx.logger.debug('snapshot: live keyframe grab failed — trying cloud thumbnail', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    return this.cloudThumbnailSnapshot()
  }

  /**
   * The pinned ffmpeg, or `null` after a line naming why there is none — the
   * snapshot then takes the cloud thumbnail. Never a PATH `ffmpeg` (D540).
   */
  private async pinnedFfmpegForSnapshot(): Promise<string | null> {
    const deps = this.deps
    if (deps === null) {
      this.ctx.logger.warn('snapshot: live grab skipped — camera not wired to its addon yet', {
        tags: { deviceId: this.id },
      })
      return null
    }
    try {
      return await deps.resolveFfmpeg()
    } catch (err) {
      this.ctx.logger.error(
        'snapshot: live grab refused — no pinned ffmpeg on this node (D540); trying cloud thumbnail',
        {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      return null
    }
  }

  private async cloudThumbnailSnapshot(): Promise<SnapshotImage | null> {
    const cloud = this.deps?.cloud() ?? null
    if (!cloud) return null
    try {
      const events = await cloud.getEventList({ macs: [this.config.get('mac')], count: 10 })
      const url = latestThumbnailUrl(events, this.config.get('mac'))
      if (!url) return null
      const res = await fetch(url)
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return null
      return { base64: buf.toString('base64'), contentType: 'image/jpeg' }
    } catch (err) {
      this.ctx.logger.debug('snapshot: cloud thumbnail fetch failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  // ── Motion (cloud events poll default; boa optional) ───────────────────

  /**
   * The native `motion` cap. This provider writes NO `motion` slice (D696): the
   * orchestrator is its only writer, with the EFFECTIVE motion, on the hub.
   * `isDetected` and `getStatus` answer from the HUB's slice
   * (`hubMotionNativeProvider`); an unreadable hub fails both — never `false`
   * for unknown (D49, D393).
   */
  private registerMotionProvider(): void {
    const provider = hubMotionNativeProvider(this.ctx.api.deviceState, this.id, 'WyzeCamera')
    this.ctx.registerNativeCap(motionCapability, provider)
  }

  /**
   * Start the configured motion source. `cloud` polls the Wyze events API
   * (works while the camera sleeps); `boa` reads the on-camera SD-card
   * poller — only available while a P2P session is open, so it is wired
   * lazily when a stream materialises (out of scope for the poll loop).
   */
  private startMotionPolling(): void {
    if (this.config.get('motionSource') !== 'cloud') return
    if (this.cloudMotionTimer) return
    const POLL_MS = 15_000
    this.cloudMotionTimer = setInterval(() => {
      void this.pollCloudMotion()
    }, POLL_MS)
  }

  private async pollCloudMotion(): Promise<void> {
    const cloud = this.deps?.cloud() ?? null
    if (!cloud) return
    const mac = this.config.get('mac')
    try {
      const events = await cloud.getEventList({ macs: [mac], count: 10 })
      let newest: { timestamp: number; aiTags: readonly string[] } | null = null
      for (const ev of events) {
        if (ev.deviceMac !== mac || ev.alarmType !== 'motion') continue
        if (newest === null || ev.timestamp > newest.timestamp) {
          newest = { timestamp: ev.timestamp, aiTags: ev.aiTags }
        }
      }
      if (!newest || newest.timestamp <= this.lastMotionEventTs) return
      this.lastMotionEventTs = newest.timestamp
      this.emitMotion(newest.timestamp)
    } catch (err) {
      this.ctx.logger.debug('motion: cloud event poll failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Emit the camera's RAW motion push as `ProviderMotion`
   * (`source: 'onboard'`, D673). The orchestrator's camera-sensors bridge
   * re-emits it as the effective `MotionOnMotionChanged`, and the
   * orchestrator is the only writer of the camera's `motion` runtime-state
   * slice (D696) — symmetric with the Reolink onboard-motion path.
   */
  private emitMotion(timestamp: number): void {
    this.ctx.eventBus.emit(
      providerMotionEvent(
        { type: 'device', id: this.id, addonId: WYZE_ADDON_ID, deviceId: this.id },
        { deviceId: this.id, detected: true, timestamp, source: 'onboard' },
      ),
    )
  }

  // ── Intercom (two-way audio — EXPERIMENTAL, gated) ─────────────────────
  //
  // Gated on `hasTwoWayStreaming` at session-open time. The backchannel
  // DTLS server in the lib is hand-rolled / unvalidated — best-effort.

  private intercomActive = false
  private intercomSeq = -1

  private registerIntercomProvider(): void {
    const provider: InferNativeProvider<typeof intercomCapability> = {
      startSession: async () => {
        throw new Error('Wyze intercom: WebRTC talk session not supported — use startTalkSession')
      },
      handleAnswer: async () => {
        throw new Error('Wyze intercom: WebRTC talk session not supported')
      },
      stopSession: async () => {
        await this.endTalk()
      },
      startTalkSession: async ({ deviceId }) => {
        if (deviceId !== this.id) throw new Error('Wyze intercom: device mismatch')
        return this.startTalk()
      },
      pushTalkAudio: async ({ deviceId, audioBase64, sampleRate, channels, sequenceNumber }) => {
        if (deviceId !== this.id) return { accepted: false }
        return this.pushTalk(audioBase64, sampleRate, channels, sequenceNumber)
      },
      endTalkSession: async ({ deviceId }) => {
        if (deviceId !== this.id) return
        await this.endTalk()
      },
    }
    this.ctx.registerNativeCap(intercomCapability, provider)
  }

  private async startTalk(): Promise<{ sessionId: string }> {
    const server = this.streamManager.current
    if (!server) {
      throw new Error('Wyze intercom: no active stream — open a live stream before talking')
    }
    if (!server.connection.hasTwoWayStreaming) {
      throw new Error('Wyze intercom: camera does not advertise two-way audio')
    }
    await server.connection.startIntercom()
    this.intercomActive = true
    this.intercomSeq = -1
    return { sessionId: `wyze-talk-${this.id}` }
  }

  private async pushTalk(
    audioBase64: string,
    sampleRate: number | undefined,
    channels: number | undefined,
    sequenceNumber: number,
  ): Promise<{ accepted: boolean }> {
    const server = this.streamManager.current
    if (!this.intercomActive || !server) return { accepted: false }
    // Drop out-of-order frames so the camera-side codec state stays clean.
    if (sequenceNumber <= this.intercomSeq) return { accepted: false }
    this.intercomSeq = sequenceNumber
    const payload = Buffer.from(audioBase64, 'base64')
    const backchannel = server.connection.getBackchannelCodec()
    try {
      server.connection.writeAudio(
        backchannel.codec,
        payload,
        Date.now() * 1000,
        sampleRate ?? backchannel.sampleRate,
        channels ?? backchannel.channels,
      )
      return { accepted: true }
    } catch (err) {
      this.ctx.logger.debug('intercom: writeAudio failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return { accepted: false }
    }
  }

  private async endTalk(): Promise<void> {
    const server = this.streamManager.current
    if (server && this.intercomActive) {
      try {
        server.connection.stopIntercom()
      } catch {
        /* best-effort */
      }
    }
    this.intercomActive = false
    this.intercomSeq = -1
  }

  // ── Cloud descriptor resolution ────────────────────────────────────────

  /**
   * Resolve the cloud `WyzeCamera` blob for this MAC, preferring the
   * provider-injected resolver (refreshed IP). Falls back to a descriptor
   * synthesised from the persisted config when the cloud is unreachable.
   */
  private async resolveCamera(): Promise<WyzeCloudCamera | null> {
    if (this.deps) {
      try {
        const fromCloud = await this.deps.resolveCloudCamera()
        if (fromCloud) {
          // Persist a refreshed IP so the next cold boot has the latest.
          if (fromCloud.ip && fromCloud.ip !== this.config.get('ip')) {
            void this.config.setAll({ ip: fromCloud.ip }).catch(() => {
              /* best-effort persist */
            })
          }
          return fromCloud
        }
      } catch (err) {
        const classified = classifyCloudError(err)
        this.ctx.logger.warn('resolveCamera: cloud refresh failed — using persisted config', {
          tags: { deviceId: this.id },
          meta: { kind: classified.kind, error: classified.message },
        })
      }
    }
    return this.cameraFromConfig()
  }

  /** Build a `WyzeCamera` descriptor from the persisted device config. */
  private cameraFromConfig(): WyzeCloudCamera | null {
    const mac = this.config.get('mac')
    const p2pId = this.config.get('p2pId')
    const enr = this.config.get('enr')
    const ip = this.config.get('ip')
    const productModel = this.config.get('productModel')
    if (!mac || !p2pId || !enr || !ip || !productModel) return null
    return {
      mac,
      p2pId,
      enr,
      ip,
      productModel,
      nickname: this.name,
      productType: 'Camera',
      dtls: this.config.get('dtls'),
      firmwareVer: this.config.get('firmwareVer'),
      isOnline: true,
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  override async onActivate(): Promise<void> {
    this.startMotionPolling()
  }

  override async removeDevice(): Promise<void> {
    this.ctx.logger.info('Removing Wyze camera', { meta: { stableId: this.stableId } })
    if (this.cloudMotionTimer) {
      clearInterval(this.cloudMotionTimer)
      this.cloudMotionTimer = null
    }
    await this.endTalk()
    // Close-first: tear down the P2P session BEFORE retracting streams.
    await this.streamManager.close('removeDevice')
    const ids = [...this.publishedStreamIds]
    await Promise.all(
      ids.map((id) =>
        this.ctx.api.streamBroker.retractCameraStream
          .mutate({ deviceId: this.id, camStreamId: id })
          .catch((err: unknown) => {
            this.ctx.logger.debug('retractCameraStream failed', {
              tags: { deviceId: this.id, camStreamId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          }),
      ),
    )
    this.publishedStreamIds.clear()
  }

  // ── ICameraDevice compat shim ──────────────────────────────────────────

  async getStreamSources(): Promise<readonly StreamSourceEntry[]> {
    return [
      {
        id: WYZE_NATIVE_STREAM_ID,
        label: 'Wyze',
        protocol: 'custom' as const,
      },
    ]
  }

  // ── Settings UI ─────────────────────────────────────────────────────────

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    return hydrateSchema(
      {
        sections: [
          {
            id: 'stream',
            title: 'Stream',
            titleKey: 'provider-wyze:settingsUI.s_stream.title',
            columns: 2,
            fields: [
              {
                type: 'select',
                key: 'resolution',
                label: 'Resolution',
                labelKey: 'provider-wyze:settingsUI.s_stream.resolution.label',
                options: [
                  {
                    value: 'fhd',
                    label: '1080p (FHD)',
                    labelKey: 'provider-wyze:settingsUI.s_stream.resolution.o_fhd.label',
                  },
                  {
                    value: 'hd',
                    label: '720p (HD)',
                    labelKey: 'provider-wyze:settingsUI.s_stream.resolution.o_hd.label',
                  },
                  {
                    value: 'qhd',
                    label: '2K (QHD)',
                    labelKey: 'provider-wyze:settingsUI.s_stream.resolution.o_qhd.label',
                  },
                  {
                    value: 'low',
                    label: '360p (SD)',
                    labelKey: 'provider-wyze:settingsUI.s_stream.resolution.o_low.label',
                  },
                ],
              },
              {
                type: 'select',
                key: 'bitrate',
                label: 'Bitrate',
                labelKey: 'provider-wyze:settingsUI.s_stream.bitrate.label',
                options: [
                  {
                    value: 'max',
                    label: 'Max',
                    labelKey: 'provider-wyze:settingsUI.s_stream.bitrate.o_max.label',
                  },
                  {
                    value: 'sd',
                    label: 'SD',
                    labelKey: 'provider-wyze:settingsUI.s_stream.bitrate.o_sd.label',
                  },
                ],
              },
              {
                type: 'select',
                key: 'motionSource',
                label: 'Motion source',
                labelKey: 'provider-wyze:settingsUI.s_stream.motionSource.label',
                options: [
                  {
                    value: 'cloud',
                    label: 'Cloud events',
                    labelKey: 'provider-wyze:settingsUI.s_stream.motionSource.o_cloud.label',
                  },
                  {
                    value: 'boa',
                    label: 'On-camera (boa)',
                    labelKey: 'provider-wyze:settingsUI.s_stream.motionSource.o_boa.label',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        resolution: this.config.get('resolution'),
        bitrate: this.config.get('bitrate'),
        motionSource: this.config.get('motionSource'),
      },
    )
  }

  static fromCloud = cameraConfigFromCloud
}
