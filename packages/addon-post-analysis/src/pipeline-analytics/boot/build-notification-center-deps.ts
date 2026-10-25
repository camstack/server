/**
 * Accessors for notification-centre construction. Moved out of
 * `pipeline-analytics/index.ts`
 * verbatim (Plan B, boot extraction): only the visibility of the entry point
 * changed. Every dependency is read through the deps object.
 */

import type { AddonContext } from '@camstack/types'
import { NcArtifactPlane } from '../../notification-center/artifact-plane.js'
import type { ArtifactEndpoint } from '../../notification-center/artifact-url.js'
import type { NcEventMedia, NcEventMediaRequest } from '../../notification-center/dispatcher.js'
import type { NcTimelapseRenderPorts } from '../../notification-center/index.js'
import { NotificationCenter } from '../../notification-center/index.js'
import type { PruneWindows } from '../../notification-center/prune-windows.js'
import type {
  NcRecordedClipRequest,
  NcRecordedClipResult,
} from '../../notification-center/recorded-clip.js'
import type { NcSummaryPorts } from '../../notification-center/summary/summary-producer.js'
import type { DeviceAlertSettings } from '../device-alert-settings.js'
import { DeviceZoneResolver } from '../device-zone-resolver.js'
import { FaceRecognizer } from '../face-recognizer.js'
import { FrameState } from '../frame/frame-state.js'
import { DetectionCoverageCache } from '../runtime/detection-coverage-cache.js'
import { SceneMonitorProvider } from '../scene/scene-monitor-provider.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
import type { AliasResolveFailure } from '../track-alias-resolution.js'
import { ZoneAnalyticsProvider } from '../zone-analytics-provider.js'
import type { AnalyticsApi, AnalyticsStores } from './boot-types.js'

export interface BuildNotificationCenterDeps {
  readonly ctxIfReady: () => AddonContext<Record<string, unknown>> | null
  readonly ctx: () => AddonContext<Record<string, unknown>>
  readonly notificationCenter: () => NotificationCenter | null
  readonly setNotificationCenter: (value: NotificationCenter | null) => void
  readonly pruneWindows: () => Promise<PruneWindows>
  readonly frameState: () => FrameState
  readonly faceRecognizer: () => FaceRecognizer | null
  readonly trackAliasStore: () => TrackAliasStore | null
  readonly cutNotificationRecordedClip: (
    req: NcRecordedClipRequest,
  ) => Promise<NcRecordedClipResult>
  readonly deviceAlertSettingsMirror: () => DeviceAlertSettings
  readonly detectionCoverage: () => DetectionCoverageCache | null
  readonly deviceZones: () => DeviceZoneResolver
  readonly ncArtifactPlane: () => NcArtifactPlane | null
  readonly ncActionMintUrl: () =>
    | ((input: { id: string; expMs: number }) => Promise<string | null>)
    | null
  readonly sceneProvider: () => SceneMonitorProvider | null
  readonly zoneAnalytics: () => ZoneAnalyticsProvider | null
  readonly renderEventMedia: (req: NcEventMediaRequest) => Promise<NcEventMedia>
  readonly ncEndpoints: () => Promise<readonly ArtifactEndpoint[]>
  readonly aliasResolveFailureLogger: () => ((failure: AliasResolveFailure) => void) | null
  readonly isPostProcessingNode: () => boolean
  readonly buildTimelapsePorts: (
    api: AnalyticsApi,
    stores: AnalyticsStores,
  ) => NcTimelapseRenderPorts
  readonly buildSummaryPorts: (api: AnalyticsApi, stores: AnalyticsStores) => NcSummaryPorts
  readonly wireAlarmPanel: (center: NotificationCenter) => void
  readonly serveNcActionPlane: (center: NotificationCenter) => Promise<void>
}

export class BuildNotificationCenterBase {
  constructor(protected readonly deps: BuildNotificationCenterDeps) {}

  protected get ctxIfReady(): AddonContext<Record<string, unknown>> | null {
    return this.deps.ctxIfReady()
  }

  protected get ctx(): AddonContext<Record<string, unknown>> {
    return this.deps.ctx()
  }

  protected get notificationCenter(): NotificationCenter | null {
    return this.deps.notificationCenter()
  }

  protected set notificationCenter(value: NotificationCenter | null) {
    this.deps.setNotificationCenter(value)
  }

  protected async pruneWindows(): Promise<PruneWindows> {
    return this.deps.pruneWindows()
  }

  protected get frameState(): FrameState {
    return this.deps.frameState()
  }

  protected get faceRecognizer(): FaceRecognizer | null {
    return this.deps.faceRecognizer()
  }

  protected get trackAliasStore(): TrackAliasStore | null {
    return this.deps.trackAliasStore()
  }

  protected cutNotificationRecordedClip(req: NcRecordedClipRequest): Promise<NcRecordedClipResult> {
    return this.deps.cutNotificationRecordedClip(req)
  }

  protected get deviceAlertSettingsMirror(): DeviceAlertSettings {
    return this.deps.deviceAlertSettingsMirror()
  }

  protected get detectionCoverage(): DetectionCoverageCache | null {
    return this.deps.detectionCoverage()
  }

  protected get deviceZones(): DeviceZoneResolver {
    return this.deps.deviceZones()
  }

  protected get ncArtifactPlane(): NcArtifactPlane | null {
    return this.deps.ncArtifactPlane()
  }

  protected get ncActionMintUrl():
    | ((input: { id: string; expMs: number }) => Promise<string | null>)
    | null {
    return this.deps.ncActionMintUrl()
  }

  protected get sceneProvider(): SceneMonitorProvider | null {
    return this.deps.sceneProvider()
  }

  protected get zoneAnalytics(): ZoneAnalyticsProvider | null {
    return this.deps.zoneAnalytics()
  }

  protected async renderEventMedia(req: NcEventMediaRequest): Promise<NcEventMedia> {
    return this.deps.renderEventMedia(req)
  }

  protected async ncEndpoints(): Promise<readonly ArtifactEndpoint[]> {
    return this.deps.ncEndpoints()
  }

  protected get aliasResolveFailureLogger(): ((failure: AliasResolveFailure) => void) | null {
    return this.deps.aliasResolveFailureLogger()
  }

  protected get isPostProcessingNode(): boolean {
    return this.deps.isPostProcessingNode()
  }

  protected buildTimelapsePorts(
    api: AnalyticsApi,
    stores: AnalyticsStores,
  ): NcTimelapseRenderPorts {
    return this.deps.buildTimelapsePorts(api, stores)
  }

  protected buildSummaryPorts(api: AnalyticsApi, stores: AnalyticsStores): NcSummaryPorts {
    return this.deps.buildSummaryPorts(api, stores)
  }

  protected wireAlarmPanel(center: NotificationCenter): void {
    return this.deps.wireAlarmPanel(center)
  }

  protected async serveNcActionPlane(center: NotificationCenter): Promise<void> {
    return this.deps.serveNcActionPlane(center)
  }
}
