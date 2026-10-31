/**
 * The rest of store construction — retrain corpus, events, sensors, galleries.
 *
 * Continuation of `BuildStoresBase.buildStores`, called at the retrain-curation
 * boundary. The statements are the original tail of `buildStores`, unchanged.
 */

import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import { EventCategory, errMsg, MOTION_CLOSE_AFTER_MS, nodePin } from '@camstack/types'
import type { MediaBlobStorage } from '../location-aware-media-storage.js'
import { MediaRelocateEngine } from '../media-relocate-engine.js'
import { MotionEpisodeTracker } from '../motion-episode-tracker.js'
import { PackageDropDetector } from '../pipeline/package-drop-detector.js'
import { RecordedStillService } from '../recorded-still.js'
import { buildRecordedStillPorts, RETRAIN_STILL_MAX_WIDTH } from '../recorded-still-ports.js'
import { RetrainAnnotationStore } from '../retrain/retrain-annotation-store.js'
import { RetrainCollectionService } from '../retrain/retrain-collection-service.js'
import { RetrainCollectionStore } from '../retrain/retrain-collection-store.js'
import { retrainFramePath } from '../retrain/retrain-frame-handler.js'
import { RetrainFrameStore } from '../retrain/retrain-frame-store.js'
import {
  RETRAIN_LLM_CONSUMER,
  RETRAIN_LLM_TIMEOUT_MS,
  RetrainLlmAssistService,
} from '../retrain/retrain-llm-service.js'
import {
  PIPELINE_BOX_TOLERANCE_MS,
  PIPELINE_TRACK_AROUND_LIMIT,
  PIPELINE_TRACK_LOOKBACK_MS,
} from '../retrain/retrain-pipeline-boxes.js'
import { RetrainService } from '../retrain/retrain-service.js'
import { chromaSpread } from '../scene/scene-crop.js'
import { AudioMarkerProjector } from '../services/audio-marker-projector.js'
import { LinkedCamerasCache } from '../services/event-kinds.js'
import { MotionEventSnapshotCapturer } from '../services/motion-event-snapshot.js'
import { SyntheticTrackMaterializer } from '../services/synthetic-track.js'
import { AnalyticsHistoryProducer } from '../store/analytics-history-producer.js'
import { deviceHistoryWriteClient } from '../store/device-history-write-client.js'
import {
  EmbeddingVectorIndex,
  FACE_ARCFACE_INDEX,
  IDENTITY_ARCFACE_INDEX,
} from '../store/embedding-vector-index.js'
import type { EventLedgerWiringDeps } from '../store/event-ledger-wiring.js'
import {
  wireAudioEventLedger,
  wireFaceLedger,
  wireIdentityLedger,
  wireIdentitySampleLedger,
  wireMotionEventLedger,
  wirePlateLedger,
  wireRetrainAnnotationLedger,
  wireRetrainCollectionFrameLedger,
  wireRetrainCollectionLedger,
  wireRetrainFrameLedger,
  wireSensorEventLedger,
  wireVehicleLedger,
  wireVehicleSampleLedger,
} from '../store/event-ledger-wiring.js'
import { EventStore } from '../store/event-store.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import { PlateStore } from '../store/plate-store.js'
import { SensorEventStore } from '../store/sensor-event-store.js'
import { TrackStore } from '../store/track-store.js'
import { VehicleStore } from '../store/vehicle-store.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'
import { BuildStoresBase } from './build-stores.js'

export class BuildStores extends BuildStoresBase {
  protected async buildStoresRemainder(
    api: AnalyticsApi,
    logger: IScopedLogger,
    storage: MediaBlobStorage,
    trackStore: TrackStore,
    mediaStore: MediaStore,
    eventLedgerWiring: EventLedgerWiringDeps,
  ): Promise<AnalyticsStores> {
    // ── Retrain curation ──────────────────────────────────────────────
    // The dataset's own storage: copies, annotations, and the service that
    // binds them to the track store and the runner. Built here, next to the
    // media store, because copy-on-select reads a blob through it — the ONLY
    // dependency the retrain corpus has on the track corpus, and only at
    // selection time (`retrain/retrain-frame-store.ts`).
    const retrainFrames = new RetrainFrameStore({
      storage,
      logger: logger.child('RetrainFrames'),
      now: () => Date.now(),
      frameLedger: wireRetrainFrameLedger(eventLedgerWiring),
      writeGate: this.mediaWriteGate,
      // Measured once from the copy's bytes: what lets the export call a frame
      // IR without decoding anything (D785).
      measureChroma: (bytes) => chromaSpread(bytes),
      // Copies are written to the durable `retrainMedia` tenant of the
      // artifacts class (D781), never to the footage class: no eventMedia
      // resolver, no seal population, no repoint can re-aim them.
      readSource: async (mediaKey) => {
        const file = await mediaStore.getBytesById(mediaKey)
        return file === null ? null : file.bytes
      },
    })
    const retrainAnnotations = new RetrainAnnotationStore({
      logger: logger.child('RetrainAnnotations'),
      now: () => Date.now(),
      newId: () => randomUUID(),
      annotationLedger: wireRetrainAnnotationLedger(eventLedgerWiring),
      frameLedger: wireRetrainFrameLedger(eventLedgerWiring),
    })
    this.retrainFrames = retrainFrames
    this.retrainAnnotations = retrainAnnotations
    const retrainCollectionStore = new RetrainCollectionStore({
      logger: logger.child('RetrainCollections'),
      now: () => Date.now(),
      newId: () => randomUUID(),
      collectionLedger: wireRetrainCollectionLedger(eventLedgerWiring),
      membershipLedger: wireRetrainCollectionFrameLedger(eventLedgerWiring),
    })
    this.retrainCollectionStore = retrainCollectionStore
    const retrain = new RetrainService({
      tracks: {
        listStaging: (deviceId, limit) => trackStore.listStaging(deviceId, limit),
        listDeviceIds: () => trackStore.listDeviceIds(),
        getPersistedByTrackId: (trackId) => trackStore.getPersistedByTrackId(trackId),
        readStatus: async (trackId) => (await trackStore.readFlags(trackId))?.retrainStatus ?? null,
        setStatus: (trackId, status) => trackStore.setRetrainStatus(trackId, status),
      },
      media: {
        listTrackMedia: (trackId) => mediaStore.listInfoByOwner('track', trackId),
        readBlob: async (mediaKey) => {
          const file = await mediaStore.getBytesById(mediaKey)
          return file === null ? null : file.bytes
        },
      },
      frames: retrainFrames,
      annotations: retrainAnnotations,
      // Unpinned unless the caller says otherwise: an unowned call is served
      // hub-in-process like any other singleton, and the assist is a single
      // frame at human speed — it does not need a rotation.
      runner: (input, nodeId) =>
        nodeId === undefined
          ? api.pipelineRunner.runStatelessStep.mutate(input)
          : api.pipelineRunner.runStatelessStep.mutate(input, nodePin(nodeId)),
      logger: logger.child('Retrain'),
      // Step 1 — the boxes the pipeline drew on a copied frame, read back
      // from the track store (index rows only, never a model re-run).
      pipelineEvidence: {
        tracksAround: (deviceId, atMs) =>
          trackStore.queryHistorical({
            deviceId,
            since: atMs - PIPELINE_TRACK_LOOKBACK_MS,
            until: atMs + PIPELINE_BOX_TOLERANCE_MS,
            limit: PIPELINE_TRACK_AROUND_LIMIT,
          }),
        subjectBoxes: (trackId, deviceId) =>
          mediaStore.listSubjectBoxesByOwner('track', trackId, deviceId),
      },
      memberships: retrainCollectionStore,
      // The operator's answers to the notification buttons, read lazily: the
      // notification center is built after the stores.
      verdicts: {
        forTracks: async (trackIds) =>
          this.notificationCenter?.detectionVerdictsOf(trackIds) ?? new Map(),
      },
      // The pixels travel over the admin `retrain-frame` data plane, not as
      // base64 inside a cap answer (D613). Absent until the plane is served.
      frameUrl: (frameId, size) => retrainFramePath(this.ctx.id, frameId, size),
    })
    this.retrain = retrain
    // A frame from the RECORDING at a playhead instant — the native frame
    // re-decoded by the recorder (high profile, not downscaled). One service,
    // so its decode bound holds across every operator click on this hub.
    const retrainStills = new RecordedStillService(
      buildRecordedStillPorts({
        api: this.ctx.api.recordingArchive,
        logger: logger.child('RetrainStills'),
        resolveFfmpeg: this.pinnedFfmpeg,
      }),
    )
    this.retrainCollections = new RetrainCollectionService({
      collections: retrainCollectionStore,
      frames: retrainFrames,
      annotations: retrainAnnotations,
      retrain,
      captureStill: (deviceId, epochMs) =>
        retrainStills.recover(deviceId, epochMs, RETRAIN_STILL_MAX_WIDTH),
      logger: logger.child('RetrainCollections'),
    })
    // AI-vision pre-annotation over the existing `llm` capability. One frame
    // per call, at human speed; the image is the retrain COPY.
    this.retrainLlmAssist = new RetrainLlmAssistService({
      frames: retrainFrames,
      llm: {
        listProfiles: async () =>
          (await api.llm.listProfiles.query({})).map((p) => ({
            id: p.id,
            name: p.name,
            model: p.model,
            kind: p.kind,
            // D895: the endpoint lives in the provider's `providerConfig`.
            ...(typeof p.providerConfig.baseUrl === 'string'
              ? { baseUrl: p.providerConfig.baseUrl }
              : {}),
            enabled: p.enabled,
            supportsVision: p.supportsVision,
          })),
        generateVision: async (request) => {
          const result = await api.llm.generateVision.mutate({
            profileId: request.profileId,
            consumer: RETRAIN_LLM_CONSUMER,
            system: request.system,
            prompt: request.prompt,
            jsonSchema: request.jsonSchema,
            images: [{ bytes: new Uint8Array(request.image), mimeType: 'image/jpeg' }],
            temperature: 0,
            timeoutMs: RETRAIN_LLM_TIMEOUT_MS,
          })
          return result.ok
            ? { ok: true, text: result.text, model: result.model }
            : { ok: false, code: result.code, message: result.message }
        },
      },
      logger: logger.child('RetrainLlmAssist'),
    })
    this.mediaRelocate = new MediaRelocateEngine({
      store: api.settingsStore,
      retrainFrameLedger: wireRetrainFrameLedger(eventLedgerWiring),
      storage,
      logger: logger.child('MediaRelocate'),
      now: () => Date.now(),
      newId: () => randomUUID(),
      resolveTargetRoot: (locationId) =>
        api.storage.resolve.query({ location: locationId, relativePath: '' }),
      onFinished: (job) => {
        void this.eventsOpsLog?.append({
          op: 'relocate',
          reason: 'operator',
          deviceId: job.deviceId,
          itemsAffected: job.filesMoved,
          bytesReclaimed: 0,
          detail: `${job.state}: media → ${job.toLocationId} (${job.bytesMoved} bytes${job.error ? `; ${job.error}` : ''})`,
        })
      },
    })
    // Seed the alert-settings mirror before the intake can open. Armed, not
    // awaited: it is one store read, and until it lands the centre runs on the
    // shipped defaults — which is what an install that never opened the page
    // runs on anyway. A boot that awaited it would put a settings read on the
    // critical path of the notification centre for no gain (D179).
    void this.refreshDeviceAlertSettings()
    // Constructed BEFORE `EventStore` because the motion tap is one of its
    // deps: the LTS sample rides the call that already writes the row, never a
    // second subscription that could disagree with it.
    this.lts = new AnalyticsHistoryProducer({
      deviceHistory: deviceHistoryWriteClient(api.deviceHistory),
      logger: logger.child('device-history'),
    })
    void this.lts.declare().catch((err: unknown) => {
      logger.warn('pipeline-analytics history series declare failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    const lts = this.lts
    const eventStore = new EventStore({
      store: api.settingsStore,
      logger: logger.child('EventStore'),
      audioLevelHistory: (input) => api.deviceHistory.query.query(input),
      motionLedger: wireMotionEventLedger(eventLedgerWiring),
      audioLedger: wireAudioEventLedger(eventLedgerWiring),
      // `regionCount` is the value; the ROW COUNT is the activity.
      onMotionSample: (deviceId, regionCount, at) => lts.note('motion', deviceId, regionCount, at),
      // Fold event-owned media into the track-deletion cascade so a caller can
      // never skip the media wipe (design §4). mediaStore is constructed above.
      media: mediaStore,
    })
    this.eventStore = eventStore
    // Constructed once `eventStore` exists — it is `insertRow`/`closeRow`'s
    // only dependency (D475).
    this.motionEpisodes = new MotionEpisodeTracker({
      closeAfterMs: MOTION_CLOSE_AFTER_MS,
      logger: logger.child('MotionEpisodeTracker'),
      insertRow: (input) =>
        this.insertMotionEpisodeRow(input.deviceId, input.timestamp, input.regionData),
      closeRow: (input) => this.closeMotionEpisodeRow(input),
      onNewEdge: (input) => this.onMotionEpisodeEdge(input),
      onTick: (input) => this.onMotionEpisodeTick(input),
    })
    this.sensorEventStore = new SensorEventStore({
      logger: logger.child('SensorEventStore'),
      sensorLedger: wireSensorEventLedger(eventLedgerWiring),
    })
    // Package-drop detector — consumes the stationary registry's appear/
    // depart signal (wired in the registry `onChange` above) and persists
    // delivered/picked-up as STANDARD object-events (className `package`),
    // so timeline + event-media + retention all work with no new plane.
    this.packageDropDetector = new PackageDropDetector({
      events: eventStore,
      emit: {
        delivered: (payload) => {
          this.ctx.eventBus.emit({
            id: `pa-package-delivered-${payload.entryId}`,
            timestamp: new Date(payload.timestamp),
            source: {
              type: 'addon',
              id: 'pipeline-analytics',
              addonId: 'pipeline-analytics',
            },
            category: EventCategory.PipelineAnalyticsPackageDelivered,
            data: { ...payload },
          })
        },
        pickedUp: (payload) => {
          this.ctx.eventBus.emit({
            id: `pa-package-pickedup-${payload.entryId}`,
            timestamp: new Date(payload.timestamp),
            source: {
              type: 'addon',
              id: 'pipeline-analytics',
              addonId: 'pipeline-analytics',
            },
            category: EventCategory.PipelineAnalyticsPackagePickedUp,
            data: { ...payload },
          })
        },
      },
      logger: logger.child('PackageDropDetector'),
      resolveZones: (deviceId) => this.resolveDeviceZones(deviceId),
      resolvePackageRules: (deviceId) => this.resolveDevicePackageRules(deviceId),
      resolveSettings: (deviceId) => this.resolveDevicePackageDropSettings(deviceId),
      resolveZoneMembershipMinOverlap: async (deviceId) =>
        (await this.resolveDeviceTrackingSettings(deviceId)).zoneMembershipMinOverlap,
      confirmPackage: (input) => this.deps.confirmPackage(input),
      onLlmSilence: (edge) => {
        const deviceId = edge.phase === 'silent' ? edge.note.deviceId : edge.deviceId
        this.ctx.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id: deviceId, deviceId },
          category:
            edge.phase === 'silent'
              ? EventCategory.PipelinePackageLlmSilent
              : EventCategory.PipelinePackageLlmAnswered,
          data:
            edge.phase === 'silent'
              ? {
                  deviceId,
                  reason: edge.note.reason,
                  latencyMs: edge.note.latencyMs,
                }
              : { deviceId },
        })
      },
      // NC package-event trigger (D-2): evaluate on the durable insert. Guarded
      // by the center's own `evaluationActive` (post-processing node only).
      // A pick-up's instant rides on the row itself (`ev.observedAt`, D684).
      onPersisted: (ev, phase) => this.notificationCenter?.onPackageEventPersisted(ev, phase),
      onError: (scope, err) =>
        logger.warn('package-drop detector error', {
          meta: { scope, error: errMsg(err) },
        }),
    })
    // Reverse index for sensor-event ingest: which cameras is a source device
    // linked to. Camera enumeration + link resolution both go through the
    // device-manager cap (ctx.api — never a local registry scan).
    this.linkedCamerasCache = new LinkedCamerasCache({
      cameras: {
        listCameraIds: async (): Promise<readonly number[]> => {
          // Filtered and projected SERVER-side. This enumeration wants ids, so
          // the full projection was paying `listAll`'s per-device settings read
          // for all 967 devices to keep 30 numbers. `isCamera` / `projection`
          // are safe at a hub that predates them — Zod STRIPS unknown input
          // keys — and the client-side filter below stays for exactly that.
          const all = await api.deviceManager.listAll.query({
            isCamera: true,
            projection: 'slim',
          })
          return all.filter((d) => d.isCamera).map((d) => d.id)
        },
      },
      linkedDevices: {
        getLinkedDevices: (input) => api.deviceManager.getLinkedDevices.query(input),
      },
      linkedDevicesBatch: {
        getLinkedDevicesBatch: (input) => api.deviceManager.getLinkedDevicesBatch.query(input),
      },
      // A per-camera links read that failed is tagged with THAT camera: "why is
      // the index unanswered" is asked per camera.
      onError: (scope, err, cameraId) =>
        logger.warn('linked-cameras cache refresh failed', {
          ...(cameraId !== undefined ? { tags: { deviceId: cameraId } } : {}),
          meta: { scope, error: errMsg(err) },
        }),
    })
    // Non-spatial events → synthetic snapshot-carrying tracks (§8, D62).
    // ONE materializer for linked sensors AND audio markers: it reuses the
    // media + track stores so the projection lands in the SAME shape the UIs
    // already consume, and a second copy would have to re-learn every media
    // contract this one encodes.
    const syntheticTracks = new SyntheticTrackMaterializer({
      snapshot: { getSnapshot: (i) => api.snapshot.getSnapshot.query(i) },
      media: mediaStore,
      tracks: trackStore,
      // Every materializer error names its camera (the id it was called for):
      // "why did 102 land without a picture" is asked per camera.
      onError: (scope, err, deviceId) =>
        logger.warn('synthetic track error', {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: { scope, error: errMsg(err) },
        }),
    })
    this.syntheticTracks = syntheticTracks
    // Motion rows have no track and no decoded frame. The snapshot cap is
    // the same still synthetic tracks use — cached, never `force`. A miss
    // leaves the motion row (the durable record) and a 404 thumbnail.
    this.motionEventSnapshots = new MotionEventSnapshotCapturer({
      snapshot: {
        getSnapshot: (i) => api.snapshot?.getSnapshot.query(i) ?? Promise.resolve(null),
      },
      media: mediaStore,
      logger: logger.child('MotionMarkerStill'),
      onError: (scope, err, deviceId) =>
        logger.warn('motion event snapshot failed', {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: { scope, error: errMsg(err) },
        }),
    })
    this.audioMarkers = new AudioMarkerProjector({
      sink: syntheticTracks,
      isMotionActive: (deviceId, atMs, quietMs) => this.isMotionActive(deviceId, atMs, quietMs),
      logger: logger.child('AudioMarkers'),
      onError: (scope, err) =>
        logger.warn('audio marker error', {
          meta: { scope, error: errMsg(err) },
        }),
    })
    // The two ArcFace indexes. The `vector-store` provider is the
    // sqlite-settings BUILTIN — the same addon that serves `api.settingsStore`
    // one line below — so its absence here is not a degraded mode, it is a hub
    // whose database layer is not up, and a face gallery with no vector home is
    // recognition that silently matches nobody. Refuse rather than boot into it.
    const galleryVectorStore = api.vectorStore
    if (galleryVectorStore === undefined) {
      throw new Error(
        'pipeline-analytics: the vector-store capability is unavailable, so the face and identity galleries have no home for their vectors — refusing to start recognition without one',
      )
    }
    const identityStore = new IdentityStore({
      vectors: new EmbeddingVectorIndex({
        index: IDENTITY_ARCFACE_INDEX,
        client: galleryVectorStore,
        logger: logger.child('IdentityVectors'),
      }),
      logger: logger.child('IdentityStore'),
      identityLedger: wireIdentityLedger(eventLedgerWiring),
      sampleLedger: wireIdentitySampleLedger(eventLedgerWiring),
    })
    this.identityStore = identityStore
    const faceStore = new FaceStore({
      vectors: new EmbeddingVectorIndex({
        index: FACE_ARCFACE_INDEX,
        client: galleryVectorStore,
        logger: logger.child('FaceVectors'),
      }),
      logger: logger.child('FaceStore'),
      faceLedger: wireFaceLedger(eventLedgerWiring),
    })
    this.faceStore = faceStore
    const plateStore = new PlateStore({
      logger: logger.child('PlateStore'),
      plateLedger: wirePlateLedger(eventLedgerWiring),
    })
    this.plateStore = plateStore
    const vehicleStore = new VehicleStore({
      logger: logger.child('VehicleStore'),
      vehicleLedger: wireVehicleLedger(eventLedgerWiring),
      sampleLedger: wireVehicleSampleLedger(eventLedgerWiring),
    })
    return {
      trackStore,
      mediaStore,
      eventStore,
      identityStore,
      faceStore,
      plateStore,
      vehicleStore,
    }
  }
}
