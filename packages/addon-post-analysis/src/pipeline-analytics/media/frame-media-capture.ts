/**
 * Frame media capture — the park orders (D422), the native keyFrame persist
 * and its late preview redeem (D276), the live hierarchy fill and the
 * offline-node capture gate (D58). Moved out of `pipeline-analytics/index.ts`
 * verbatim (Plan B, extraction 2): only the visibility of the entry points
 * changed. Every dependency is read through the deps object — getters for
 * what the addon opens in `onInitialize`.
 */
import { ensureTrackHierarchyMedia, type LiveHierarchyCapture } from '../ensure-track-hierarchy.js'
import type { DisplayCropFn } from '../pipeline/display-crop.js'
import { deriveKeyFrameSmall, type KeyFrameSelection } from '../pipeline/key-frame-capture.js'
import type { KeyFrameCaptureLog } from '../pipeline/key-frame-metrics.js'
import { persistTrackKeyFrame } from '../pipeline/key-frame-persist.js'
import { KEY_FRAME_RETRY_PRIORITY } from '../pipeline/key-frame-retry.js'
import {
  type PendingPreviewUpgrades,
  type PreviewUpgradeDerived,
  type PreviewUpgradeDeriveInput,
  runPreviewUpgrade,
} from '../pipeline/preview-upgrade.js'
import { buildParkOrders, type ParkDecision } from '../pipeline/track-park.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import { captureCoalesceKey, type CaptureScheduler } from '../runtime/capture-scheduler.js'
import type { NodeLivenessMirror } from '../runtime/node-liveness.js'
import type { ParkedFrameClient } from '../runtime/parked-frame-client.js'
import type { ParkedSubjectSlab } from '../services/event-media-dispatcher.js'
import type { MediaStore } from '../store/media-store.js'
import type { TrackStore } from '../store/track-store.js'
import { type AddonContext, errMsg, type ParkedFrameKind } from '@camstack/types'
import type { FrameState } from '../frame/frame-state.js'
import { ENRICHMENT_CAPTURE_STALE_MS } from './capture-timing.js'

/** `keyFrameThumbnailDerive`: the keyFrame → thumbnail derive the redeem runs. */
export type KeyFrameThumbnailDerive = (
  input: PreviewUpgradeDeriveInput,
) => Promise<PreviewUpgradeDerived | null>

/** What the capture reads from the addon. */
export interface FrameMediaCaptureDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly ctxIfReady: () => AddonContext | null
  readonly shuttingDown: () => boolean
  readonly frameState: FrameState
  readonly residents: TrackResidentState
  readonly keyFrameCaptureLog: KeyFrameCaptureLog
  readonly nodeLiveness: NodeLivenessMirror
  readonly pendingPreviewUpgrades: PendingPreviewUpgrades
  readonly captureScheduler: () => CaptureScheduler
  readonly keyFrameThumbnailDerive: () => KeyFrameThumbnailDerive
  readonly parkedFrames: () => ParkedFrameClient | null
  readonly mediaStore: () => MediaStore | null
  readonly trackStore: () => TrackStore | null
  readonly captureDisplayCropFn: () => DisplayCropFn | null
}

export class FrameMediaCapture {
  constructor(private readonly deps: FrameMediaCaptureDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get ctxIfReady(): AddonContext | null {
    return this.deps.ctxIfReady()
  }

  private get shuttingDown(): boolean {
    return this.deps.shuttingDown()
  }

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  private get residents(): TrackResidentState {
    return this.deps.residents
  }

  private get keyFrameCaptureLog(): KeyFrameCaptureLog {
    return this.deps.keyFrameCaptureLog
  }

  private get nodeLiveness(): NodeLivenessMirror {
    return this.deps.nodeLiveness
  }

  private get pendingPreviewUpgrades(): PendingPreviewUpgrades {
    return this.deps.pendingPreviewUpgrades
  }

  private get captureScheduler(): CaptureScheduler {
    return this.deps.captureScheduler()
  }

  private get keyFrameThumbnailDerive(): KeyFrameThumbnailDerive {
    return this.deps.keyFrameThumbnailDerive()
  }

  private get parkedFrames(): ParkedFrameClient | null {
    return this.deps.parkedFrames()
  }

  private get mediaStore(): MediaStore | null {
    return this.deps.mediaStore()
  }

  private get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  private get captureDisplayCropFn(): DisplayCropFn | null {
    return this.deps.captureDisplayCropFn()
  }

  /**
   * The device's captures are being SKIPPED because the node that owns their
   * frames is offline in the cluster registry. Logged on the TRANSITION — a
   * live camera would otherwise produce ~10 lines/s — while the running count
   * goes into the per-device key-frame window, so both "when did it start" and
   * "how much is it costing" stay answerable.
   */
  noteCapturesGated(deviceId: number, nodeId: string): void {
    this.keyFrameCaptureLog.note(deviceId, { kind: 'skipped', reason: 'node-offline' }, Date.now())
    if (this.frameState.gatedNodeByDevice.get(deviceId) === nodeId) return
    this.frameState.gatedNodeByDevice.set(deviceId, nodeId)
    // A branch that DROPS work logs it. The 2026-08-06 investigation had to
    // read this node id out of an exception that was swallowed at `debug`.
    this.ctx.logger.warn(
      'media capture SKIPPED — the node owning this frame handle is offline in the cluster registry',
      { tags: { deviceId }, meta: { nodeId } },
    )
  }

  /** Captures for this device are routable again — log the recovery once. */
  clearCaptureGate(deviceId: number): void {
    const gated = this.frameState.gatedNodeByDevice.get(deviceId)
    if (gated === undefined || gated === null) return
    this.frameState.gatedNodeByDevice.set(deviceId, null)
    this.ctx.logger.info('media capture resumed — the frame handle owner is online again', {
      tags: { deviceId },
      meta: { nodeId: gated },
    })
  }

  /**
   * Order the parcels a best-frame decision wants (D422). Skipped entirely at
   * a node the registry already called offline (D58) — logged on the
   * transition by `noteCapturesGated`, counted in the key-frame window.
   * `onlyIfMissing` is the retry rule: a later frame may fill a kind that has
   * no parcel, never replace one the ranking preferred.
   */
  issueParkOrders(
    decision: ParkDecision,
    kinds: readonly ParkedFrameKind[],
    onlyIfMissing: boolean,
  ): void {
    const client = this.parkedFrames
    if (client === null) return
    if (this.nodeLiveness.isKnownOffline(decision.frameHandle.nodeId, Date.now())) {
      this.noteCapturesGated(decision.deviceId, decision.frameHandle.nodeId)
      return
    }
    for (const order of buildParkOrders(decision)) {
      if (!kinds.includes(order.kind)) continue
      if (onlyIfMissing && client.info(order.trackId, order.kind) !== undefined) continue
      void client.park(order)
    }
  }

  /** A parcel by track, after any park in flight for it has landed. */
  async fetchParkedParcel(
    trackId: string,
    kind: ParkedFrameKind,
  ): Promise<Awaited<ReturnType<ParkedFrameClient['fetch']>>> {
    const client = this.parkedFrames
    if (client === null) return null
    await client.awaitPark(trackId, kind)
    return client.fetch(trackId, kind)
  }

  /** The best-shot slab for the dispatcher: the parcel plus the layout the hub kept. */
  async fetchParkedSubjectSlab(
    _deviceId: number,
    trackId: string,
  ): Promise<ParkedSubjectSlab | null> {
    const parcel = await this.fetchParkedParcel(trackId, 'thumbnail')
    if (parcel === null || parcel.info.layout === undefined) return null
    return { slab: parcel.jpeg, layout: parcel.info.layout, timestamp: parcel.timestamp }
  }

  /**
   * Store each given track's clean native `keyFrame` + `keyFrameSmall` from its
   * PARKED parcel (D422) — never a by-handle fetch. The body is
   * `pipeline/key-frame-persist.ts`; what stays here is the scheduling
   * (coalescing, priority, budget) and the bookkeeping the retry gate reads.
   * Best-effort (D8): a per-track failure is logged and never thrown.
   */
  async persistKeyFrames(
    deviceId: number,
    timestamp: number,
    captures: readonly KeyFrameSelection[],
  ): Promise<void> {
    const mediaStore = this.mediaStore
    if (this.parkedFrames === null || !mediaStore) return
    // RC-1 → S3: the keyFrame in-flight gate is the scheduler's coalesceKey —
    // a re-fire for a track whose native keyFrame capture is still
    // queued/running JOINS the existing request (same promise, no second
    // exec), exactly the old "skip while in flight". So a burst of new-best
    // frames — or of catch-up retry frames — still issues at most ONE native
    // capture per track; the deterministic-id `putReplacing` already collapses
    // rows, and coalescing here also stops the wasted native round-trips +
    // encodes that starved the lease. The per-device budget additionally
    // bounds how many keyFrame captures run at once (the ring-stampede owner,
    // A7).
    await Promise.all(
      captures.map((capture) =>
        this.captureScheduler
          .request({
            deviceId,
            trackId: capture.trackId,
            kind: 'keyFrame',
            // A RETRY is catch-up work on an already-saturated hub: it ranks
            // BELOW the tier-1 new-best keyFrame and below the thumbnail, so
            // it can only ever claim a lane slot the live ladder did not want.
            ...(capture.retry ? { priority: KEY_FRAME_RETRY_PRIORITY } : {}),
            coalesceKey: captureCoalesceKey(deviceId, 'keyFrame', capture.trackId),
            exec: async () => {
              // Charged HERE, not where the target was built: a re-fire that
              // coalesced onto an in-flight capture runs no exec and must not
              // spend one of the track's three retries.
              //
              // Stamped with the FRAME timestamp, not the wall clock: the
              // min-gap is compared against `buildSnapshotTargets`' `timestamp`
              // (the same clock `setLastFrameAt` uses). Two clocks here would
              // make the gap 0 or infinite depending on frame lag.
              this.residents.noteKeyFrameAttempt(
                deviceId,
                capture.trackId,
                timestamp,
                capture.retry,
              )
              // Read BEFORE the first await: a running exec outlives
              // `onShutdown` (`clear()` only drops QUEUED requests), and the
              // `ctx` getter throws once the addon is torn down.
              const execLogger = this.ctx.logger
              const outcome = await persistTrackKeyFrame(
                {
                  fetchParkedKeyFrame: async (parcelDeviceId, trackId) => {
                    const parcel = await this.fetchParkedParcel(trackId, 'keyFrame')
                    if (parcel === null || parcel.info.deviceId !== parcelDeviceId) return null
                    // The park's mirror already holds the subject's box in
                    // DETECTION space for this exact frame (D422); handing it
                    // on is what lets the media row carry it (D510). Flattened
                    // here — the store's shape is one rectangle plus the frame
                    // it was measured on, never a nested sub-object.
                    const subject = parcel.info.subject
                    return {
                      jpeg: parcel.jpeg,
                      width: parcel.width,
                      height: parcel.height,
                      timestamp: parcel.timestamp,
                      nodeId: parcel.info.nodeId,
                      subject: {
                        x: subject.bbox.x,
                        y: subject.bbox.y,
                        w: subject.bbox.w,
                        h: subject.bbox.h,
                        frameWidth: subject.frameWidth,
                        frameHeight: subject.frameHeight,
                      },
                    }
                  },
                  deriveSmall: deriveKeyFrameSmall,
                  media: mediaStore,
                  logger: this.ctx.logger,
                },
                { deviceId, trackId: capture.trackId, retry: capture.retry },
              )
              if (this.shuttingDown) {
                // The capture settled across the teardown: the residents, the
                // track store and `ctx` are gone, so none of the bookkeeping
                // below can run. Said, not swallowed (a drop is logged).
                execLogger.info('key-frame capture settled after shutdown — bookkeeping skipped', {
                  tags: { deviceId },
                  meta: { trackId: capture.trackId, outcome: outcome.kind },
                })
                return
              }
              if (outcome.kind === 'landed') {
                this.residents.setKeyFrameMediaId(
                  deviceId,
                  capture.trackId,
                  outcome.keyFrameMediaId,
                )
                // Ends the retry path for this track. Set ONLY on a real
                // `putReplacing` — a flag set on dispatch would reproduce the
                // defect this whole change exists to fix.
                this.residents.markKeyFrameLanded(deviceId, capture.trackId)
                // D276: this exec can outlive the track's close (the queued
                // capture that lands 8 s late is the 413c69ff case). If the
                // close left a below-native tile, THIS keyFrame redeems it.
                void this.redeemPendingPreview(
                  deviceId,
                  capture.trackId,
                  outcome.keyFrameMediaId,
                  timestamp,
                )
              } else {
                // D276/B2: the close-time miss reason names the LAST failure —
                // `keyframe:parcel-missing` is the refused-park signature,
                // distinct from the scheduler's `keyframe:stale`/`keyframe:overflow`.
                this.residents.notePreviewCaptureMiss(
                  deviceId,
                  capture.trackId,
                  `keyframe:${outcome.kind}`,
                )
              }
              const window = this.keyFrameCaptureLog.note(
                deviceId,
                {
                  kind: 'attempt',
                  retry: capture.retry,
                  outcome: outcome.kind,
                },
                Date.now(),
              )
              if (window !== null) {
                this.ctx.logger.info('key-frame capture (window)', {
                  tags: { deviceId },
                  meta: {
                    windowSec: Math.round(window.windowMs / 1000),
                    ...window,
                  },
                })
              }
            },
          })
          .catch(() => {
            /* exec catches its own errors; defensive for scheduler rejections */
          }),
      ),
    )
  }

  /**
   * D276: a keyFrame landed for a track the close path left with a
   * below-native tile (or none). Redeem the pending upgrade — derive the
   * best-seen subject window from THIS keyFrame, replace the stand-in, clear
   * the persisted miss reason. `runPreviewUpgrade` owns every gate (claim-once,
   * never-over-native) and every outcome log line.
   */
  private async redeemPendingPreview(
    deviceId: number,
    trackId: string,
    keyFrameMediaId: number,
    timestamp: number,
  ): Promise<void> {
    const mediaStore = this.mediaStore
    if (!mediaStore) return
    // Refuse cleanly when the addon is not running: a redeem scheduled from a
    // capture exec can fire after `onShutdown`, where `ctx` throws.
    const ctx = this.ctxIfReady
    if (this.shuttingDown || ctx === null) {
      ctx?.logger.info('late keyFrame preview upgrade skipped — addon is shutting down', {
        tags: { deviceId },
        meta: { trackId, keyFrameMediaId },
      })
      return
    }
    try {
      await runPreviewUpgrade(
        {
          takePending: (id) => this.pendingPreviewUpgrades.take(id),
          heldThumbnailProvenance: (id) => mediaStore.trackThumbnailProvenance(id, deviceId),
          derive: (input) => this.keyFrameThumbnailDerive(input),
          put: (input) =>
            mediaStore.put({
              deviceId: input.deviceId,
              ownerKind: 'track',
              ownerId: input.trackId,
              kind: input.kind,
              timestamp: input.timestamp,
              data: input.data,
              provenance: input.provenance,
            }),
          clearPreviewMiss: async (_missDeviceId, missTrackId) => {
            await this.trackStore?.setPreviewMiss(missTrackId, null)
          },
          logger: ctx.logger,
        },
        { deviceId, trackId, keyFrameMediaId, timestamp },
      )
    } catch (err) {
      // A failed redeem leaves the stand-in tile — say so, or the drop is
      // silent and the pending entry's disappearance reads as "never owed".
      ctx.logger.warn('late keyFrame preview upgrade failed', {
        tags: { deviceId },
        meta: { trackId, keyFrameMediaId, error: errMsg(err) },
      })
    }
  }

  /**
   * A face or plate crop just landed from a still-live handle. Fill the
   * missing parent rungs — person/vehicle thumbnail (display crop, same
   * surface that produced the detail) and native keyFrame — so Events never
   * has a child crop without a body and a scene.
   */
  requestTrackHierarchy(input: LiveHierarchyCapture): void {
    void ensureTrackHierarchyMedia(
      {
        isThumbnailLanded: (trackId) => this.residents.isThumbnailLanded(trackId),
        isKeyFrameLanded: (trackId) => this.residents.keyFrameCapture(trackId).landed,
        captureBodyThumbnail: (req) => this.captureHierarchyBodyThumbnail(req),
        captureKeyFrame: async (req) => {
          // A face/plate just landed from THIS handle, so it is young: fill a
          // keyFrame parcel the track has none of (never replace a ranked one).
          this.issueParkOrders(
            {
              deviceId: req.deviceId,
              trackId: req.trackId,
              timestamp: req.timestamp,
              frameHandle: req.frameHandle,
              bbox: { ...req.bodyBbox },
              frameWidth: req.frameWidth,
              frameHeight: req.frameHeight,
            },
            ['keyFrame'],
            true,
          )
          await this.persistKeyFrames(req.deviceId, req.timestamp, [
            { trackId: req.trackId, retry: false },
          ])
        },
      },
      input,
    )
  }

  private async captureHierarchyBodyThumbnail(input: LiveHierarchyCapture): Promise<void> {
    const displayCrop = this.captureDisplayCropFn
    const mediaStore = this.mediaStore
    if (!displayCrop || !mediaStore) return
    await this.captureScheduler
      .request({
        deviceId: input.deviceId,
        trackId: input.trackId,
        kind: 'thumbnail',
        coalesceKey: captureCoalesceKey(input.deviceId, 'thumbnail', `${input.trackId}:hierarchy`),
        staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
        exec: async () => {
          if (this.residents.isThumbnailLanded(input.trackId)) return
          const jpeg = await displayCrop(
            input.frameHandle,
            input.bodyBbox,
            input.frameWidth,
            input.frameHeight,
            input.cropPadding,
            input.trackId,
          )
          if (!jpeg) return
          await mediaStore.put({
            deviceId: input.deviceId,
            ownerKind: 'track',
            ownerId: input.trackId,
            kind: 'thumbnail',
            timestamp: input.timestamp,
            data: jpeg,
            // `raster` (D276): the display-crop ladder may serve a sub-native
            // tier, so this tile stays replaceable by a native cut at close.
            provenance: 'raster',
          })
          this.residents.markThumbnailLanded(input.deviceId, input.trackId)
        },
      })
      .catch(() => {
        /* exec catches its own errors; defensive for scheduler rejections */
      })
  }
}
