/**
 * Store construction for pipeline-analytics.
 *
 * Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, boot extraction):
 * only the visibility of the entry points changed. Every dependency the
 * builders read on the addon is a getter on this class, backed by the deps
 * object. `buildStores` is split after the media doorbell so each file stays
 * readable; `buildStoresRemainder` runs at that point, in the same order.
 */

import type {
  AddonContext,
  IScopedLogger,
  RecordsAccess,
  StorageOccupancyReport,
  Zone,
  ZoneRule,
} from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'
import { NotificationCenter } from '../../notification-center/index.js'
import { subjectLabelFromTiers } from '../../notification-center/rule-engine.js'
import {
  EventMediaWriteLocator,
  subscribeEventMediaWriteLocator,
} from '../event-media-write-location.js'
import { FrameAdmission } from '../frame/frame-admission.js'
import { FrameState } from '../frame/frame-state.js'
import type {
  LocationAwareMediaBlobStorage,
  MediaBlobStorage,
} from '../location-aware-media-storage.js'
import { mediaOccupancyReports } from '../media-occupancy.js'
import { MediaRelocateEngine } from '../media-relocate-engine.js'
import { MediaWriteGate } from '../media-write-gate.js'
import { MotionEpisodeTracker } from '../motion-episode-tracker.js'
import type { PackageDropSettings } from '../package-settings.js'
import { PackageBackgroundRegistry } from '../pipeline/package/package-background.js'
import type { PackageLlmConfirmOutcome } from '../pipeline/package/package-llm-confirm.js'
import { PackageDropDetector } from '../pipeline/package-drop-detector.js'
import { PhantomCellRegistry } from '../pipeline/stationary/phantom-cells.js'
import { StationaryEvidenceLedger } from '../pipeline/stationary/stationary-evidence-ledger.js'
import { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import type { StationaryEntry } from '../pipeline/stationary/stationary-types.js'
import { RetrainAnnotationStore } from '../retrain/retrain-annotation-store.js'
import { RetrainCollectionService } from '../retrain/retrain-collection-service.js'
import { RetrainCollectionStore } from '../retrain/retrain-collection-store.js'
import { RetrainFrameStore } from '../retrain/retrain-frame-store.js'
import { RetrainLlmAssistService } from '../retrain/retrain-llm-service.js'
import { RetrainService } from '../retrain/retrain-service.js'
import { AudioMarkerProjector } from '../services/audio-marker-projector.js'
import { LinkedCamerasCache } from '../services/event-kinds.js'
import { MotionEventSnapshotCapturer } from '../services/motion-event-snapshot.js'
import { SyntheticTrackMaterializer } from '../services/synthetic-track.js'
import type { StationarySettings } from '../stationary-settings.js'
import { AnalyticsHistoryProducer } from '../store/analytics-history-producer.js'
import type { EventLedgerWiringDeps } from '../store/event-ledger-wiring.js'
import { wireTrackAliasLedger } from '../store/event-ledger-wiring.js'
import { EventStore } from '../store/event-store.js'
import { FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { DEFAULT_MEDIA_LOCATION, MediaStore } from '../store/media-store.js'
import { OpsLogStore } from '../store/ops-log-store.js'
import { PlateStore } from '../store/plate-store.js'
import { SensorEventStore } from '../store/sensor-event-store.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import { TrackStore } from '../store/track-store.js'
import type { AliasResolveFailure } from '../track-alias-resolution.js'
import { sampledOnce } from '../track-alias-resolution.js'
import type { TrackingSettings } from '../tracking-settings.js'
import type { AnalyticsApi, AnalyticsStores, MotionEpisodeRowData } from './boot-types.js'
import { ALIAS_RESOLVE_FAILURE_MEMO_MAX } from './boot-types.js'

export interface BuildStoresDeps {
  readonly mediaStore: () => MediaStore | null
  readonly setMediaStore: (value: MediaStore | null) => void
  readonly mediaOccupancyUnattributedLogged: () => boolean
  readonly setMediaOccupancyUnattributedLogged: (value: boolean) => void
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly eventMediaWriteLocator: () => EventMediaWriteLocator | null
  readonly setEventMediaWriteLocator: (value: EventMediaWriteLocator | null) => void
  readonly requireRecords: () => RecordsAccess
  readonly frameState: () => FrameState
  readonly notificationCenter: () => NotificationCenter | null
  readonly trackStore: () => TrackStore | null
  readonly setTrackStore: (value: TrackStore | null) => void
  readonly trackAliasStore: () => TrackAliasStore | null
  readonly setTrackAliasStore: (value: TrackAliasStore | null) => void
  readonly eventLedgerWiring: () => EventLedgerWiringDeps
  readonly aliasResolveFailureLogger: () => ((failure: AliasResolveFailure) => void) | null
  readonly setAliasResolveFailureLogger: (
    value: ((failure: AliasResolveFailure) => void) | null,
  ) => void
  readonly stationaryRegistry: () => StationaryObjectRegistry | null
  readonly setStationaryRegistry: (value: StationaryObjectRegistry | null) => void
  readonly stationarySettingsFromCache: (deviceId: number) => StationarySettings
  readonly releaseStationaryKeyFrame: (entry: StationaryEntry) => Promise<void>
  readonly frameAdmission: () => FrameAdmission
  readonly packageDropDetector: () => PackageDropDetector | null
  readonly setPackageDropDetector: (value: PackageDropDetector | null) => void
  readonly confirmPackage: (input: {
    readonly deviceId: number
    readonly entryId: string
    readonly zoneIds: readonly string[]
  }) => Promise<PackageLlmConfirmOutcome>
  readonly stationaryEvidence: () => StationaryEvidenceLedger | null
  readonly setStationaryEvidence: (value: StationaryEvidenceLedger | null) => void
  readonly phantomCells: () => PhantomCellRegistry | null
  readonly setPhantomCells: (value: PhantomCellRegistry | null) => void
  readonly packageBackground: () => PackageBackgroundRegistry | null
  readonly setPackageBackground: (value: PackageBackgroundRegistry | null) => void
  readonly mediaWriteGate: () => MediaWriteGate
  readonly eventMediaLocationDoorbellUnsub: () => (() => void) | null
  readonly setEventMediaLocationDoorbellUnsub: (value: (() => void) | null) => void
  readonly mediaLocationStorage: () => LocationAwareMediaBlobStorage | null
  readonly retrainFrames: () => RetrainFrameStore | null
  readonly setRetrainFrames: (value: RetrainFrameStore | null) => void
  readonly retrainAnnotations: () => RetrainAnnotationStore | null
  readonly setRetrainAnnotations: (value: RetrainAnnotationStore | null) => void
  readonly retrainCollectionStore: () => RetrainCollectionStore | null
  readonly setRetrainCollectionStore: (value: RetrainCollectionStore | null) => void
  readonly retrain: () => RetrainService | null
  readonly setRetrain: (value: RetrainService | null) => void
  readonly pinnedFfmpeg: () => () => Promise<string>
  readonly retrainCollections: () => RetrainCollectionService | null
  readonly setRetrainCollections: (value: RetrainCollectionService | null) => void
  readonly retrainLlmAssist: () => RetrainLlmAssistService | null
  readonly setRetrainLlmAssist: (value: RetrainLlmAssistService | null) => void
  readonly mediaRelocate: () => MediaRelocateEngine | null
  readonly setMediaRelocate: (value: MediaRelocateEngine | null) => void
  readonly eventsOpsLog: () => OpsLogStore | null
  readonly refreshDeviceAlertSettings: () => Promise<void>
  readonly lts: () => AnalyticsHistoryProducer | null
  readonly setLts: (value: AnalyticsHistoryProducer | null) => void
  readonly eventStore: () => EventStore | null
  readonly setEventStore: (value: EventStore | null) => void
  readonly motionEpisodes: () => MotionEpisodeTracker<MotionEpisodeRowData> | null
  readonly setMotionEpisodes: (value: MotionEpisodeTracker<MotionEpisodeRowData> | null) => void
  readonly insertMotionEpisodeRow: (
    deviceId: number,
    timestamp: number,
    regionData: MotionEpisodeRowData,
  ) => Promise<number | null>
  readonly closeMotionEpisodeRow: (input: {
    readonly deviceId: number
    readonly eventId: number
    readonly durationMs: number
    readonly edges: readonly number[]
  }) => Promise<boolean>
  readonly onMotionEpisodeEdge: (input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly eventId: number
  }) => void
  readonly onMotionEpisodeTick: (input: {
    readonly deviceId: number
    readonly timestamp: number
  }) => void
  readonly sensorEventStore: () => SensorEventStore | null
  readonly setSensorEventStore: (value: SensorEventStore | null) => void
  readonly resolveDeviceZones: (deviceId: number) => Promise<readonly Zone[]>
  readonly resolveDevicePackageRules: (deviceId: number) => Promise<readonly ZoneRule[]>
  readonly resolveDevicePackageDropSettings: (deviceId: number) => Promise<PackageDropSettings>
  readonly resolveDeviceTrackingSettings: (deviceId: number) => Promise<TrackingSettings>
  readonly linkedCamerasCache: () => LinkedCamerasCache | null
  readonly setLinkedCamerasCache: (value: LinkedCamerasCache | null) => void
  readonly syntheticTracks: () => SyntheticTrackMaterializer | null
  readonly setSyntheticTracks: (value: SyntheticTrackMaterializer | null) => void
  readonly motionEventSnapshots: () => MotionEventSnapshotCapturer | null
  readonly setMotionEventSnapshots: (value: MotionEventSnapshotCapturer | null) => void
  readonly audioMarkers: () => AudioMarkerProjector | null
  readonly setAudioMarkers: (value: AudioMarkerProjector | null) => void
  readonly isMotionActive: (deviceId: number, atMs: number, quietMs: number) => boolean
  readonly identityStore: () => IdentityStore | null
  readonly setIdentityStore: (value: IdentityStore | null) => void
  readonly faceStore: () => FaceStore | null
  readonly setFaceStore: (value: FaceStore | null) => void
  readonly plateStore: () => PlateStore | null
  readonly setPlateStore: (value: PlateStore | null) => void
}

export abstract class BuildStoresBase {
  constructor(protected readonly deps: BuildStoresDeps) {}

  protected get mediaStore(): MediaStore | null {
    return this.deps.mediaStore()
  }

  protected set mediaStore(value: MediaStore | null) {
    this.deps.setMediaStore(value)
  }

  protected get mediaOccupancyUnattributedLogged(): boolean {
    return this.deps.mediaOccupancyUnattributedLogged()
  }

  protected set mediaOccupancyUnattributedLogged(value: boolean) {
    this.deps.setMediaOccupancyUnattributedLogged(value)
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get eventMediaWriteLocator(): EventMediaWriteLocator | null {
    return this.deps.eventMediaWriteLocator()
  }

  protected set eventMediaWriteLocator(value: EventMediaWriteLocator | null) {
    this.deps.setEventMediaWriteLocator(value)
  }

  protected requireRecords(): RecordsAccess {
    return this.deps.requireRecords()
  }

  protected get frameState(): FrameState {
    return this.deps.frameState()
  }

  protected get notificationCenter(): NotificationCenter | null {
    return this.deps.notificationCenter()
  }

  protected get trackStore(): TrackStore | null {
    return this.deps.trackStore()
  }

  protected set trackStore(value: TrackStore | null) {
    this.deps.setTrackStore(value)
  }

  protected get trackAliasStore(): TrackAliasStore | null {
    return this.deps.trackAliasStore()
  }

  protected set trackAliasStore(value: TrackAliasStore | null) {
    this.deps.setTrackAliasStore(value)
  }

  protected eventLedgerWiring(): EventLedgerWiringDeps {
    return this.deps.eventLedgerWiring()
  }

  protected get aliasResolveFailureLogger(): ((failure: AliasResolveFailure) => void) | null {
    return this.deps.aliasResolveFailureLogger()
  }

  protected set aliasResolveFailureLogger(value: ((failure: AliasResolveFailure) => void) | null) {
    this.deps.setAliasResolveFailureLogger(value)
  }

  protected get stationaryRegistry(): StationaryObjectRegistry | null {
    return this.deps.stationaryRegistry()
  }

  protected set stationaryRegistry(value: StationaryObjectRegistry | null) {
    this.deps.setStationaryRegistry(value)
  }

  protected stationarySettingsFromCache(deviceId: number): StationarySettings {
    return this.deps.stationarySettingsFromCache(deviceId)
  }

  protected async releaseStationaryKeyFrame(entry: StationaryEntry): Promise<void> {
    return this.deps.releaseStationaryKeyFrame(entry)
  }

  protected get frameAdmission(): FrameAdmission {
    return this.deps.frameAdmission()
  }

  protected get packageDropDetector(): PackageDropDetector | null {
    return this.deps.packageDropDetector()
  }

  protected set packageDropDetector(value: PackageDropDetector | null) {
    this.deps.setPackageDropDetector(value)
  }

  protected get stationaryEvidence(): StationaryEvidenceLedger | null {
    return this.deps.stationaryEvidence()
  }

  protected set stationaryEvidence(value: StationaryEvidenceLedger | null) {
    this.deps.setStationaryEvidence(value)
  }

  protected get phantomCells(): PhantomCellRegistry | null {
    return this.deps.phantomCells()
  }

  protected set phantomCells(value: PhantomCellRegistry | null) {
    this.deps.setPhantomCells(value)
  }

  protected get packageBackground(): PackageBackgroundRegistry | null {
    return this.deps.packageBackground()
  }

  protected set packageBackground(value: PackageBackgroundRegistry | null) {
    this.deps.setPackageBackground(value)
  }

  protected get mediaWriteGate(): MediaWriteGate {
    return this.deps.mediaWriteGate()
  }

  protected get eventMediaLocationDoorbellUnsub(): (() => void) | null {
    return this.deps.eventMediaLocationDoorbellUnsub()
  }

  protected set eventMediaLocationDoorbellUnsub(value: (() => void) | null) {
    this.deps.setEventMediaLocationDoorbellUnsub(value)
  }

  protected get mediaLocationStorage(): LocationAwareMediaBlobStorage | null {
    return this.deps.mediaLocationStorage()
  }

  protected get retrainFrames(): RetrainFrameStore | null {
    return this.deps.retrainFrames()
  }

  protected set retrainFrames(value: RetrainFrameStore | null) {
    this.deps.setRetrainFrames(value)
  }

  protected get retrainAnnotations(): RetrainAnnotationStore | null {
    return this.deps.retrainAnnotations()
  }

  protected set retrainAnnotations(value: RetrainAnnotationStore | null) {
    this.deps.setRetrainAnnotations(value)
  }

  protected get retrainCollectionStore(): RetrainCollectionStore | null {
    return this.deps.retrainCollectionStore()
  }

  protected set retrainCollectionStore(value: RetrainCollectionStore | null) {
    this.deps.setRetrainCollectionStore(value)
  }

  protected get retrain(): RetrainService | null {
    return this.deps.retrain()
  }

  protected set retrain(value: RetrainService | null) {
    this.deps.setRetrain(value)
  }

  protected get pinnedFfmpeg(): () => Promise<string> {
    return this.deps.pinnedFfmpeg()
  }

  protected get retrainCollections(): RetrainCollectionService | null {
    return this.deps.retrainCollections()
  }

  protected set retrainCollections(value: RetrainCollectionService | null) {
    this.deps.setRetrainCollections(value)
  }

  protected get retrainLlmAssist(): RetrainLlmAssistService | null {
    return this.deps.retrainLlmAssist()
  }

  protected set retrainLlmAssist(value: RetrainLlmAssistService | null) {
    this.deps.setRetrainLlmAssist(value)
  }

  protected get mediaRelocate(): MediaRelocateEngine | null {
    return this.deps.mediaRelocate()
  }

  protected set mediaRelocate(value: MediaRelocateEngine | null) {
    this.deps.setMediaRelocate(value)
  }

  protected get eventsOpsLog(): OpsLogStore | null {
    return this.deps.eventsOpsLog()
  }

  protected async refreshDeviceAlertSettings(): Promise<void> {
    return this.deps.refreshDeviceAlertSettings()
  }

  protected get lts(): AnalyticsHistoryProducer | null {
    return this.deps.lts()
  }

  protected set lts(value: AnalyticsHistoryProducer | null) {
    this.deps.setLts(value)
  }

  protected get eventStore(): EventStore | null {
    return this.deps.eventStore()
  }

  protected set eventStore(value: EventStore | null) {
    this.deps.setEventStore(value)
  }

  protected get motionEpisodes(): MotionEpisodeTracker<MotionEpisodeRowData> | null {
    return this.deps.motionEpisodes()
  }

  protected set motionEpisodes(value: MotionEpisodeTracker<MotionEpisodeRowData> | null) {
    this.deps.setMotionEpisodes(value)
  }

  protected async insertMotionEpisodeRow(
    deviceId: number,
    timestamp: number,
    regionData: MotionEpisodeRowData,
  ): Promise<number | null> {
    return this.deps.insertMotionEpisodeRow(deviceId, timestamp, regionData)
  }

  protected async closeMotionEpisodeRow(input: {
    readonly deviceId: number
    readonly eventId: number
    readonly durationMs: number
    readonly edges: readonly number[]
  }): Promise<boolean> {
    return this.deps.closeMotionEpisodeRow(input)
  }

  protected onMotionEpisodeEdge(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly eventId: number
  }): void {
    return this.deps.onMotionEpisodeEdge(input)
  }

  protected onMotionEpisodeTick(input: {
    readonly deviceId: number
    readonly timestamp: number
  }): void {
    return this.deps.onMotionEpisodeTick(input)
  }

  protected get sensorEventStore(): SensorEventStore | null {
    return this.deps.sensorEventStore()
  }

  protected set sensorEventStore(value: SensorEventStore | null) {
    this.deps.setSensorEventStore(value)
  }

  protected async resolveDeviceZones(deviceId: number): Promise<readonly Zone[]> {
    return this.deps.resolveDeviceZones(deviceId)
  }

  protected async resolveDevicePackageRules(deviceId: number): Promise<readonly ZoneRule[]> {
    return this.deps.resolveDevicePackageRules(deviceId)
  }

  protected async resolveDevicePackageDropSettings(deviceId: number): Promise<PackageDropSettings> {
    return this.deps.resolveDevicePackageDropSettings(deviceId)
  }

  protected async resolveDeviceTrackingSettings(deviceId: number): Promise<TrackingSettings> {
    return this.deps.resolveDeviceTrackingSettings(deviceId)
  }

  protected get linkedCamerasCache(): LinkedCamerasCache | null {
    return this.deps.linkedCamerasCache()
  }

  protected set linkedCamerasCache(value: LinkedCamerasCache | null) {
    this.deps.setLinkedCamerasCache(value)
  }

  protected get syntheticTracks(): SyntheticTrackMaterializer | null {
    return this.deps.syntheticTracks()
  }

  protected set syntheticTracks(value: SyntheticTrackMaterializer | null) {
    this.deps.setSyntheticTracks(value)
  }

  protected get motionEventSnapshots(): MotionEventSnapshotCapturer | null {
    return this.deps.motionEventSnapshots()
  }

  protected set motionEventSnapshots(value: MotionEventSnapshotCapturer | null) {
    this.deps.setMotionEventSnapshots(value)
  }

  protected get audioMarkers(): AudioMarkerProjector | null {
    return this.deps.audioMarkers()
  }

  protected set audioMarkers(value: AudioMarkerProjector | null) {
    this.deps.setAudioMarkers(value)
  }

  protected isMotionActive(deviceId: number, atMs: number, quietMs: number): boolean {
    return this.deps.isMotionActive(deviceId, atMs, quietMs)
  }

  protected get identityStore(): IdentityStore | null {
    return this.deps.identityStore()
  }

  protected set identityStore(value: IdentityStore | null) {
    this.deps.setIdentityStore(value)
  }

  protected get faceStore(): FaceStore | null {
    return this.deps.faceStore()
  }

  protected set faceStore(value: FaceStore | null) {
    this.deps.setFaceStore(value)
  }

  protected get plateStore(): PlateStore | null {
    return this.deps.plateStore()
  }

  protected set plateStore(value: PlateStore | null) {
    this.deps.setPlateStore(value)
  }

  protected abstract buildStoresRemainder(
    api: AnalyticsApi,
    logger: IScopedLogger,
    storage: MediaBlobStorage,
    trackStore: TrackStore,
    mediaStore: MediaStore,
    eventLedgerWiring: EventLedgerWiringDeps,
  ): Promise<AnalyticsStores>

  /**
   * Resolves which `eventMedia` location a NEW footage-class blob should be
   * written to (`MediaStoreDeps.resolveEventMediaLocation`). Reflects the
   * location's `mode` (D385) — a location the operator has taken out of the
   * write set never receives new blobs (the relocate mover, exposed as
   * `relocateMedia`, empties what is already on it in the background).
   *
   * Cached after the first successful resolution — this is a per-blob write
   * path, and the write-side provider is a declared no-RPC-per-blob bypass
   * (D-note in `location-aware-media-storage.ts`); re-querying the storage
   * cap on every blob would undo that. Dropped by
   * `refreshStorageLocationsForMigration`, same trigger as
   * `mediaLocationStorage.invalidateRoots()`.
   *
   * Degrades to the bare `eventMedia` type ref (pre-2026-08-26 behaviour)
   * when the storage cap itself is unreachable — a transient RPC failure (or
   * a test harness that never wires `api.storage`) must not turn every media
   * write into a hard failure the way "no writable location" does.
   */
  /**
   * The `storage-occupancy` answer for event media (D388) — bytes HELD on each
   * named location, not bytes retention would be willing to remove.
   *
   * Answered from ONE indexed aggregate per location. A store that is not up
   * yet reports NOTHING, which reads as unknown; it never reports zeros, which
   * would claim the disks are empty. Legacy NULL-stamped rows are attributed by
   * `mediaOccupancyReports`, and bytes it cannot place are LOGGED rather than
   * spread over the candidates — a number no disk agrees with is worse than an
   * absent one.
   */
  async mediaOccupancy(locationIds: readonly string[]): Promise<readonly StorageOccupancyReport[]> {
    const store = this.mediaStore
    if (!store) return []
    const footprint = await store.footprintByLocation(locationIds)
    const { reports, unattributedBytes } = mediaOccupancyReports(footprint, locationIds, Date.now())
    if (unattributedBytes > 0 && !this.mediaOccupancyUnattributedLogged) {
      this.mediaOccupancyUnattributedLogged = true
      this.ctx.logger.warn(
        'pipeline-analytics: event-media bytes could not be attributed to a location — the ' +
          'legacy `eventMedia` type ref resolves to no single location, so they are reported ' +
          'NOWHERE rather than onto a disk that does not hold them',
        { meta: { unattributedBytes, locationIds: [...locationIds] } },
      )
    }
    return reports
  }

  private resolveEventMediaWriteLocation(
    api: AnalyticsApi,
    logger: IScopedLogger,
    deviceId: number,
  ): Promise<string> {
    this.eventMediaWriteLocator ??= new EventMediaWriteLocator({
      list: () => api.storage.listLocations.query({ type: DEFAULT_MEDIA_LOCATION }),
    })
    return this.eventMediaWriteLocator.resolve(logger, deviceId)
  }

  /** Constructs every SQLite-backed store plus the stationary/package-drop/
   *  sensor plumbing, in the exact pre-S7 order. Returns the non-null bundle
   *  so the rest of boot consumes the stores without re-narrowing. */
  async buildStores(
    api: AnalyticsApi,
    logger: IScopedLogger,
    storage: MediaBlobStorage,
  ): Promise<AnalyticsStores> {
    const durableStore = { records: this.requireRecords() }
    const trackStore = new TrackStore({
      store: api.settingsStore,
      logger: logger.child('TrackStore'),
      // Normalized-envelope computation at persist time (zone-filtered query):
      // positions are pixels in the detection-frame space; the latest frame
      // dims per device normalize them. Unknown dims → NULL envelope.
      frameDims: (deviceId) => this.frameState.lastFrameDimsByDevice.get(deviceId),
      // D692: a promotion (or a D665 retraction) reaches the grouped notification
      // windows in the same tick the track learns it.
      onLabelChanged: ({ deviceId, trackId, change, tiers }) =>
        this.notificationCenter?.onTrackLabelChanged({
          deviceId,
          trackId,
          change,
          label: subjectLabelFromTiers(tiers),
        }),
    })
    this.trackStore = trackStore
    this.trackAliasStore = new TrackAliasStore({
      aliasLedger: wireTrackAliasLedger(this.eventLedgerWiring()),
    })
    // D683 review H2: an alias-store lookup that THREW (not "not an alias" —
    // a genuine RPC failure) must never turn a read that used to succeed
    // into a thrown error. Every `resolvingTrackIds`/`resolveMediaOwnerId`
    // call site below reports through this ONE sampled WARN.
    this.aliasResolveFailureLogger = sampledOnce(ALIAS_RESOLVE_FAILURE_MEMO_MAX, (f) => {
      logger.warn('alias resolution failed — reading the id as asked (D315)', {
        ...(f.deviceId !== undefined ? { tags: { deviceId: f.deviceId } } : {}),
        meta: { method: f.method, id: f.id, error: errMsg(f.error) },
      })
    })
    // Parked-object registry. `onChange` is telemetry (D8): emit an appear/
    // depart on the bus so a UI can refresh its dedicated "Stationary" section
    // WITHOUT the object entering the live event feed.
    this.stationaryRegistry = new StationaryObjectRegistry({
      ...durableStore,
      logger: logger.child('StationaryRegistry'),
      // Per-device observed-time TTL (#31) resolved from the live settings cache.
      ttlForDevice: (deviceId) => this.stationarySettingsFromCache(deviceId).entryTtlMs,
      // The entity's key frame goes with the entity (D547).
      onEntryDropped: (entry) => {
        void this.releaseStationaryKeyFrame(entry)
      },
      // A departure has been ARMED and the camera is about to stop looking.
      // The registry decided the look is warranted and sized the ask; whether
      // the camera CAN be looked at belongs to the runner, one addon away.
      requestConfirmationLook: (ask) => this.frameAdmission.requestConfirmationLook(ask),
      onChange: ({ phase, entry, timestamp, observedAt }) => {
        this.ctx.eventBus.emit({
          id: `pa-stationary-${entry.id}-${phase}`,
          timestamp: new Date(timestamp),
          source: {
            type: 'addon',
            id: 'pipeline-analytics',
            addonId: 'pipeline-analytics',
          },
          category: EventCategory.PipelineAnalyticsStationaryChanged,
          data: {
            deviceId: entry.deviceId,
            entryId: entry.id,
            className: entry.className,
            phase,
            timestamp,
            // WHEN IT HAPPENED, beside when we concluded it. A notification
            // anchors its media on this: a departure is confirmed by an
            // independent read that can arrive minutes later (D279), and a clip
            // cut at the conclusion shows an empty space with nothing leaving
            // it — which is what the operator received.
            observedAt,
          },
        })
        // Additive consumer of the SAME appear/depart signal — turns a
        // parked package into delivered / picked-up events. Fire-and-forget
        // (telemetry-lossy, D8); the detector never throws. The detector is
        // constructed just below (after the event store) and is always set
        // before the first live-frame `onChange` fires.
        void this.packageDropDetector?.onStationaryChange({
          phase,
          entry,
          timestamp,
        })
      },
    })
    // Hydrate parked objects from the store so a respawn doesn't re-discover
    // (and re-flood) already-parked cars. Best-effort.
    await this.stationaryRegistry.load()
    // The evidence ledger — where a parked object EARNS its entry. Declared
    // BEFORE any read or write: the SQLite backend answers 412 for an
    // undeclared collection and takes the runner down with it. "loaded 0"
    // after a container recreate is the line that explains why a parked car
    // took another few minutes to come back.
    this.stationaryEvidence = new StationaryEvidenceLedger({
      ...durableStore,
      logger: logger.child('StationaryEvidence'),
    })
    const evidenceLoaded = await this.stationaryEvidence.load()
    logger.info('stationary evidence loaded', {
      meta: { candidates: evidenceLoaded },
    })
    // Phantom-cell memory. Declared BEFORE any read or write: the SQLite
    // backend answers 412 for an undeclared collection and takes the runner
    // down with it. "loaded 0" after a container recreate is the one line that
    // explains why a suppressed cell started spawning again.
    this.phantomCells = new PhantomCellRegistry({
      ...durableStore,
      logger: logger.child('PhantomCells'),
    })
    const phantomCellsLoaded = await this.phantomCells.load()
    logger.info('phantom cells loaded', {
      meta: { cells: phantomCellsLoaded },
    })
    // Package background memory — same contract as the phantom cells above:
    // declared before any touch, and "loaded 0" after a container recreate is
    // the line that explains a returned delivered/picked-up FP loop.
    this.packageBackground = new PackageBackgroundRegistry({
      ...durableStore,
      logger: logger.child('PackageBackground'),
    })
    const packageBackgroundLoaded = await this.packageBackground.load()
    logger.info('package background cells loaded', {
      meta: { cells: packageBackgroundLoaded },
    })
    const mediaStore = new MediaStore({
      storage,
      store: api.settingsStore,
      logger: logger.child('MediaStore'),
      writeGate: this.mediaWriteGate,
      resolveEventMediaLocation: (deviceId) =>
        this.resolveEventMediaWriteLocation(api, logger, deviceId),
    })
    this.mediaStore = mediaStore
    // The location-set doorbell (D387): drop the write-location pick and the
    // resolved roots so a mode change (drain / readonly / disabled) or a repoint
    // reaches the next blob without a restart.
    this.eventMediaWriteLocator ??= new EventMediaWriteLocator({
      list: () => api.storage.listLocations.query({ type: DEFAULT_MEDIA_LOCATION }),
    })
    this.eventMediaLocationDoorbellUnsub?.()
    this.eventMediaLocationDoorbellUnsub = subscribeEventMediaWriteLocator(
      this.ctx.eventBus,
      this.eventMediaWriteLocator,
      () => this.mediaLocationStorage?.invalidateRoots(),
    )
    const eventLedgerWiring = this.eventLedgerWiring()
    return this.buildStoresRemainder(
      api,
      logger,
      storage,
      trackStore,
      mediaStore,
      eventLedgerWiring,
    )
  }
}
