/**
 * `RemoteEncodedSourceBroker` — the WebRTC ENCODED-source leg's RTP/encoded
 * analogue of `RemoteSourcePlane` (cross-node Phase 2, restream-owner design
 * §2.4). Used when a camera's WebRTC session lands on a node that is NOT the
 * camera's source-owner: instead of subscribing to a co-located `StreamBroker`
 * (which does not exist here), this class:
 *
 *  1. **Acquires the owner's COMPRESSED passthrough restream** via the
 *     hub-singleton cap `streamBroker.getStreamWithCodec({ video: 'copy',
 *     audio: 'none', profile, hostname })` — refcounted, rides the owner's
 *     SINGLE on-demand camera pull (the double-pull guard). The `profile` is
 *     resolved from the camStream id via the broker's profile slots
 *     ({@link profileForStreamId}, shared with `RemoteSourcePlane`).
 *  2. **Drives a REAL `StreamBroker`** pointed at the acquired restream URL —
 *     zero new RTP/H.265 code. This leg hands the URL straight to an
 *     `IStreamBroker` so WebRTC's existing encoded-subscriber /
 *     source-RTP paths (`onEncodedData`, `onVideoRtp`, H.265 repacketizer)
 *     work unchanged against a local broker instance.
 *
 * `setSourceProvider` is SYNCHRONOUS while `getStreamWithCodec` is async — the
 * acquire MUST resolve and the `{type:'rtsp', url}` `StreamSource` MUST be
 * cached BEFORE the inner broker's `sourceProvider` closure can be invoked.
 * `getBroker()` does exactly that: resolve → construct+start the inner broker
 * with a closure that always returns the already-resolved source → return it.
 *
 * Teardown: `dispose()` stops the inner broker and releases the hub restream
 * refcount (`releaseStreamWithCodec`). Release failures are benign (a hub
 * restart force-resets the in-memory refcounts). A later `getBroker()` after
 * dispose re-acquires from scratch — restream URLs/tokens are NEVER cached
 * across teardowns.
 */
import type {
  AddonApi,
  CamProfile,
  IScopedLogger,
  IStreamBroker,
  StreamSource,
} from '@camstack/types'
import { errMsg, nodePin } from '@camstack/types'

import { profileForStreamId } from '../../pipeline-runner/remote-restream.js'

/** Deps handed to the injected `StreamBroker` factory — mirrors the ctor args this leg actually needs. */
export interface RemoteEncodedBrokerDeps {
  readonly brokerId: string
  readonly logger: IScopedLogger
}

/**
 * `IStreamBroker` plus `setSourceProvider`/`onDemandChange` — the concrete
 * `StreamBroker` class exposes both (a manager-owned source closure and a
 * demand-transition observer) but neither is part of the `IStreamBroker`
 * interface. This leg calls `setSourceProvider`; callers that register the
 * acquired broker with the WebRTC server (Slice 3 Task 3 —
 * `StreamBrokerManager.ensureBrokerForWebrtcSession`) call `onDemandChange`
 * to tear the adapter down on its last-session-idle edge, mirroring
 * `attachDerivedFeeder`'s local-broker teardown hook. So the factory +
 * stored broker field are typed against this narrower extension instead of
 * casting.
 */
export interface IStreamBrokerWithSourceProvider extends IStreamBroker {
  setSourceProvider(provider: () => StreamSource | null): void
  /**
   * Observe demand transitions. Fires `true` when the broker first gains
   * demand and `false` when it suspends after the idle grace. Signature
   * copied verbatim from the concrete `StreamBroker.onDemandChange`.
   */
  onDemandChange(observer: (active: boolean) => void): () => void
}

/**
 * Constructs the inner `IStreamBroker`. Injected so tests substitute a fake
 * broker double and assert `setSourceProvider`/`start`/`stop` calls without a
 * real RTSP dial. Production callers pass a closure wrapping
 * `new StreamBroker(deps.brokerId, deps.logger, null)` — this leg never
 * decodes audio, so the audio-codec cap is unused.
 */
export type CreateStreamBroker = (deps: RemoteEncodedBrokerDeps) => IStreamBrokerWithSourceProvider

export interface RemoteEncodedSourceBrokerOptions {
  readonly api: AddonApi
  readonly logger: IScopedLogger
  /** The camera this broker sources. */
  readonly deviceId: number
  /** The camStream id this leg feeds (resolved to a broker profile via `listAllProfileSlots`). */
  readonly streamId: string
  /**
   * The camera-source OWNER node — the node whose broker dials the camera and
   * serves the restream. Every `streamBroker` cap call is `nodePin`-ed to it so
   * the singleton resolves to the actual owner, not the hub.
   */
  readonly ownerNodeId: string
  /**
   * The owner host to dial (already resolved: attach-payload override →
   * `CAMSTACK_HUB_URL`). `undefined` = unresolvable → every acquire fails
   * fast with a descriptive error (a `127.0.0.1` restream URL on a remote
   * node would dial the wrong box).
   */
  readonly reachableHost: string | undefined
  readonly createBroker: CreateStreamBroker
}

/** One acquired restream + the inner broker driving it. */
interface AcquiredEntry {
  readonly broker: IStreamBrokerWithSourceProvider
  readonly pipelineKey: string
}

export class RemoteEncodedSourceBroker {
  private readonly api: AddonApi
  private readonly logger: IScopedLogger
  private readonly deviceId: number
  private readonly streamId: string
  private readonly ownerNodeId: string
  private readonly hostname: string | undefined
  private readonly createBroker: CreateStreamBroker
  /** Single-flight acquire. */
  private pending: Promise<AcquiredEntry> | null = null
  private disposed = false

  constructor(options: RemoteEncodedSourceBrokerOptions) {
    this.api = options.api
    this.logger = options.logger.withTags({
      deviceId: options.deviceId,
      streamId: options.streamId,
    })
    this.deviceId = options.deviceId
    this.streamId = options.streamId
    this.ownerNodeId = options.ownerNodeId
    this.hostname = options.reachableHost
    this.createBroker = options.createBroker
  }

  /**
   * Single-flight: acquire the owner restream + construct/start the inner
   * broker once, sharing the same instance across concurrent callers. A
   * rejected acquire is retryable — the next `getBroker()` re-attempts from
   * scratch (fresh URL/token).
   */
  async getBroker(): Promise<IStreamBrokerWithSourceProvider> {
    if (this.disposed) {
      throw new Error('RemoteEncodedSourceBroker: getBroker after dispose')
    }
    if (!this.pending) {
      const creation = this.createEntry()
      this.pending = creation
      creation.catch(() => {
        if (this.pending === creation) this.pending = null
      })
    }
    const entry = await this.pending
    return entry.broker
  }

  /** Stop the inner broker and release the acquired restream once. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    this.pending = null
    if (!pending) return
    let entry: AcquiredEntry
    try {
      entry = await pending
    } catch {
      // Acquisition had already failed — nothing to tear down.
      return
    }
    await entry.broker.stop().catch((err: unknown) => {
      this.logger.warn('remote-encoded source broker: inner broker stop failed', {
        meta: { streamId: this.streamId, error: errMsg(err) },
      })
    })
    await this.api.streamBroker.releaseStreamWithCodec
      .mutate({ pipelineKey: entry.pipelineKey }, nodePin(this.ownerNodeId))
      .catch((err: unknown) => {
        // Benign after a hub restart (in-memory refcounts were force-reset).
        this.logger.debug(
          'remote-encoded source broker: releaseStreamWithCodec failed (benign on hub restart)',
          {
            meta: { streamId: this.streamId, pipelineKey: entry.pipelineKey, error: errMsg(err) },
          },
        )
      })
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async createEntry(): Promise<AcquiredEntry> {
    const { api, deviceId, streamId, ownerNodeId } = this
    if (this.hostname === undefined) {
      throw new Error(
        'RemoteEncodedSourceBroker: owner hostname unresolvable — set frameSource.hubHostnameOverride or CAMSTACK_HUB_URL (a 127.0.0.1 restream URL would dial the wrong box)',
      )
    }

    // Resolve WHICH profile this camStream feeds — getStreamWithCodec targets
    // profiles, WebRTC is dispatched with camStream ids.
    const slots = await api.streamBroker.listAllProfileSlots.query(undefined, nodePin(ownerNodeId))
    const profile: CamProfile | null = profileForStreamId(slots, deviceId, streamId)
    if (profile === null) {
      throw new Error(
        `RemoteEncodedSourceBroker: no broker profile is fed by camStream '${streamId}' of device ${deviceId} — cannot acquire the owner restream`,
      )
    }

    // Acquire the owner's compressed restream (refcounted; NEVER a second
    // camera pull). `video:'copy'` = passthrough, near-zero owner cost.
    const rtpSource = await api.streamBroker.getStreamWithCodec.mutate(
      {
        deviceId,
        video: 'copy',
        audio: 'none',
        profile,
        hostname: this.hostname,
        tag: `webrtc:remote-encoded:${deviceId}/${streamId}`,
      },
      nodePin(ownerNodeId),
    )

    // Cache the resolved source BEFORE constructing the inner broker —
    // `setSourceProvider` is synchronous, so the closure must never await.
    const source: StreamSource = {
      type: 'rtsp',
      url: rtpSource.url,
      videoCodec: rtpSource.videoCodec,
    }

    const brokerId = `${deviceId}/${profile}`
    const broker = this.createBroker({
      brokerId,
      logger: this.logger.child(profile),
    })
    broker.setSourceProvider(() => source)
    await broker.start(source)

    this.logger.info('remote-encoded source broker: owner restream acquired', {
      meta: {
        streamId,
        profile,
        codec: rtpSource.videoCodec,
        pipelineKey: rtpSource.pipelineKey,
        hostname: this.hostname,
      },
    })

    return { broker, pipelineKey: rtpSource.pipelineKey }
  }
}
