/**
 * Binding cache plus the zone-analytics and audio-metrics cap providers.
 * Moved out of `pipeline-analytics/index.ts` verbatim (Plan B, boot
 * extraction): only the visibility of the entry point changed. Every
 * dependency is read through the deps object.
 */

import type { AddonContext, IScopedLogger, Zone } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { NotificationCenter } from '../../notification-center/index.js'
import { AudioMetricsProvider } from '../audio-metrics-provider.js'
import { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import { BindingCache } from '../runtime/binding-cache.js'
import { DetectionCoverageCache } from '../runtime/detection-coverage-cache.js'
import { AnalyticsHistoryProducer } from '../store/analytics-history-producer.js'
import type { TrackingSettings } from '../tracking-settings.js'
import { ZoneAnalyticsProvider } from '../zone-analytics-provider.js'
import type { AnalyticsApi, AnalyticsCapProviders } from './boot-types.js'

export interface BuildAnalyticsProvidersDeps {
  readonly bindingCache: () => BindingCache | null
  readonly setBindingCache: (value: BindingCache | null) => void
  readonly detectionCoverage: () => DetectionCoverageCache | null
  readonly setDetectionCoverage: (value: DetectionCoverageCache | null) => void
  readonly lts: () => AnalyticsHistoryProducer | null
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly stationaryRegistry: () => StationaryObjectRegistry | null
  readonly resolveDeviceZones: (deviceId: number) => Promise<readonly Zone[]>
  readonly resolveDeviceTrackingSettings: (deviceId: number) => Promise<TrackingSettings>
  readonly notificationCenter: () => NotificationCenter | null
  readonly zoneAnalytics: () => ZoneAnalyticsProvider | null
  readonly setZoneAnalytics: (value: ZoneAnalyticsProvider | null) => void
  readonly readDeviceBlob: (deviceId: number) => Promise<Record<string, unknown>>
  readonly audioMetrics: () => AudioMetricsProvider | null
  readonly setAudioMetrics: (value: AudioMetricsProvider | null) => void
}

export class BuildAnalyticsProviders {
  constructor(protected readonly deps: BuildAnalyticsProvidersDeps) {}

  protected get bindingCache(): BindingCache | null {
    return this.deps.bindingCache()
  }

  protected set bindingCache(value: BindingCache | null) {
    this.deps.setBindingCache(value)
  }

  protected get detectionCoverage(): DetectionCoverageCache | null {
    return this.deps.detectionCoverage()
  }

  protected set detectionCoverage(value: DetectionCoverageCache | null) {
    this.deps.setDetectionCoverage(value)
  }

  protected get lts(): AnalyticsHistoryProducer | null {
    return this.deps.lts()
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get stationaryRegistry(): StationaryObjectRegistry | null {
    return this.deps.stationaryRegistry()
  }

  protected async resolveDeviceZones(deviceId: number): Promise<readonly Zone[]> {
    return this.deps.resolveDeviceZones(deviceId)
  }

  protected async resolveDeviceTrackingSettings(deviceId: number): Promise<TrackingSettings> {
    return this.deps.resolveDeviceTrackingSettings(deviceId)
  }

  protected get notificationCenter(): NotificationCenter | null {
    return this.deps.notificationCenter()
  }

  protected get zoneAnalytics(): ZoneAnalyticsProvider | null {
    return this.deps.zoneAnalytics()
  }

  protected set zoneAnalytics(value: ZoneAnalyticsProvider | null) {
    this.deps.setZoneAnalytics(value)
  }

  protected async readDeviceBlob(deviceId: number): Promise<Record<string, unknown>> {
    return this.deps.readDeviceBlob(deviceId)
  }

  protected get audioMetrics(): AudioMetricsProvider | null {
    return this.deps.audioMetrics()
  }

  protected set audioMetrics(value: AudioMetricsProvider | null) {
    this.deps.setAudioMetrics(value)
  }

  /** Binding cache + the zone-analytics / audio-metrics cap providers. */
  buildAnalyticsProviders(api: AnalyticsApi, logger: IScopedLogger): AnalyticsCapProviders {
    this.bindingCache = new BindingCache({
      api,
      logger: logger.child('BindingCache'),
    })
    this.detectionCoverage = new DetectionCoverageCache({
      api,
      logger: logger.child('DetectionCoverage'),
    })
    const zoneAnalytics = new ZoneAnalyticsProvider({
      logger: logger.child('ZoneAnalytics'),
      // Per-zone and frame-wide occupancy, for EVERY camera — not only the
      // zones some rule happens to watch.
      onOccupancySample: (deviceId, count, at, zoneId) =>
        this.lts?.note('occupancy', deviceId, count, at, zoneId ?? ''),
      fetchDevice: (deviceId) => this.ctx.fetchDevice(deviceId),
      // Announce an occupancy CHANGE so a client can stop asking. This was the
      // one live badge with no push signal at all: the viewer polled
      // `getCurrentSnapshot` every four seconds per visible camera to notice
      // something the provider had already detected. Change-only, so a steady
      // scene emits nothing.
      emitOccupancyChanged: (payload) =>
        this.ctx.eventBus.emit({
          id: `za-occ-${payload.deviceId}-${payload.timestamp}`,
          timestamp: new Date(payload.timestamp),
          source: {
            type: 'addon',
            id: 'pipeline-analytics',
            addonId: 'pipeline-analytics',
          },
          category: EventCategory.ZoneAnalyticsOccupancyChanged,
          data: {
            deviceId: payload.deviceId,
            totalObjects: payload.totalObjects,
            byClass: payload.byClass,
            zones: payload.zones,
          },
        }),
      // Snapshot HYDRATION from the parked-object registry: a fresh respawn or a
      // camera detached between motion sessions has no live frame, yet a lot
      // full of parked cars must not report a `null` occupancy snapshot.
      listStationaryObjects: (deviceId) => this.stationaryRegistry?.listViews(deviceId) ?? [],
      listStationaryDeviceIds: () => this.stationaryRegistry?.deviceIds() ?? [],
      // Resolve zones independent of any live frame so hydrated snapshots +
      // baseline samples attribute parked objects to the right zone. Warms the
      // proxy's zone slice (cold read + refresh) when detached.
      resolveZones: (deviceId) => this.resolveDeviceZones(deviceId),
      // Same Tracking bar the FrameProcessor uses for live stamps — parked
      // hydration / baseline must not invent a second threshold.
      resolveZoneMembershipMinOverlap: async (deviceId) =>
        (await this.resolveDeviceTrackingSettings(deviceId)).zoneMembershipMinOverlap,
      // In-process occupancy tap → the Notification Center watcher. The NC is
      // built AFTER this provider, so read it lazily; a no-op until it exists +
      // gated internally on the evaluation node + enabled occupancy rules.
      onSnapshot: (deviceId, snapshot, evidence) =>
        this.notificationCenter?.observeOccupancy(deviceId, snapshot, evidence),
    })
    this.zoneAnalytics = zoneAnalytics
    const audioMetrics = new AudioMetricsProvider({
      logger: logger.child('AudioMetrics'),
      // The per-camera noise baseline (see `analytics-history-producer.ts`).
      onDbfsSample: (deviceId, avgDbfs, at) => this.lts?.note('audio-dbfs', deviceId, avgDbfs, at),
      fetchDevice: (deviceId) => this.ctx.fetchDevice(deviceId),
      // Per-camera report knobs — operator tunes via the
      // device-settings panel ("Audio metrics reporting" section).
      // Cascade is global default → device override; raw read goes
      // straight through ctx.settings, no kernel round-trip.
      resolveReportSettings: async (deviceId) => {
        const raw = await this.readDeviceBlob(deviceId)
        const enabled =
          typeof raw['audioMetricsReportEnabled'] === 'boolean'
            ? (raw['audioMetricsReportEnabled'] as boolean)
            : true
        const thresholdRaw = raw['audioMetricsReportThresholdDb']
        const thresholdDb =
          typeof thresholdRaw === 'number' && Number.isFinite(thresholdRaw)
            ? Math.max(0, Math.min(10, thresholdRaw))
            : 2
        return { enabled, thresholdDb }
      },
    })
    this.audioMetrics = audioMetrics
    return { zoneAnalytics, audioMetrics }
  }
}
