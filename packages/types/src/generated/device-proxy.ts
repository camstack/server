// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { InferDeviceProxyCap, InferRuntimeState } from '../capabilities/capability-definition.js'
import type { DeviceBinding } from '../device/device-binding.js'
import { createSliceHandle, createLazyTrpcSource, type SliceHandle, type SliceHandleSource } from '../device/device-state-handle.js'
import { addonSliceHandleApi } from '../helpers/addon-slice-handle.js'
import { invokeTrpcLeaf, type TrpcDispatchKind } from '../helpers/trpc-leaf.js'
import type { AddonApi } from './addon-api.js'
import type { accessoriesCapability } from '../capabilities/accessories.cap.js'
import type { airQualitySensorCapability } from '../capabilities/air-quality-sensor.cap.js'
import type { alarmPanelCapability } from '../capabilities/alarm-panel.cap.js'
import type { ambientLightSensorCapability } from '../capabilities/ambient-light-sensor.cap.js'
import type { audioAnalysisCapability } from '../capabilities/audio-analysis.cap.js'
import type { audioMetricsCapability } from '../capabilities/audio-metrics.cap.js'
import type { automationControlCapability } from '../capabilities/automation-control.cap.js'
import type { batteryCapability } from '../capabilities/battery.cap.js'
import type { binaryCapability } from '../capabilities/binary.cap.js'
import type { brightnessCapability } from '../capabilities/brightness.cap.js'
import type { buttonCapability } from '../capabilities/button.cap.js'
import type { cameraCredentialsCapability } from '../capabilities/camera-credentials.cap.js'
import type { cameraGridLayoutCapability } from '../capabilities/camera-grid-layout.cap.js'
import type { cameraPipelineConfigCapability } from '../capabilities/camera-pipeline-config.cap.js'
import type { cameraStreamsCapability } from '../capabilities/camera-streams.cap.js'
import type { carbonMonoxideCapability } from '../capabilities/carbon-monoxide.cap.js'
import type { climateControlCapability } from '../capabilities/climate-control.cap.js'
import type { colorCapability } from '../capabilities/color.cap.js'
import type { connectivityCapability } from '../capabilities/connectivity.cap.js'
import type { consumablesCapability } from '../capabilities/consumables.cap.js'
import type { contactCapability } from '../capabilities/contact.cap.js'
import type { controlCapability } from '../capabilities/control.cap.js'
import type { coverCapability } from '../capabilities/cover.cap.js'
import type { dayNightCapability } from '../capabilities/day-night.cap.js'
import type { detectionPipelineCapability } from '../capabilities/detection-pipeline.cap.js'
import type { deviceAdminLinkCapability } from '../capabilities/device-admin-link.cap.js'
import type { deviceDiscoveryCapability } from '../capabilities/device-discovery.cap.js'
import type { deviceExtensionCapability } from '../capabilities/device-extension.cap.js'
import type { deviceOpsCapability } from '../capabilities/device-ops.cap.js'
import type { deviceStatusCapability } from '../capabilities/device-status.cap.js'
import type { dishwasherCapability } from '../capabilities/dishwasher.cap.js'
import type { doorbellCapability } from '../capabilities/doorbell.cap.js'
import type { enumSensorCapability } from '../capabilities/enum-sensor.cap.js'
import type { eventEmitterCapability } from '../capabilities/event-emitter.cap.js'
import type { fanControlCapability } from '../capabilities/fan-control.cap.js'
import type { featureProbeCapability } from '../capabilities/feature-probe.cap.js'
import type { floodCapability } from '../capabilities/flood.cap.js'
import type { gasCapability } from '../capabilities/gas.cap.js'
import type { groupActiveCapability } from '../capabilities/group-active.cap.js'
import type { groupCommandsCapability } from '../capabilities/group-commands.cap.js'
import type { groupStatusCapability } from '../capabilities/group-status.cap.js'
import type { heatingValveCapability } from '../capabilities/heating-valve.cap.js'
import type { humidifierCapability } from '../capabilities/humidifier.cap.js'
import type { humiditySensorCapability } from '../capabilities/humidity-sensor.cap.js'
import type { imageCapability } from '../capabilities/image.cap.js'
import type { imageSettingsCapability } from '../capabilities/image-settings.cap.js'
import type { intercomCapability } from '../capabilities/intercom.cap.js'
import type { lawnMowerControlCapability } from '../capabilities/lawn-mower-control.cap.js'
import type { lockControlCapability } from '../capabilities/lock-control.cap.js'
import type { mediaPlayerCapability } from '../capabilities/media-player.cap.js'
import type { meterCapability } from '../capabilities/meter.cap.js'
import type { motionCapability } from '../capabilities/motion.cap.js'
import type { motionDetectionCapability } from '../capabilities/motion-detection.cap.js'
import type { motionTriggerCapability } from '../capabilities/motion-trigger.cap.js'
import type { motionZonesCapability } from '../capabilities/motion-zones.cap.js'
import type { nativeObjectDetectionCapability } from '../capabilities/native-object-detection.cap.js'
import type { navigationCapability } from '../capabilities/navigation.cap.js'
import type { networkLinkCapability } from '../capabilities/network-link.cap.js'
import type { notifierCapability } from '../capabilities/notifier.cap.js'
import type { numericSensorCapability } from '../capabilities/numeric-sensor.cap.js'
import type { osdCapability } from '../capabilities/osd.cap.js'
import type { petFeederCapability } from '../capabilities/pet-feeder.cap.js'
import type { pipelineAnalyticsCapability } from '../capabilities/pipeline-analytics.cap.js'
import type { powerMeterCapability } from '../capabilities/power-meter.cap.js'
import type { presenceCapability } from '../capabilities/presence.cap.js'
import type { pressureSensorCapability } from '../capabilities/pressure-sensor.cap.js'
import type { privacyMaskCapability } from '../capabilities/privacy-mask.cap.js'
import type { ptzCapability } from '../capabilities/ptz.cap.js'
import type { ptzAutotrackCapability } from '../capabilities/ptz-autotrack.cap.js'
import type { rebootCapability } from '../capabilities/reboot.cap.js'
import type { recordingCapability } from '../capabilities/recording.cap.js'
import type { recordingOnboardCapability } from '../capabilities/recording-onboard.cap.js'
import type { recordingSignalCapability } from '../capabilities/recording-signal.cap.js'
import type { runningStateCapability } from '../capabilities/running-state.cap.js'
import type { sceneMonitorCapability } from '../capabilities/scene-monitor.cap.js'
import type { scriptRunnerCapability } from '../capabilities/script-runner.cap.js'
import type { smokeCapability } from '../capabilities/smoke.cap.js'
import type { snapshotCapability } from '../capabilities/snapshot.cap.js'
import type { streamCatalogCapability } from '../capabilities/stream-catalog.cap.js'
import type { streamParamsCapability } from '../capabilities/stream-params.cap.js'
import type { streamSignalsCapability } from '../capabilities/stream-signals.cap.js'
import type { switchCapability } from '../capabilities/switch.cap.js'
import type { tamperCapability } from '../capabilities/tamper.cap.js'
import type { temperatureSensorCapability } from '../capabilities/temperature-sensor.cap.js'
import type { updateCapability } from '../capabilities/update.cap.js'
import type { vacuumControlCapability } from '../capabilities/vacuum-control.cap.js'
import type { valveCapability } from '../capabilities/valve.cap.js'
import type { vibrationCapability } from '../capabilities/vibration.cap.js'
import type { videoclipsCapability } from '../capabilities/videoclips.cap.js'
import type { waterHeaterCapability } from '../capabilities/water-heater.cap.js'
import type { weatherCapability } from '../capabilities/weather.cap.js'
import type { webrtcSessionCapability } from '../capabilities/webrtc-session.cap.js'
import type { zoneAnalyticsCapability } from '../capabilities/zone-analytics.cap.js'
import type { zoneRulesCapability } from '../capabilities/zone-rules.cap.js'
import type { zonesCapability } from '../capabilities/zones.cap.js'
import type { actionsCapability } from '../capabilities/actions.cap.js'
import type { addonSettingsCapability } from '../capabilities/addon-settings.cap.js'
import type { audioAnalyzerCapability } from '../capabilities/audio-analyzer.cap.js'
import type { deviceAdoptionCapability } from '../capabilities/device-adoption.cap.js'
import type { deviceExportCapability } from '../capabilities/device-export.cap.js'
import type { deviceHistoryCapability } from '../capabilities/device-history.cap.js'
import type { deviceManagerCapability } from '../capabilities/device-manager.cap.js'
import type { deviceStateCapability } from '../capabilities/device-state.cap.js'
import type { faceGalleryCapability } from '../capabilities/face-gallery.cap.js'
import type { networkQualityCapability } from '../capabilities/network-quality.cap.js'
import type { notificationRulesCapability } from '../capabilities/notification-rules.cap.js'
import type { osdManagerCapability } from '../capabilities/osd-manager.cap.js'
import type { pipelineExecutorCapability } from '../capabilities/pipeline-executor.cap.js'
import type { pipelineOrchestratorCapability } from '../capabilities/pipeline-orchestrator.cap.js'
import type { pipelineRunnerCapability } from '../capabilities/pipeline-runner.cap.js'
import type { plateGalleryCapability } from '../capabilities/plate-gallery.cap.js'
import type { recordingArchiveCapability } from '../capabilities/recording-archive.cap.js'
import type { recordingExportCapability } from '../capabilities/recording-export.cap.js'
import type { streamBrokerCapability } from '../capabilities/stream-broker.cap.js'

/**
 * Reactive read handle bag for device runtime state. Each entry mirrors the
 * cap's `runtimeState` schema and stays live via the `device-state` cap's
 * `onChanged` event. See `device-state-handle.ts` for the contract.
 */
export interface DeviceProxyState {
  readonly airQualitySensor: SliceHandle<InferRuntimeState<typeof airQualitySensorCapability>>
  readonly alarmPanel: SliceHandle<InferRuntimeState<typeof alarmPanelCapability>>
  readonly ambientLightSensor: SliceHandle<InferRuntimeState<typeof ambientLightSensorCapability>>
  readonly audioMetrics: SliceHandle<InferRuntimeState<typeof audioMetricsCapability>>
  readonly automationControl: SliceHandle<InferRuntimeState<typeof automationControlCapability>>
  readonly battery: SliceHandle<InferRuntimeState<typeof batteryCapability>>
  readonly binary: SliceHandle<InferRuntimeState<typeof binaryCapability>>
  readonly brightness: SliceHandle<InferRuntimeState<typeof brightnessCapability>>
  readonly cameraStreams: SliceHandle<InferRuntimeState<typeof cameraStreamsCapability>>
  readonly carbonMonoxide: SliceHandle<InferRuntimeState<typeof carbonMonoxideCapability>>
  readonly climateControl: SliceHandle<InferRuntimeState<typeof climateControlCapability>>
  readonly color: SliceHandle<InferRuntimeState<typeof colorCapability>>
  readonly connectivity: SliceHandle<InferRuntimeState<typeof connectivityCapability>>
  readonly consumables: SliceHandle<InferRuntimeState<typeof consumablesCapability>>
  readonly contact: SliceHandle<InferRuntimeState<typeof contactCapability>>
  readonly control: SliceHandle<InferRuntimeState<typeof controlCapability>>
  readonly cover: SliceHandle<InferRuntimeState<typeof coverCapability>>
  readonly dayNight: SliceHandle<InferRuntimeState<typeof dayNightCapability>>
  readonly deviceDiscovery: SliceHandle<InferRuntimeState<typeof deviceDiscoveryCapability>>
  readonly deviceStatus: SliceHandle<InferRuntimeState<typeof deviceStatusCapability>>
  readonly dishwasher: SliceHandle<InferRuntimeState<typeof dishwasherCapability>>
  readonly doorbell: SliceHandle<InferRuntimeState<typeof doorbellCapability>>
  readonly enumSensor: SliceHandle<InferRuntimeState<typeof enumSensorCapability>>
  readonly eventEmitter: SliceHandle<InferRuntimeState<typeof eventEmitterCapability>>
  readonly fanControl: SliceHandle<InferRuntimeState<typeof fanControlCapability>>
  readonly featureProbe: SliceHandle<InferRuntimeState<typeof featureProbeCapability>>
  readonly flood: SliceHandle<InferRuntimeState<typeof floodCapability>>
  readonly gas: SliceHandle<InferRuntimeState<typeof gasCapability>>
  readonly groupActive: SliceHandle<InferRuntimeState<typeof groupActiveCapability>>
  readonly groupCommands: SliceHandle<InferRuntimeState<typeof groupCommandsCapability>>
  readonly groupStatus: SliceHandle<InferRuntimeState<typeof groupStatusCapability>>
  readonly heatingValve: SliceHandle<InferRuntimeState<typeof heatingValveCapability>>
  readonly humidifier: SliceHandle<InferRuntimeState<typeof humidifierCapability>>
  readonly humiditySensor: SliceHandle<InferRuntimeState<typeof humiditySensorCapability>>
  readonly image: SliceHandle<InferRuntimeState<typeof imageCapability>>
  readonly imageSettings: SliceHandle<InferRuntimeState<typeof imageSettingsCapability>>
  readonly intercom: SliceHandle<InferRuntimeState<typeof intercomCapability>>
  readonly lawnMowerControl: SliceHandle<InferRuntimeState<typeof lawnMowerControlCapability>>
  readonly lockControl: SliceHandle<InferRuntimeState<typeof lockControlCapability>>
  readonly mediaPlayer: SliceHandle<InferRuntimeState<typeof mediaPlayerCapability>>
  readonly meter: SliceHandle<InferRuntimeState<typeof meterCapability>>
  readonly motion: SliceHandle<InferRuntimeState<typeof motionCapability>>
  readonly motionTrigger: SliceHandle<InferRuntimeState<typeof motionTriggerCapability>>
  readonly motionZones: SliceHandle<InferRuntimeState<typeof motionZonesCapability>>
  readonly nativeObjectDetection: SliceHandle<InferRuntimeState<typeof nativeObjectDetectionCapability>>
  readonly navigation: SliceHandle<InferRuntimeState<typeof navigationCapability>>
  readonly networkLink: SliceHandle<InferRuntimeState<typeof networkLinkCapability>>
  readonly notifier: SliceHandle<InferRuntimeState<typeof notifierCapability>>
  readonly numericSensor: SliceHandle<InferRuntimeState<typeof numericSensorCapability>>
  readonly petFeeder: SliceHandle<InferRuntimeState<typeof petFeederCapability>>
  readonly powerMeter: SliceHandle<InferRuntimeState<typeof powerMeterCapability>>
  readonly presence: SliceHandle<InferRuntimeState<typeof presenceCapability>>
  readonly pressureSensor: SliceHandle<InferRuntimeState<typeof pressureSensorCapability>>
  readonly privacyMask: SliceHandle<InferRuntimeState<typeof privacyMaskCapability>>
  readonly ptzAutotrack: SliceHandle<InferRuntimeState<typeof ptzAutotrackCapability>>
  readonly recordingOnboard: SliceHandle<InferRuntimeState<typeof recordingOnboardCapability>>
  readonly recordingSignal: SliceHandle<InferRuntimeState<typeof recordingSignalCapability>>
  readonly runningState: SliceHandle<InferRuntimeState<typeof runningStateCapability>>
  readonly sceneMonitor: SliceHandle<InferRuntimeState<typeof sceneMonitorCapability>>
  readonly scriptRunner: SliceHandle<InferRuntimeState<typeof scriptRunnerCapability>>
  readonly smoke: SliceHandle<InferRuntimeState<typeof smokeCapability>>
  readonly streamCatalog: SliceHandle<InferRuntimeState<typeof streamCatalogCapability>>
  readonly streamParams: SliceHandle<InferRuntimeState<typeof streamParamsCapability>>
  readonly streamSignals: SliceHandle<InferRuntimeState<typeof streamSignalsCapability>>
  readonly switch: SliceHandle<InferRuntimeState<typeof switchCapability>>
  readonly tamper: SliceHandle<InferRuntimeState<typeof tamperCapability>>
  readonly temperatureSensor: SliceHandle<InferRuntimeState<typeof temperatureSensorCapability>>
  readonly update: SliceHandle<InferRuntimeState<typeof updateCapability>>
  readonly vacuumControl: SliceHandle<InferRuntimeState<typeof vacuumControlCapability>>
  readonly valve: SliceHandle<InferRuntimeState<typeof valveCapability>>
  readonly vibration: SliceHandle<InferRuntimeState<typeof vibrationCapability>>
  readonly waterHeater: SliceHandle<InferRuntimeState<typeof waterHeaterCapability>>
  readonly weather: SliceHandle<InferRuntimeState<typeof weatherCapability>>
  readonly zoneAnalytics: SliceHandle<InferRuntimeState<typeof zoneAnalyticsCapability>>
  readonly zoneRules: SliceHandle<InferRuntimeState<typeof zoneRulesCapability>>
  readonly zones: SliceHandle<InferRuntimeState<typeof zonesCapability>>
}

/**
 * Unified per-device proxy interface. Each optional property is present at
 * runtime only when the device's binding includes that capability.
 *
 * The optional `binding` field is populated post-construction by callers
 * that own a binding cache (e.g. the SDK's `System` mirror). Consumers
 * that need the full per-device binding map can read it from there
 * without paying for a second `getBindings` round-trip — see Phase 5
 * dedup notes in `scripts/generate-device-proxy.ts`.
 */
export interface DeviceProxy {
  readonly deviceId: number
  /** Reactive runtime state, one slot per cap that declares `runtimeState`. */
  readonly state: DeviceProxyState
  /** Resolved binding entry list (or null if the proxy was constructed
   *  without a cache-aware caller — defaults to null since
   *  `createDeviceProxy` itself does not own the binding). */
  readonly binding: DeviceBinding | null
  readonly accessories?: InferDeviceProxyCap<typeof accessoriesCapability>
  readonly airQualitySensor?: InferDeviceProxyCap<typeof airQualitySensorCapability>
  readonly alarmPanel?: InferDeviceProxyCap<typeof alarmPanelCapability>
  readonly ambientLightSensor?: InferDeviceProxyCap<typeof ambientLightSensorCapability>
  readonly audioAnalysis?: InferDeviceProxyCap<typeof audioAnalysisCapability>
  readonly audioMetrics?: InferDeviceProxyCap<typeof audioMetricsCapability>
  readonly automationControl?: InferDeviceProxyCap<typeof automationControlCapability>
  readonly battery?: InferDeviceProxyCap<typeof batteryCapability>
  readonly binary?: InferDeviceProxyCap<typeof binaryCapability>
  readonly brightness?: InferDeviceProxyCap<typeof brightnessCapability>
  readonly button?: InferDeviceProxyCap<typeof buttonCapability>
  readonly cameraCredentials?: InferDeviceProxyCap<typeof cameraCredentialsCapability>
  readonly cameraGridLayout?: InferDeviceProxyCap<typeof cameraGridLayoutCapability>
  readonly cameraPipelineConfig?: InferDeviceProxyCap<typeof cameraPipelineConfigCapability>
  readonly cameraStreams?: InferDeviceProxyCap<typeof cameraStreamsCapability>
  readonly carbonMonoxide?: InferDeviceProxyCap<typeof carbonMonoxideCapability>
  readonly climateControl?: InferDeviceProxyCap<typeof climateControlCapability>
  readonly color?: InferDeviceProxyCap<typeof colorCapability>
  readonly connectivity?: InferDeviceProxyCap<typeof connectivityCapability>
  readonly consumables?: InferDeviceProxyCap<typeof consumablesCapability>
  readonly contact?: InferDeviceProxyCap<typeof contactCapability>
  readonly control?: InferDeviceProxyCap<typeof controlCapability>
  readonly cover?: InferDeviceProxyCap<typeof coverCapability>
  readonly dayNight?: InferDeviceProxyCap<typeof dayNightCapability>
  readonly detectionPipeline?: InferDeviceProxyCap<typeof detectionPipelineCapability>
  readonly deviceAdminLink?: InferDeviceProxyCap<typeof deviceAdminLinkCapability>
  readonly deviceDiscovery?: InferDeviceProxyCap<typeof deviceDiscoveryCapability>
  readonly deviceExtension?: InferDeviceProxyCap<typeof deviceExtensionCapability>
  readonly deviceOps?: InferDeviceProxyCap<typeof deviceOpsCapability>
  readonly deviceStatus?: InferDeviceProxyCap<typeof deviceStatusCapability>
  readonly dishwasher?: InferDeviceProxyCap<typeof dishwasherCapability>
  readonly doorbell?: InferDeviceProxyCap<typeof doorbellCapability>
  readonly enumSensor?: InferDeviceProxyCap<typeof enumSensorCapability>
  readonly eventEmitter?: InferDeviceProxyCap<typeof eventEmitterCapability>
  readonly fanControl?: InferDeviceProxyCap<typeof fanControlCapability>
  readonly featureProbe?: InferDeviceProxyCap<typeof featureProbeCapability>
  readonly flood?: InferDeviceProxyCap<typeof floodCapability>
  readonly gas?: InferDeviceProxyCap<typeof gasCapability>
  readonly groupActive?: InferDeviceProxyCap<typeof groupActiveCapability>
  readonly groupCommands?: InferDeviceProxyCap<typeof groupCommandsCapability>
  readonly groupStatus?: InferDeviceProxyCap<typeof groupStatusCapability>
  readonly heatingValve?: InferDeviceProxyCap<typeof heatingValveCapability>
  readonly humidifier?: InferDeviceProxyCap<typeof humidifierCapability>
  readonly humiditySensor?: InferDeviceProxyCap<typeof humiditySensorCapability>
  readonly image?: InferDeviceProxyCap<typeof imageCapability>
  readonly imageSettings?: InferDeviceProxyCap<typeof imageSettingsCapability>
  readonly intercom?: InferDeviceProxyCap<typeof intercomCapability>
  readonly lawnMowerControl?: InferDeviceProxyCap<typeof lawnMowerControlCapability>
  readonly lockControl?: InferDeviceProxyCap<typeof lockControlCapability>
  readonly mediaPlayer?: InferDeviceProxyCap<typeof mediaPlayerCapability>
  readonly meter?: InferDeviceProxyCap<typeof meterCapability>
  readonly motion?: InferDeviceProxyCap<typeof motionCapability>
  readonly motionDetection?: InferDeviceProxyCap<typeof motionDetectionCapability>
  readonly motionTrigger?: InferDeviceProxyCap<typeof motionTriggerCapability>
  readonly motionZones?: InferDeviceProxyCap<typeof motionZonesCapability>
  readonly nativeObjectDetection?: InferDeviceProxyCap<typeof nativeObjectDetectionCapability>
  readonly navigation?: InferDeviceProxyCap<typeof navigationCapability>
  readonly networkLink?: InferDeviceProxyCap<typeof networkLinkCapability>
  readonly notifier?: InferDeviceProxyCap<typeof notifierCapability>
  readonly numericSensor?: InferDeviceProxyCap<typeof numericSensorCapability>
  readonly osd?: InferDeviceProxyCap<typeof osdCapability>
  readonly petFeeder?: InferDeviceProxyCap<typeof petFeederCapability>
  readonly pipelineAnalytics?: InferDeviceProxyCap<typeof pipelineAnalyticsCapability>
  readonly powerMeter?: InferDeviceProxyCap<typeof powerMeterCapability>
  readonly presence?: InferDeviceProxyCap<typeof presenceCapability>
  readonly pressureSensor?: InferDeviceProxyCap<typeof pressureSensorCapability>
  readonly privacyMask?: InferDeviceProxyCap<typeof privacyMaskCapability>
  readonly ptz?: InferDeviceProxyCap<typeof ptzCapability>
  readonly ptzAutotrack?: InferDeviceProxyCap<typeof ptzAutotrackCapability>
  readonly reboot?: InferDeviceProxyCap<typeof rebootCapability>
  readonly recording?: InferDeviceProxyCap<typeof recordingCapability>
  readonly recordingOnboard?: InferDeviceProxyCap<typeof recordingOnboardCapability>
  readonly recordingSignal?: InferDeviceProxyCap<typeof recordingSignalCapability>
  readonly runningState?: InferDeviceProxyCap<typeof runningStateCapability>
  readonly sceneMonitor?: InferDeviceProxyCap<typeof sceneMonitorCapability>
  readonly scriptRunner?: InferDeviceProxyCap<typeof scriptRunnerCapability>
  readonly smoke?: InferDeviceProxyCap<typeof smokeCapability>
  readonly snapshot?: InferDeviceProxyCap<typeof snapshotCapability>
  readonly streamCatalog?: InferDeviceProxyCap<typeof streamCatalogCapability>
  readonly streamParams?: InferDeviceProxyCap<typeof streamParamsCapability>
  readonly streamSignals?: InferDeviceProxyCap<typeof streamSignalsCapability>
  readonly switch?: InferDeviceProxyCap<typeof switchCapability>
  readonly tamper?: InferDeviceProxyCap<typeof tamperCapability>
  readonly temperatureSensor?: InferDeviceProxyCap<typeof temperatureSensorCapability>
  readonly update?: InferDeviceProxyCap<typeof updateCapability>
  readonly vacuumControl?: InferDeviceProxyCap<typeof vacuumControlCapability>
  readonly valve?: InferDeviceProxyCap<typeof valveCapability>
  readonly vibration?: InferDeviceProxyCap<typeof vibrationCapability>
  readonly videoclips?: InferDeviceProxyCap<typeof videoclipsCapability>
  readonly waterHeater?: InferDeviceProxyCap<typeof waterHeaterCapability>
  readonly weather?: InferDeviceProxyCap<typeof weatherCapability>
  readonly webrtcSession?: InferDeviceProxyCap<typeof webrtcSessionCapability>
  readonly zoneAnalytics?: InferDeviceProxyCap<typeof zoneAnalyticsCapability>
  readonly zoneRules?: InferDeviceProxyCap<typeof zoneRulesCapability>
  readonly zones?: InferDeviceProxyCap<typeof zonesCapability>
  readonly actions: Pick<InferDeviceProxyCap<typeof actionsCapability>, 'get' | 'run' | 'listForCamera' | 'getLinks'>
  readonly addonSettings: Pick<InferDeviceProxyCap<typeof addonSettingsCapability>, 'getDeviceSettings' | 'updateDeviceSettings'>
  readonly audioAnalyzer: Pick<InferDeviceProxyCap<typeof audioAnalyzerCapability>, 'detachDevice'>
  readonly deviceAdoption: Pick<InferDeviceProxyCap<typeof deviceAdoptionCapability>, 'getStatus'>
  readonly deviceExport: Pick<InferDeviceProxyCap<typeof deviceExportCapability>, 'getDeviceSettingsContribution' | 'getDeviceLiveContribution' | 'applyDeviceSettingsPatch'>
  readonly deviceHistory: Pick<InferDeviceProxyCap<typeof deviceHistoryCapability>, 'listSeries' | 'query' | 'getDeviceEnabled' | 'setDeviceEnabled'>
  readonly deviceManager: Pick<InferDeviceProxyCap<typeof deviceManagerCapability>, 'loadConfig' | 'loadRuntimeState' | 'loadMeta' | 'setName' | 'setLocation' | 'setType' | 'setIntegrationId' | 'setLinkDeviceId' | 'setPrimaryChildEntityId' | 'setChildLayout' | 'setDisplay' | 'getWireableFields' | 'setRole' | 'applyInitialMeta' | 'setMetadata' | 'setDisabled' | 'getDevice' | 'getLinkedDevices' | 'getStreamSources' | 'getConfigSchema' | 'getSettingsSchema' | 'updateConfig' | 'enable' | 'disable' | 'remove' | 'getStreamProfileMap' | 'setStreamProfileMap' | 'probeStreams' | 'getBindings' | 'setWrapperActive' | 'getWrapperActivation' | 'getDeviceSettingsAggregate' | 'getDeviceLiveInfoAggregate' | 'getDeviceAggregate' | 'runDeviceAction' | 'updateDeviceField' | 'updateDeviceFieldsBatch' | 'testField' | 'getDeviceStatusAggregate'>
  readonly deviceState: Pick<InferDeviceProxyCap<typeof deviceStateCapability>, 'getSnapshot' | 'getCapSlice' | 'setCapSlice' | 'claimFields' | 'patchOwnedFields' | 'releaseClaim' | 'getNativeCapSlice'>
  readonly faceGallery: Pick<InferDeviceProxyCap<typeof faceGalleryCapability>, 'listRecentFaces' | 'getFaceByTrack'>
  readonly networkQuality: Pick<InferDeviceProxyCap<typeof networkQualityCapability>, 'getDeviceStats' | 'reportClientStats'>
  readonly notificationRules: Pick<InferDeviceProxyCap<typeof notificationRulesCapability>, 'setDeviceMuted'>
  readonly osdManager: Pick<InferDeviceProxyCap<typeof osdManagerCapability>, 'getDeviceOsd' | 'getSourceCatalog' | 'setSlotBinding' | 'clearSlotBinding' | 'setSlotCameraEnabled' | 'previewSlot' | 'renderDevice'>
  readonly pipelineExecutor: Pick<InferDeviceProxyCap<typeof pipelineExecutorCapability>, 'runPipeline' | 'runPipelineBatch'>
  readonly pipelineOrchestrator: Pick<InferDeviceProxyCap<typeof pipelineOrchestratorCapability>, 'assignPipeline' | 'unassignPipeline' | 'setPipelineDevicePin' | 'getPipelineDevicePin' | 'getPipelineAssignment' | 'getCameraMetrics' | 'assignAudio' | 'unassignAudio' | 'getAudioAssignment' | 'getCameraSettings' | 'setCameraStepToggle' | 'getCameraDetectionSource' | 'setCameraDetectionSource' | 'setCameraStepSettings' | 'resolvePipeline' | 'getCameraSwitches' | 'setCameraSwitch' | 'getCameraStatus' | 'getDeviceSettingsContribution' | 'getDeviceLiveContribution' | 'applyDeviceSettingsPatch'>
  readonly pipelineRunner: Pick<InferDeviceProxyCap<typeof pipelineRunnerCapability>, 'detachCamera' | 'getCameraMetrics' | 'requestOccupancyBurst' | 'runDetailSubtree' | 'parkTrackFrame' | 'getParkedTrackFrame' | 'releaseParkedTrackFrames'>
  readonly plateGallery: Pick<InferDeviceProxyCap<typeof plateGalleryCapability>, 'listPlates' | 'getPlateByTrack'>
  readonly recordingArchive: Pick<InferDeviceProxyCap<typeof recordingArchiveCapability>, 'getDeviceConfig' | 'locateSegment' | 'readSegmentBytes' | 'readGopBytes' | 'readWindowBytes' | 'setDeviceConfig' | 'rescanStorage' | 'pruneFootage' | 'deleteFootprint' | 'renderGif' | 'renderClip' | 'getStatus' | 'getDeviceSettingsContribution' | 'getDeviceLiveContribution' | 'applyDeviceSettingsPatch'>
  readonly recordingExport: Pick<InferDeviceProxyCap<typeof recordingExportCapability>, 'listExports'>
  readonly streamBroker: Pick<InferDeviceProxyCap<typeof streamBrokerCapability>, 'reportStreamSignal' | 'publishCameraStream' | 'retractCameraStream' | 'assignProfile' | 'unassignProfile' | 'forgetDeviceHardware' | 'renderPreBufferClip' | 'produceEventMedia' | 'restartProfile' | 'getDeviceAudioMute' | 'setDeviceAudioMute' | 'getDeviceSettingsContribution' | 'getDeviceLiveContribution' | 'applyDeviceSettingsPatch'>
}

/**
 * Build a DeviceProxy that pre-binds deviceId + nodeId on every method call
 * and dispatches through the existing cap-router tRPC procedures.
 *
 * Optional `opts.stateSource` lets a SystemManager pass a shared mirror
 * source so every device proxy reads from the same in-memory map and
 * shares the warm-boot/push-event update loop. When omitted, a per-proxy
 * lazy tRPC source is created — the path used by `ctx.fetchDevice` and
 * `BackendClient.fetchDevice` for one-off reads.
 *
 * The returned proxy's `binding` field is set to the input `binding`
 * by default — callers that want to expose a different value (e.g. the
 * SDK's `System` patches it from a shared cache) can overwrite the
 * field on the returned object.
 */
export function createDeviceProxy(
  api: AddonApi,
  binding: DeviceBinding,
  opts?: { stateSource?: SliceHandleSource },
): DeviceProxy {
  // Default lazy source: builds its own cache + bridge on first watch().
  // The SystemManager passes a shared mirror source instead.
  const stateSource: SliceHandleSource = opts?.stateSource
    ?? createLazyTrpcSource(addonSliceHandleApi(api))

  // ── Dispatch helpers ────────────────────────────────────────────────
  //
  // Every per-cap method below collapses to a single `dispatch(...)` /
  // `dispatchSystem(...)` call. The helpers handle three concerns
  // uniformly so the per-method code reads as a one-line declaration of
  // intent (cap + method + kind) rather than 25 lines of plumbing.
  type Kind = TrpcDispatchKind

  /** Merge `{deviceId, nodeId?}` into the caller-supplied input. */
  function mergeInput(input: unknown, nodeId: string | undefined): Record<string, unknown> {
    const base = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    return nodeId !== undefined
      ? { ...base, deviceId: binding.deviceId, nodeId }
      : { ...base, deviceId: binding.deviceId }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callLeaf(capProp: string, method: string, kind: Kind, merged: unknown, push: unknown): any {
    return invokeTrpcLeaf(api, capProp, method, kind, merged, push)
  }

  /**
   * Device-scoped cap dispatch. Looks up the binding entry for `capName`
   * to pin the call to the worker that owns the per-device provider; when
   * no entry exists (cluster-wide singletons like `zones` /
   * `zone-rules` / `audio-metrics` that don't register per-device
   * natives), nodeId is omitted and the cap-router's `resolveProvider`
   * falls through to the local provider — a Moleculer bridge proxy when
   * the actual singleton lives in a worker.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(capName: string, capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    const entry = binding.entries.find((e) => e.capName === capName)
    return callLeaf(capProp, method, kind, mergeInput(input, entry?.providerNodeId), push)
  }

  /**
   * System-cap dispatch. No binding gate — system caps are cluster-wide
   * singletons; the nodeId is left absent so caps that load-balance (e.g.
   * `pipeline-runner`) can resolve their own target node.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatchSystem(capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    return callLeaf(capProp, method, kind, mergeInput(input, undefined), push)
  }

  /** True when this device's binding lists the cap — gates device-scoped handles. */
  function bound(capName: string): boolean {
    return binding.entries.some((e) => e.capName === capName)
  }

  const accessoriesInterface = {
    setChildHidden: (input?: unknown) => dispatch('accessories', 'accessories', 'setChildHidden', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('accessories', 'accessories', 'getStatus', 'query', input),
  }

  const airQualitySensorInterface = {
    getStatus: (input?: unknown) => dispatch('air-quality-sensor', 'airQualitySensor', 'getStatus', 'query', input),
  }

  const alarmPanelInterface = {
    arm: (input?: unknown) => dispatch('alarm-panel', 'alarmPanel', 'arm', 'mutation', input),
    disarm: (input?: unknown) => dispatch('alarm-panel', 'alarmPanel', 'disarm', 'mutation', input),
    trigger: (input?: unknown) => dispatch('alarm-panel', 'alarmPanel', 'trigger', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('alarm-panel', 'alarmPanel', 'getStatus', 'query', input),
  }

  const ambientLightSensorInterface = {
    getStatus: (input?: unknown) => dispatch('ambient-light-sensor', 'ambientLightSensor', 'getStatus', 'query', input),
  }

  const audioAnalysisInterface = {
    resolveDeviceSettings: (input?: unknown) => dispatch('audio-analysis', 'audioAnalysis', 'resolveDeviceSettings', 'query', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatch('audio-analysis', 'audioAnalysis', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('audio-analysis', 'audioAnalysis', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('audio-analysis', 'audioAnalysis', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const audioMetricsInterface = {
    getCurrentSnapshot: (input?: unknown) => dispatch('audio-metrics', 'audioMetrics', 'getCurrentSnapshot', 'query', input),
    getHistory: (input?: unknown) => dispatch('audio-metrics', 'audioMetrics', 'getHistory', 'query', input),
  }

  const automationControlInterface = {
    enable: (input?: unknown) => dispatch('automation-control', 'automationControl', 'enable', 'mutation', input),
    disable: (input?: unknown) => dispatch('automation-control', 'automationControl', 'disable', 'mutation', input),
    trigger: (input?: unknown) => dispatch('automation-control', 'automationControl', 'trigger', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('automation-control', 'automationControl', 'getStatus', 'query', input),
  }

  const batteryInterface = {
    wakeForStream: (input?: unknown) => dispatch('battery', 'battery', 'wakeForStream', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('battery', 'battery', 'getStatus', 'query', input),
  }

  const binaryInterface = {
    getStatus: (input?: unknown) => dispatch('binary', 'binary', 'getStatus', 'query', input),
  }

  const brightnessInterface = {
    setBrightness: (input?: unknown) => dispatch('brightness', 'brightness', 'setBrightness', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('brightness', 'brightness', 'getStatus', 'query', input),
  }

  const buttonInterface = {
    press: (input?: unknown) => dispatch('button', 'button', 'press', 'mutation', input),
  }

  const cameraCredentialsInterface = {
    getCredentials: (input?: unknown) => dispatch('camera-credentials', 'cameraCredentials', 'getCredentials', 'query', input),
    getStatus: (input?: unknown) => dispatch('camera-credentials', 'cameraCredentials', 'getStatus', 'query', input),
  }

  const cameraGridLayoutInterface = {
    getLayout: (input?: unknown) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getLayout', 'query', input),
    saveLayout: (input?: unknown) => dispatch('camera-grid-layout', 'cameraGridLayout', 'saveLayout', 'mutation', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('camera-grid-layout', 'cameraGridLayout', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const cameraPipelineConfigInterface = {
    getDeviceSettingsContribution: (input?: unknown) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const cameraStreamsInterface = {
    getCameraStreams: (input?: unknown) => dispatch('camera-streams', 'cameraStreams', 'getCameraStreams', 'query', input),
    getBrokerStreams: (input?: unknown) => dispatch('camera-streams', 'cameraStreams', 'getBrokerStreams', 'query', input),
    getRtspEntries: (input?: unknown) => dispatch('camera-streams', 'cameraStreams', 'getRtspEntries', 'query', input),
    getProfileRtspEntries: (input?: unknown) => dispatch('camera-streams', 'cameraStreams', 'getProfileRtspEntries', 'query', input),
    pickStream: (input?: unknown) => dispatch('camera-streams', 'cameraStreams', 'pickStream', 'query', input),
  }

  const carbonMonoxideInterface = {
    getStatus: (input?: unknown) => dispatch('carbon-monoxide', 'carbonMonoxide', 'getStatus', 'query', input),
  }

  const climateControlInterface = {
    setMode: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setMode', 'mutation', input),
    setFanMode: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setFanMode', 'mutation', input),
    setPreset: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setPreset', 'mutation', input),
    setTarget: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setTarget', 'mutation', input),
    setTargetRange: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setTargetRange', 'mutation', input),
    setTargetHumidity: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setTargetHumidity', 'mutation', input),
    setSwingVertical: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setSwingVertical', 'mutation', input),
    setSwingHorizontal: (input?: unknown) => dispatch('climate-control', 'climateControl', 'setSwingHorizontal', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('climate-control', 'climateControl', 'getStatus', 'query', input),
  }

  const colorInterface = {
    setColor: (input?: unknown) => dispatch('color', 'color', 'setColor', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('color', 'color', 'getStatus', 'query', input),
  }

  const connectivityInterface = {
    getStatus: (input?: unknown) => dispatch('connectivity', 'connectivity', 'getStatus', 'query', input),
  }

  const consumablesInterface = {
    reset: (input?: unknown) => dispatch('consumables', 'consumables', 'reset', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('consumables', 'consumables', 'getStatus', 'query', input),
  }

  const contactInterface = {
    getStatus: (input?: unknown) => dispatch('contact', 'contact', 'getStatus', 'query', input),
  }

  const controlInterface = {
    setValue: (input?: unknown) => dispatch('control', 'control', 'setValue', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('control', 'control', 'getStatus', 'query', input),
  }

  const coverInterface = {
    open: (input?: unknown) => dispatch('cover', 'cover', 'open', 'mutation', input),
    close: (input?: unknown) => dispatch('cover', 'cover', 'close', 'mutation', input),
    stop: (input?: unknown) => dispatch('cover', 'cover', 'stop', 'mutation', input),
    setPosition: (input?: unknown) => dispatch('cover', 'cover', 'setPosition', 'mutation', input),
    setTiltPosition: (input?: unknown) => dispatch('cover', 'cover', 'setTiltPosition', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('cover', 'cover', 'getStatus', 'query', input),
  }

  const dayNightInterface = {
    getOptions: (input?: unknown) => dispatch('day-night', 'dayNight', 'getOptions', 'query', input),
    setSettings: (input?: unknown) => dispatch('day-night', 'dayNight', 'setSettings', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('day-night', 'dayNight', 'getStatus', 'query', input),
  }

  const detectionPipelineInterface = {
    getDeviceSettingsContribution: (input?: unknown) => dispatch('detection-pipeline', 'detectionPipeline', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('detection-pipeline', 'detectionPipeline', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('detection-pipeline', 'detectionPipeline', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const deviceAdminLinkInterface = {
    getAdminLink: (input?: unknown) => dispatch('device-admin-link', 'deviceAdminLink', 'getAdminLink', 'query', input),
  }

  const deviceDiscoveryInterface = {
    listDiscovered: (input?: unknown) => dispatch('device-discovery', 'deviceDiscovery', 'listDiscovered', 'query', input),
    refreshDiscovery: (input?: unknown) => dispatch('device-discovery', 'deviceDiscovery', 'refreshDiscovery', 'mutation', input),
    adoptDevice: (input?: unknown) => dispatch('device-discovery', 'deviceDiscovery', 'adoptDevice', 'mutation', input),
    releaseDevice: (input?: unknown) => dispatch('device-discovery', 'deviceDiscovery', 'releaseDevice', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('device-discovery', 'deviceDiscovery', 'getStatus', 'query', input),
  }

  const deviceExtensionInterface = {
    listSources: (input?: unknown) => dispatch('device-extension', 'deviceExtension', 'listSources', 'query', input),
    listSlots: (input?: unknown) => dispatch('device-extension', 'deviceExtension', 'listSlots', 'query', input),
    listCandidates: (input?: unknown) => dispatch('device-extension', 'deviceExtension', 'listCandidates', 'query', input),
    setSlot: (input?: unknown) => dispatch('device-extension', 'deviceExtension', 'setSlot', 'mutation', input),
  }

  const deviceOpsInterface = {
    getStreamSources: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'getStreamSources', 'query', input),
    getConfigEntries: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'getConfigEntries', 'query', input),
    setConfig: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'setConfig', 'mutation', input),
    runAction: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'runAction', 'mutation', input),
    removeDevice: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'removeDevice', 'mutation', input),
    getSettingsSchema: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'getSettingsSchema', 'query', input),
    getRawState: (input?: unknown) => dispatch('device-ops', 'deviceOps', 'getRawState', 'query', input),
  }

  const deviceStatusInterface = {
    getStatus: (input?: unknown) => dispatch('device-status', 'deviceStatus', 'getStatus', 'query', input),
  }

  const dishwasherInterface = {
    start: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'start', 'mutation', input),
    pause: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'pause', 'mutation', input),
    resume: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'resume', 'mutation', input),
    stop: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'stop', 'mutation', input),
    setProgram: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setProgram', 'mutation', input),
    setPower: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setPower', 'mutation', input),
    setHalfLoad: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setHalfLoad', 'mutation', input),
    setHygienePlus: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setHygienePlus', 'mutation', input),
    setExtraDry: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setExtraDry', 'mutation', input),
    setIntensiveZone: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setIntensiveZone', 'mutation', input),
    setVarioSpeedPlus: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setVarioSpeedPlus', 'mutation', input),
    setChildLock: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setChildLock', 'mutation', input),
    setOption: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'setOption', 'mutation', input),
    getOptions: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'getOptions', 'query', input),
    getStatus: (input?: unknown) => dispatch('dishwasher', 'dishwasher', 'getStatus', 'query', input),
  }

  const doorbellInterface = {
    getStatus: (input?: unknown) => dispatch('doorbell', 'doorbell', 'getStatus', 'query', input),
  }

  const enumSensorInterface = {
    getStatus: (input?: unknown) => dispatch('enum-sensor', 'enumSensor', 'getStatus', 'query', input),
  }

  const eventEmitterInterface = {
    getStatus: (input?: unknown) => dispatch('event-emitter', 'eventEmitter', 'getStatus', 'query', input),
  }

  const fanControlInterface = {
    setPercentage: (input?: unknown) => dispatch('fan-control', 'fanControl', 'setPercentage', 'mutation', input),
    setPreset: (input?: unknown) => dispatch('fan-control', 'fanControl', 'setPreset', 'mutation', input),
    setDirection: (input?: unknown) => dispatch('fan-control', 'fanControl', 'setDirection', 'mutation', input),
    setOscillating: (input?: unknown) => dispatch('fan-control', 'fanControl', 'setOscillating', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('fan-control', 'fanControl', 'getStatus', 'query', input),
  }

  const featureProbeInterface = {
    getStatus: (input?: unknown) => dispatch('feature-probe', 'featureProbe', 'getStatus', 'query', input),
  }

  const floodInterface = {
    getStatus: (input?: unknown) => dispatch('flood', 'flood', 'getStatus', 'query', input),
  }

  const gasInterface = {
    getStatus: (input?: unknown) => dispatch('gas', 'gas', 'getStatus', 'query', input),
  }

  const groupActiveInterface = {
    getStatus: (input?: unknown) => dispatch('group-active', 'groupActive', 'getStatus', 'query', input),
  }

  const groupCommandsInterface = {
    getStatus: (input?: unknown) => dispatch('group-commands', 'groupCommands', 'getStatus', 'query', input),
  }

  const groupStatusInterface = {
    getStatus: (input?: unknown) => dispatch('group-status', 'groupStatus', 'getStatus', 'query', input),
  }

  const heatingValveInterface = {
    getStatus: (input?: unknown) => dispatch('heating-valve', 'heatingValve', 'getStatus', 'query', input),
  }

  const humidifierInterface = {
    setOn: (input?: unknown) => dispatch('humidifier', 'humidifier', 'setOn', 'mutation', input),
    setTargetHumidity: (input?: unknown) => dispatch('humidifier', 'humidifier', 'setTargetHumidity', 'mutation', input),
    setMode: (input?: unknown) => dispatch('humidifier', 'humidifier', 'setMode', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('humidifier', 'humidifier', 'getStatus', 'query', input),
  }

  const humiditySensorInterface = {
    getStatus: (input?: unknown) => dispatch('humidity-sensor', 'humiditySensor', 'getStatus', 'query', input),
  }

  const imageInterface = {
    getStatus: (input?: unknown) => dispatch('image', 'image', 'getStatus', 'query', input),
  }

  const imageSettingsInterface = {
    getOptions: (input?: unknown) => dispatch('image-settings', 'imageSettings', 'getOptions', 'query', input),
    setSettings: (input?: unknown) => dispatch('image-settings', 'imageSettings', 'setSettings', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('image-settings', 'imageSettings', 'getStatus', 'query', input),
  }

  const intercomInterface = {
    startSession: (input?: unknown) => dispatch('intercom', 'intercom', 'startSession', 'mutation', input),
    handleAnswer: (input?: unknown) => dispatch('intercom', 'intercom', 'handleAnswer', 'mutation', input),
    stopSession: (input?: unknown) => dispatch('intercom', 'intercom', 'stopSession', 'mutation', input),
    startTalkSession: (input?: unknown) => dispatch('intercom', 'intercom', 'startTalkSession', 'mutation', input),
    pushTalkAudio: (input?: unknown) => dispatch('intercom', 'intercom', 'pushTalkAudio', 'mutation', input),
    endTalkSession: (input?: unknown) => dispatch('intercom', 'intercom', 'endTalkSession', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('intercom', 'intercom', 'getStatus', 'query', input),
  }

  const lawnMowerControlInterface = {
    startMowing: (input?: unknown) => dispatch('lawn-mower-control', 'lawnMowerControl', 'startMowing', 'mutation', input),
    pause: (input?: unknown) => dispatch('lawn-mower-control', 'lawnMowerControl', 'pause', 'mutation', input),
    dock: (input?: unknown) => dispatch('lawn-mower-control', 'lawnMowerControl', 'dock', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('lawn-mower-control', 'lawnMowerControl', 'getStatus', 'query', input),
  }

  const lockControlInterface = {
    lock: (input?: unknown) => dispatch('lock-control', 'lockControl', 'lock', 'mutation', input),
    unlock: (input?: unknown) => dispatch('lock-control', 'lockControl', 'unlock', 'mutation', input),
    open: (input?: unknown) => dispatch('lock-control', 'lockControl', 'open', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('lock-control', 'lockControl', 'getStatus', 'query', input),
  }

  const mediaPlayerInterface = {
    play: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'play', 'mutation', input),
    pause: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'pause', 'mutation', input),
    stop: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'stop', 'mutation', input),
    next: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'next', 'mutation', input),
    previous: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'previous', 'mutation', input),
    seek: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'seek', 'mutation', input),
    setVolume: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'setVolume', 'mutation', input),
    setMute: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'setMute', 'mutation', input),
    setShuffle: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'setShuffle', 'mutation', input),
    setRepeat: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'setRepeat', 'mutation', input),
    selectSource: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'selectSource', 'mutation', input),
    playMedia: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'playMedia', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('media-player', 'mediaPlayer', 'getStatus', 'query', input),
  }

  const meterInterface = {
    getStatus: (input?: unknown) => dispatch('meter', 'meter', 'getStatus', 'query', input),
  }

  const motionInterface = {
    isDetected: (input?: unknown) => dispatch('motion', 'motion', 'isDetected', 'query', input),
    getStatus: (input?: unknown) => dispatch('motion', 'motion', 'getStatus', 'query', input),
  }

  const motionDetectionInterface = {
    analyze: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'analyze', 'mutation', input),
    removeCamera: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'removeCamera', 'mutation', input),
    reset: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'reset', 'mutation', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('motion-detection', 'motionDetection', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const motionTriggerInterface = {
    setMotionTrigger: (input?: unknown) => dispatch('motion-trigger', 'motionTrigger', 'setMotionTrigger', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('motion-trigger', 'motionTrigger', 'getStatus', 'query', input),
  }

  const motionZonesInterface = {
    getOptions: (input?: unknown) => dispatch('motion-zones', 'motionZones', 'getOptions', 'query', input),
    setZone: (input?: unknown) => dispatch('motion-zones', 'motionZones', 'setZone', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('motion-zones', 'motionZones', 'getStatus', 'query', input),
  }

  const nativeObjectDetectionInterface = {
    getOptions: (input?: unknown) => dispatch('native-object-detection', 'nativeObjectDetection', 'getOptions', 'query', input),
    setSettings: (input?: unknown) => dispatch('native-object-detection', 'nativeObjectDetection', 'setSettings', 'mutation', input),
    setEnabled: (input?: unknown) => dispatch('native-object-detection', 'nativeObjectDetection', 'setEnabled', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('native-object-detection', 'nativeObjectDetection', 'getStatus', 'query', input),
  }

  const navigationInterface = {
    move: (input?: unknown) => dispatch('navigation', 'navigation', 'move', 'mutation', input),
    stop: (input?: unknown) => dispatch('navigation', 'navigation', 'stop', 'mutation', input),
    goToPoint: (input?: unknown) => dispatch('navigation', 'navigation', 'goToPoint', 'mutation', input),
    listActions: (input?: unknown) => dispatch('navigation', 'navigation', 'listActions', 'query', input),
    runAction: (input?: unknown) => dispatch('navigation', 'navigation', 'runAction', 'mutation', input),
    playSound: (input?: unknown) => dispatch('navigation', 'navigation', 'playSound', 'mutation', input),
    setLightOn: (input?: unknown) => dispatch('navigation', 'navigation', 'setLightOn', 'mutation', input),
    setLightMode: (input?: unknown) => dispatch('navigation', 'navigation', 'setLightMode', 'mutation', input),
    setLightLevel: (input?: unknown) => dispatch('navigation', 'navigation', 'setLightLevel', 'mutation', input),
    getFeatures: (input?: unknown) => dispatch('navigation', 'navigation', 'getFeatures', 'query', input),
    getStatus: (input?: unknown) => dispatch('navigation', 'navigation', 'getStatus', 'query', input),
  }

  const networkLinkInterface = {
    getStatus: (input?: unknown) => dispatch('network-link', 'networkLink', 'getStatus', 'query', input),
  }

  const notifierInterface = {
    send: (input?: unknown) => dispatch('notifier', 'notifier', 'send', 'mutation', input),
    cancel: (input?: unknown) => dispatch('notifier', 'notifier', 'cancel', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('notifier', 'notifier', 'getStatus', 'query', input),
  }

  const numericSensorInterface = {
    getStatus: (input?: unknown) => dispatch('numeric-sensor', 'numericSensor', 'getStatus', 'query', input),
  }

  const osdInterface = {
    setOverlay: (input?: unknown) => dispatch('osd', 'osd', 'setOverlay', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('osd', 'osd', 'getStatus', 'query', input),
  }

  const petFeederInterface = {
    feed: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'feed', 'mutation', input),
    cancelFeed: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'cancelFeed', 'mutation', input),
    resetDesiccant: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'resetDesiccant', 'mutation', input),
    markFoodReplenished: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'markFoodReplenished', 'mutation', input),
    callPet: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'callPet', 'mutation', input),
    playSound: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'playSound', 'mutation', input),
    setChildLock: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'setChildLock', 'mutation', input),
    setIndicatorLight: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'setIndicatorLight', 'mutation', input),
    setFeedSound: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'setFeedSound', 'mutation', input),
    setVolume: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'setVolume', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('pet-feeder', 'petFeeder', 'getStatus', 'query', input),
  }

  const pipelineAnalyticsInterface = {
    getActiveTracks: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getActiveTracks', 'query', input),
    getTrack: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrack', 'query', input),
    listTracks: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTracks', 'query', input),
    listRecentTracks: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRecentTracks', 'query', input),
    clearTracks: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'clearTracks', 'mutation', input),
    getMotionEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getMotionEvents', 'query', input),
    getObjectEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getObjectEvents', 'query', input),
    getAudioEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getAudioEvents', 'query', input),
    listEventKinds: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventKinds', 'query', input),
    listEventKindsBatch: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventKindsBatch', 'query', input),
    getSensorEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getSensorEvents', 'query', input),
    getKeyEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getKeyEvents', 'query', input),
    getKeyEventsBatch: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getKeyEventsBatch', 'query', input),
    readLongTermSeries: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'readLongTermSeries', 'query', input),
    getEventDensity: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventDensity', 'query', input),
    getEventDensityBatch: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventDensityBatch', 'query', input),
    pruneEventsBefore: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneEventsBefore', 'mutation', input),
    pruneTracksBefore: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneTracksBefore', 'mutation', input),
    wipeAllAnalytics: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'wipeAllAnalytics', 'mutation', input),
    reconcileFromDisk: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'reconcileFromDisk', 'mutation', input),
    deleteTracks: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteTracks', 'mutation', input),
    setTrackFlags: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackFlags', 'mutation', input),
    listArchivedDebugNotes: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listArchivedDebugNotes', 'query', input),
    setTrackRelation: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackRelation', 'mutation', input),
    clearTrackRelation: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'clearTrackRelation', 'mutation', input),
    setTrackPurity: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackPurity', 'mutation', input),
    listTrackRelations: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTrackRelations', 'query', input),
    listBirthDecisions: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listBirthDecisions', 'query', input),
    getEventStoreFootprint: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventStoreFootprint', 'query', input),
    getEventMediaFootprintByKind: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventMediaFootprintByKind', 'query', input),
    pruneEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneEvents', 'mutation', input),
    deleteDeviceEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteDeviceEvents', 'mutation', input),
    pauseForStorageMigration: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pauseForStorageMigration', 'mutation', input),
    resumeForStorageMigration: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'resumeForStorageMigration', 'mutation', input),
    refreshStorageLocationsForMigration: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'refreshStorageLocationsForMigration', 'mutation', input),
    startStorageMigrationMove: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'startStorageMigrationMove', 'mutation', input),
    getStorageMigrationMoveStatus: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getStorageMigrationMoveStatus', 'query', input),
    cancelStorageMigrationMove: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'cancelStorageMigrationMove', 'mutation', input),
    relocateMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'relocateMedia', 'mutation', input),
    countUnstampedEventMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'countUnstampedEventMedia', 'query', input),
    countRelocatableMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'countRelocatableMedia', 'query', input),
    listRelocateMediaJobs: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRelocateMediaJobs', 'query', input),
    cancelRelocateMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'cancelRelocateMedia', 'mutation', input),
    listOpsLog: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listOpsLog', 'query', input),
    reclaimDebugMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'reclaimDebugMedia', 'mutation', input),
    getMediaReclaimStatus: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getMediaReclaimStatus', 'query', input),
    getTrainingExportSummary: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrainingExportSummary', 'query', input),
    getTrainingExportUrl: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrainingExportUrl', 'query', input),
    listRetrainStaging: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainStaging', 'query', input),
    listRetrainCorpusPage: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCorpusPage', 'query', input),
    getRetrainCorpusKpi: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainCorpusKpi', 'query', input),
    listRetrainFrames: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainFrames', 'query', input),
    selectRetrainFrames: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'selectRetrainFrames', 'mutation', input),
    deselectRetrainFrame: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deselectRetrainFrame', 'mutation', input),
    getRetrainFrameImage: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainFrameImage', 'query', input),
    proposeRetrainAnnotations: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'proposeRetrainAnnotations', 'mutation', input),
    listRetrainAnnotations: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainAnnotations', 'query', input),
    saveRetrainAnnotations: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'saveRetrainAnnotations', 'mutation', input),
    backfillRetrainOrigins: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'backfillRetrainOrigins', 'mutation', input),
    completeRetrainTrack: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'completeRetrainTrack', 'mutation', input),
    restageRetrainTrack: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'restageRetrainTrack', 'mutation', input),
    getRetrainExportUrl: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainExportUrl', 'query', input),
    setRetrainFrameComplete: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setRetrainFrameComplete', 'mutation', input),
    writeRetrainArchive: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'writeRetrainArchive', 'mutation', input),
    offerRetrainArchive: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'offerRetrainArchive', 'mutation', input),
    listRetrainAssistProfiles: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainAssistProfiles', 'query', input),
    proposeRetrainAnnotationsWithLlm: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'proposeRetrainAnnotationsWithLlm', 'mutation', input),
    createRetrainCollection: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'createRetrainCollection', 'mutation', input),
    listRetrainCollections: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCollections', 'query', input),
    resolveRetrainTrainingCorpus: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'resolveRetrainTrainingCorpus', 'query', input),
    renameRetrainCollection: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'renameRetrainCollection', 'mutation', input),
    deleteRetrainCollection: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteRetrainCollection', 'mutation', input),
    addRetrainFrameFromRecording: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'addRetrainFrameFromRecording', 'mutation', input),
    addRetrainFramesToCollection: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'addRetrainFramesToCollection', 'mutation', input),
    removeRetrainFrameFromCollection: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'removeRetrainFrameFromCollection', 'mutation', input),
    listRetrainCollectionFrames: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCollectionFrames', 'query', input),
    getEventMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventMedia', 'query', input),
    getTrackMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrackMedia', 'query', input),
    listTrackMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTrackMedia', 'query', input),
    listEventMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventMedia', 'query', input),
    ownersWithMedia: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'ownersWithMedia', 'query', input),
    searchObjectEvents: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'searchObjectEvents', 'query', input),
    wipeObjectEmbeddings: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'wipeObjectEmbeddings', 'mutation', input),
    rebuildObjectEmbeddings: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'rebuildObjectEmbeddings', 'mutation', input),
    getObjectEmbeddingRebuildStatus: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getObjectEmbeddingRebuildStatus', 'query', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const powerMeterInterface = {
    getStatus: (input?: unknown) => dispatch('power-meter', 'powerMeter', 'getStatus', 'query', input),
  }

  const presenceInterface = {
    getStatus: (input?: unknown) => dispatch('presence', 'presence', 'getStatus', 'query', input),
  }

  const pressureSensorInterface = {
    getStatus: (input?: unknown) => dispatch('pressure-sensor', 'pressureSensor', 'getStatus', 'query', input),
  }

  const privacyMaskInterface = {
    getOptions: (input?: unknown) => dispatch('privacy-mask', 'privacyMask', 'getOptions', 'query', input),
    setMask: (input?: unknown) => dispatch('privacy-mask', 'privacyMask', 'setMask', 'mutation', input),
    setAudioEnabled: (input?: unknown) => dispatch('privacy-mask', 'privacyMask', 'setAudioEnabled', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('privacy-mask', 'privacyMask', 'getStatus', 'query', input),
  }

  const ptzInterface = {
    move: (input?: unknown) => dispatch('ptz', 'ptz', 'move', 'mutation', input),
    continuousMove: (input?: unknown) => dispatch('ptz', 'ptz', 'continuousMove', 'mutation', input),
    stop: (input?: unknown) => dispatch('ptz', 'ptz', 'stop', 'mutation', input),
    getPresets: (input?: unknown) => dispatch('ptz', 'ptz', 'getPresets', 'query', input),
    goToPreset: (input?: unknown) => dispatch('ptz', 'ptz', 'goToPreset', 'mutation', input),
    savePreset: (input?: unknown) => dispatch('ptz', 'ptz', 'savePreset', 'mutation', input),
    deletePreset: (input?: unknown) => dispatch('ptz', 'ptz', 'deletePreset', 'mutation', input),
    getOptions: (input?: unknown) => dispatch('ptz', 'ptz', 'getOptions', 'query', input),
    goHome: (input?: unknown) => dispatch('ptz', 'ptz', 'goHome', 'mutation', input),
    getHomePreset: (input?: unknown) => dispatch('ptz', 'ptz', 'getHomePreset', 'query', input),
    setHomePreset: (input?: unknown) => dispatch('ptz', 'ptz', 'setHomePreset', 'mutation', input),
    captureHomeHere: (input?: unknown) => dispatch('ptz', 'ptz', 'captureHomeHere', 'mutation', input),
    getHomeReturn: (input?: unknown) => dispatch('ptz', 'ptz', 'getHomeReturn', 'query', input),
    setHomeReturn: (input?: unknown) => dispatch('ptz', 'ptz', 'setHomeReturn', 'mutation', input),
    getPosition: (input?: unknown) => dispatch('ptz', 'ptz', 'getPosition', 'query', input),
    setAutofocus: (input?: unknown) => dispatch('ptz', 'ptz', 'setAutofocus', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('ptz', 'ptz', 'getStatus', 'query', input),
  }

  const ptzAutotrackInterface = {
    getStatus: (input?: unknown) => dispatch('ptz-autotrack', 'ptzAutotrack', 'getStatus', 'query', input),
    setEnabled: (input?: unknown) => dispatch('ptz-autotrack', 'ptzAutotrack', 'setEnabled', 'mutation', input),
    getSettings: (input?: unknown) => dispatch('ptz-autotrack', 'ptzAutotrack', 'getSettings', 'query', input),
    setSettings: (input?: unknown) => dispatch('ptz-autotrack', 'ptzAutotrack', 'setSettings', 'mutation', input),
  }

  const rebootInterface = {
    reboot: (input?: unknown) => dispatch('reboot', 'reboot', 'reboot', 'mutation', input),
  }

  const recordingInterface = {
    listSources: (input?: unknown) => dispatch('recording', 'recording', 'listSources', 'query', input),
    getAvailability: (input?: unknown) => dispatch('recording', 'recording', 'getAvailability', 'query', input),
    getDaysWithRecordings: (input?: unknown) => dispatch('recording', 'recording', 'getDaysWithRecordings', 'query', input),
    getPlayback: (input?: unknown) => dispatch('recording', 'recording', 'getPlayback', 'query', input),
    getPlaybackOptions: (input?: unknown) => dispatch('recording', 'recording', 'getPlaybackOptions', 'query', input),
  }

  const recordingOnboardInterface = {
    getOptions: (input?: unknown) => dispatch('recording-onboard', 'recordingOnboard', 'getOptions', 'query', input),
    setSettings: (input?: unknown) => dispatch('recording-onboard', 'recordingOnboard', 'setSettings', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('recording-onboard', 'recordingOnboard', 'getStatus', 'query', input),
  }

  const recordingSignalInterface = {
    getStatus: (input?: unknown) => dispatch('recording-signal', 'recordingSignal', 'getStatus', 'query', input),
  }

  const runningStateInterface = {
    getStatus: (input?: unknown) => dispatch('running-state', 'runningState', 'getStatus', 'query', input),
  }

  const sceneMonitorInterface = {
    listScenes: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'listScenes', 'query', input),
    listScenesBatch: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'listScenesBatch', 'query', input),
    createScene: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'createScene', 'mutation', input),
    updateScene: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'updateScene', 'mutation', input),
    deleteScene: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'deleteScene', 'mutation', input),
    captureReference: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'captureReference', 'mutation', input),
    deleteReference: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'deleteReference', 'mutation', input),
    recheckNow: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'recheckNow', 'mutation', input),
    resetScene: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'resetScene', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('scene-monitor', 'sceneMonitor', 'getStatus', 'query', input),
  }

  const scriptRunnerInterface = {
    run: (input?: unknown) => dispatch('script-runner', 'scriptRunner', 'run', 'mutation', input),
    stop: (input?: unknown) => dispatch('script-runner', 'scriptRunner', 'stop', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('script-runner', 'scriptRunner', 'getStatus', 'query', input),
  }

  const smokeInterface = {
    getStatus: (input?: unknown) => dispatch('smoke', 'smoke', 'getStatus', 'query', input),
  }

  const snapshotInterface = {
    getSnapshot: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getSnapshot', 'query', input),
    invalidateCache: (input?: unknown) => dispatch('snapshot', 'snapshot', 'invalidateCache', 'mutation', input),
    getSnapshotOverview: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getSnapshotOverview', 'query', input),
    getDebugState: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getDebugState', 'query', input),
    getSnapshotLinks: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getSnapshotLinks', 'query', input),
    getStatus: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getStatus', 'query', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatch('snapshot', 'snapshot', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatch('snapshot', 'snapshot', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const streamCatalogInterface = {
    getCatalog: (input?: unknown) => dispatch('stream-catalog', 'streamCatalog', 'getCatalog', 'query', input),
  }

  const streamParamsInterface = {
    getOptions: (input?: unknown) => dispatch('stream-params', 'streamParams', 'getOptions', 'query', input),
    setProfile: (input?: unknown) => dispatch('stream-params', 'streamParams', 'setProfile', 'mutation', input),
    getConfigSchema: (input?: unknown) => dispatch('stream-params', 'streamParams', 'getConfigSchema', 'query', input),
    getStatus: (input?: unknown) => dispatch('stream-params', 'streamParams', 'getStatus', 'query', input),
  }

  const streamSignalsInterface = {
    listSignals: (input?: unknown) => dispatch('stream-signals', 'streamSignals', 'listSignals', 'query', input),
  }

  const switchInterface = {
    setState: (input?: unknown) => dispatch('switch', 'switch', 'setState', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('switch', 'switch', 'getStatus', 'query', input),
  }

  const tamperInterface = {
    getStatus: (input?: unknown) => dispatch('tamper', 'tamper', 'getStatus', 'query', input),
  }

  const temperatureSensorInterface = {
    getStatus: (input?: unknown) => dispatch('temperature-sensor', 'temperatureSensor', 'getStatus', 'query', input),
  }

  const updateInterface = {
    installUpdate: (input?: unknown) => dispatch('update', 'update', 'installUpdate', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('update', 'update', 'getStatus', 'query', input),
  }

  const vacuumControlInterface = {
    start: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'start', 'mutation', input),
    pause: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'pause', 'mutation', input),
    stop: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'stop', 'mutation', input),
    returnToBase: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'returnToBase', 'mutation', input),
    locate: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'locate', 'mutation', input),
    setFanSpeed: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'setFanSpeed', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('vacuum-control', 'vacuumControl', 'getStatus', 'query', input),
  }

  const valveInterface = {
    open: (input?: unknown) => dispatch('valve', 'valve', 'open', 'mutation', input),
    close: (input?: unknown) => dispatch('valve', 'valve', 'close', 'mutation', input),
    stop: (input?: unknown) => dispatch('valve', 'valve', 'stop', 'mutation', input),
    setPosition: (input?: unknown) => dispatch('valve', 'valve', 'setPosition', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('valve', 'valve', 'getStatus', 'query', input),
  }

  const vibrationInterface = {
    getStatus: (input?: unknown) => dispatch('vibration', 'vibration', 'getStatus', 'query', input),
  }

  const videoclipsInterface = {
    listClips: (input?: unknown) => dispatch('videoclips', 'videoclips', 'listClips', 'query', input),
    listSources: (input?: unknown) => dispatch('videoclips', 'videoclips', 'listSources', 'query', input),
    getClipPlayback: (input?: unknown) => dispatch('videoclips', 'videoclips', 'getClipPlayback', 'query', input),
    readClipBytes: (input?: unknown) => dispatch('videoclips', 'videoclips', 'readClipBytes', 'query', input),
    offerClipBytes: (input?: unknown) => dispatch('videoclips', 'videoclips', 'offerClipBytes', 'query', input),
    dialClipStream: (input?: unknown) => dispatch('videoclips', 'videoclips', 'dialClipStream', 'query', input),
    getPlaybackOptions: (input?: unknown) => dispatch('videoclips', 'videoclips', 'getPlaybackOptions', 'query', input),
  }

  const waterHeaterInterface = {
    setTargetTemp: (input?: unknown) => dispatch('water-heater', 'waterHeater', 'setTargetTemp', 'mutation', input),
    setOperationMode: (input?: unknown) => dispatch('water-heater', 'waterHeater', 'setOperationMode', 'mutation', input),
    setAway: (input?: unknown) => dispatch('water-heater', 'waterHeater', 'setAway', 'mutation', input),
    getStatus: (input?: unknown) => dispatch('water-heater', 'waterHeater', 'getStatus', 'query', input),
  }

  const weatherInterface = {
    getStatus: (input?: unknown) => dispatch('weather', 'weather', 'getStatus', 'query', input),
  }

  const webrtcSessionInterface = {
    listStreams: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'listStreams', 'query', input),
    createSession: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'createSession', 'mutation', input),
    handleOffer: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'handleOffer', 'mutation', input),
    handleAnswer: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'handleAnswer', 'mutation', input),
    addIceCandidate: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'addIceCandidate', 'mutation', input),
    getIceCandidates: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'getIceCandidates', 'query', input),
    closeSession: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'closeSession', 'mutation', input),
    hasAdaptiveBitrate: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'hasAdaptiveBitrate', 'query', input),
    getSessionState: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'getSessionState', 'query', input),
    applyDownlinkProbe: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'applyDownlinkProbe', 'mutation', input),
    getSessionDebug: (input?: unknown) => dispatch('webrtc-session', 'webrtcSession', 'getSessionDebug', 'query', input),
  }

  const zoneAnalyticsInterface = {
    getCurrentSnapshot: (input?: unknown) => dispatch('zone-analytics', 'zoneAnalytics', 'getCurrentSnapshot', 'query', input),
    getCurrentSnapshotBatch: (input?: unknown) => dispatch('zone-analytics', 'zoneAnalytics', 'getCurrentSnapshotBatch', 'query', input),
    getZoneHistory: (input?: unknown) => dispatch('zone-analytics', 'zoneAnalytics', 'getZoneHistory', 'query', input),
    getCameraHistory: (input?: unknown) => dispatch('zone-analytics', 'zoneAnalytics', 'getCameraHistory', 'query', input),
    getUnzonedHistory: (input?: unknown) => dispatch('zone-analytics', 'zoneAnalytics', 'getUnzonedHistory', 'query', input),
  }

  const zoneRulesInterface = {
    listRules: (input?: unknown) => dispatch('zone-rules', 'zoneRules', 'listRules', 'query', input),
    setRules: (input?: unknown) => dispatch('zone-rules', 'zoneRules', 'setRules', 'mutation', input),
  }

  const zonesInterface = {
    listZones: (input?: unknown) => dispatch('zones', 'zones', 'listZones', 'query', input),
    addZone: (input?: unknown) => dispatch('zones', 'zones', 'addZone', 'mutation', input),
    removeZone: (input?: unknown) => dispatch('zones', 'zones', 'removeZone', 'mutation', input),
    updateZone: (input?: unknown) => dispatch('zones', 'zones', 'updateZone', 'mutation', input),
  }

  const actionsInterface = {
    get: (input?: unknown) => dispatchSystem('actions', 'get', 'query', input),
    run: (input?: unknown) => dispatchSystem('actions', 'run', 'mutation', input),
    listForCamera: (input?: unknown) => dispatchSystem('actions', 'listForCamera', 'query', input),
    getLinks: (input?: unknown) => dispatchSystem('actions', 'getLinks', 'query', input),
  }

  const addonSettingsInterface = {
    getDeviceSettings: (input?: unknown) => dispatchSystem('addonSettings', 'getDeviceSettings', 'query', input),
    updateDeviceSettings: (input?: unknown) => dispatchSystem('addonSettings', 'updateDeviceSettings', 'mutation', input),
  }

  const audioAnalyzerInterface = {
    detachDevice: (input?: unknown) => dispatchSystem('audioAnalyzer', 'detachDevice', 'mutation', input),
  }

  const deviceAdoptionInterface = {
    getStatus: (input?: unknown) => dispatchSystem('deviceAdoption', 'getStatus', 'query', input),
  }

  const deviceExportInterface = {
    getDeviceSettingsContribution: (input?: unknown) => dispatchSystem('deviceExport', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatchSystem('deviceExport', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatchSystem('deviceExport', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const deviceHistoryInterface = {
    listSeries: (input?: unknown) => dispatchSystem('deviceHistory', 'listSeries', 'query', input),
    query: (input?: unknown) => dispatchSystem('deviceHistory', 'query', 'query', input),
    getDeviceEnabled: (input?: unknown) => dispatchSystem('deviceHistory', 'getDeviceEnabled', 'query', input),
    setDeviceEnabled: (input?: unknown) => dispatchSystem('deviceHistory', 'setDeviceEnabled', 'mutation', input),
  }

  const deviceManagerInterface = {
    loadConfig: (input?: unknown) => dispatchSystem('deviceManager', 'loadConfig', 'query', input),
    loadRuntimeState: (input?: unknown) => dispatchSystem('deviceManager', 'loadRuntimeState', 'query', input),
    loadMeta: (input?: unknown) => dispatchSystem('deviceManager', 'loadMeta', 'query', input),
    setName: (input?: unknown) => dispatchSystem('deviceManager', 'setName', 'mutation', input),
    setLocation: (input?: unknown) => dispatchSystem('deviceManager', 'setLocation', 'mutation', input),
    setType: (input?: unknown) => dispatchSystem('deviceManager', 'setType', 'mutation', input),
    setIntegrationId: (input?: unknown) => dispatchSystem('deviceManager', 'setIntegrationId', 'mutation', input),
    setLinkDeviceId: (input?: unknown) => dispatchSystem('deviceManager', 'setLinkDeviceId', 'mutation', input),
    setPrimaryChildEntityId: (input?: unknown) => dispatchSystem('deviceManager', 'setPrimaryChildEntityId', 'mutation', input),
    setChildLayout: (input?: unknown) => dispatchSystem('deviceManager', 'setChildLayout', 'mutation', input),
    setDisplay: (input?: unknown) => dispatchSystem('deviceManager', 'setDisplay', 'mutation', input),
    getWireableFields: (input?: unknown) => dispatchSystem('deviceManager', 'getWireableFields', 'query', input),
    setRole: (input?: unknown) => dispatchSystem('deviceManager', 'setRole', 'mutation', input),
    applyInitialMeta: (input?: unknown) => dispatchSystem('deviceManager', 'applyInitialMeta', 'mutation', input),
    setMetadata: (input?: unknown) => dispatchSystem('deviceManager', 'setMetadata', 'mutation', input),
    setDisabled: (input?: unknown) => dispatchSystem('deviceManager', 'setDisabled', 'mutation', input),
    getDevice: (input?: unknown) => dispatchSystem('deviceManager', 'getDevice', 'query', input),
    getLinkedDevices: (input?: unknown) => dispatchSystem('deviceManager', 'getLinkedDevices', 'query', input),
    getStreamSources: (input?: unknown) => dispatchSystem('deviceManager', 'getStreamSources', 'query', input),
    getConfigSchema: (input?: unknown) => dispatchSystem('deviceManager', 'getConfigSchema', 'query', input),
    getSettingsSchema: (input?: unknown) => dispatchSystem('deviceManager', 'getSettingsSchema', 'query', input),
    updateConfig: (input?: unknown) => dispatchSystem('deviceManager', 'updateConfig', 'mutation', input),
    enable: (input?: unknown) => dispatchSystem('deviceManager', 'enable', 'mutation', input),
    disable: (input?: unknown) => dispatchSystem('deviceManager', 'disable', 'mutation', input),
    remove: (input?: unknown) => dispatchSystem('deviceManager', 'remove', 'mutation', input),
    getStreamProfileMap: (input?: unknown) => dispatchSystem('deviceManager', 'getStreamProfileMap', 'query', input),
    setStreamProfileMap: (input?: unknown) => dispatchSystem('deviceManager', 'setStreamProfileMap', 'mutation', input),
    probeStreams: (input?: unknown) => dispatchSystem('deviceManager', 'probeStreams', 'mutation', input),
    getBindings: (input?: unknown) => dispatchSystem('deviceManager', 'getBindings', 'query', input),
    setWrapperActive: (input?: unknown) => dispatchSystem('deviceManager', 'setWrapperActive', 'mutation', input),
    getWrapperActivation: (input?: unknown) => dispatchSystem('deviceManager', 'getWrapperActivation', 'query', input),
    getDeviceSettingsAggregate: (input?: unknown) => dispatchSystem('deviceManager', 'getDeviceSettingsAggregate', 'query', input),
    getDeviceLiveInfoAggregate: (input?: unknown) => dispatchSystem('deviceManager', 'getDeviceLiveInfoAggregate', 'query', input),
    getDeviceAggregate: (input?: unknown) => dispatchSystem('deviceManager', 'getDeviceAggregate', 'query', input),
    runDeviceAction: (input?: unknown) => dispatchSystem('deviceManager', 'runDeviceAction', 'mutation', input),
    updateDeviceField: (input?: unknown) => dispatchSystem('deviceManager', 'updateDeviceField', 'mutation', input),
    updateDeviceFieldsBatch: (input?: unknown) => dispatchSystem('deviceManager', 'updateDeviceFieldsBatch', 'mutation', input),
    testField: (input?: unknown) => dispatchSystem('deviceManager', 'testField', 'mutation', input),
    getDeviceStatusAggregate: (input?: unknown) => dispatchSystem('deviceManager', 'getDeviceStatusAggregate', 'query', input),
  }

  const deviceStateInterface = {
    getSnapshot: (input?: unknown) => dispatchSystem('deviceState', 'getSnapshot', 'query', input),
    getCapSlice: (input?: unknown) => dispatchSystem('deviceState', 'getCapSlice', 'query', input),
    setCapSlice: (input?: unknown) => dispatchSystem('deviceState', 'setCapSlice', 'mutation', input),
    claimFields: (input?: unknown) => dispatchSystem('deviceState', 'claimFields', 'mutation', input),
    patchOwnedFields: (input?: unknown) => dispatchSystem('deviceState', 'patchOwnedFields', 'mutation', input),
    releaseClaim: (input?: unknown) => dispatchSystem('deviceState', 'releaseClaim', 'mutation', input),
    getNativeCapSlice: (input?: unknown) => dispatchSystem('deviceState', 'getNativeCapSlice', 'query', input),
  }

  const faceGalleryInterface = {
    listRecentFaces: (input?: unknown) => dispatchSystem('faceGallery', 'listRecentFaces', 'query', input),
    getFaceByTrack: (input?: unknown) => dispatchSystem('faceGallery', 'getFaceByTrack', 'query', input),
  }

  const networkQualityInterface = {
    getDeviceStats: (input?: unknown) => dispatchSystem('networkQuality', 'getDeviceStats', 'query', input),
    reportClientStats: (input?: unknown) => dispatchSystem('networkQuality', 'reportClientStats', 'mutation', input),
  }

  const notificationRulesInterface = {
    setDeviceMuted: (input?: unknown) => dispatchSystem('notificationRules', 'setDeviceMuted', 'mutation', input),
  }

  const osdManagerInterface = {
    getDeviceOsd: (input?: unknown) => dispatchSystem('osdManager', 'getDeviceOsd', 'query', input),
    getSourceCatalog: (input?: unknown) => dispatchSystem('osdManager', 'getSourceCatalog', 'query', input),
    setSlotBinding: (input?: unknown) => dispatchSystem('osdManager', 'setSlotBinding', 'mutation', input),
    clearSlotBinding: (input?: unknown) => dispatchSystem('osdManager', 'clearSlotBinding', 'mutation', input),
    setSlotCameraEnabled: (input?: unknown) => dispatchSystem('osdManager', 'setSlotCameraEnabled', 'mutation', input),
    previewSlot: (input?: unknown) => dispatchSystem('osdManager', 'previewSlot', 'mutation', input),
    renderDevice: (input?: unknown) => dispatchSystem('osdManager', 'renderDevice', 'mutation', input),
  }

  const pipelineExecutorInterface = {
    runPipeline: (input?: unknown) => dispatchSystem('pipelineExecutor', 'runPipeline', 'mutation', input),
    runPipelineBatch: (input?: unknown) => dispatchSystem('pipelineExecutor', 'runPipelineBatch', 'mutation', input),
  }

  const pipelineOrchestratorInterface = {
    assignPipeline: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'assignPipeline', 'mutation', input),
    unassignPipeline: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'unassignPipeline', 'mutation', input),
    setPipelineDevicePin: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'setPipelineDevicePin', 'mutation', input),
    getPipelineDevicePin: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getPipelineDevicePin', 'query', input),
    getPipelineAssignment: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getPipelineAssignment', 'query', input),
    getCameraMetrics: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getCameraMetrics', 'query', input),
    assignAudio: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'assignAudio', 'mutation', input),
    unassignAudio: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'unassignAudio', 'mutation', input),
    getAudioAssignment: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getAudioAssignment', 'query', input),
    getCameraSettings: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getCameraSettings', 'query', input),
    setCameraStepToggle: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'setCameraStepToggle', 'mutation', input),
    getCameraDetectionSource: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getCameraDetectionSource', 'query', input),
    setCameraDetectionSource: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'setCameraDetectionSource', 'mutation', input),
    setCameraStepSettings: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'setCameraStepSettings', 'mutation', input),
    resolvePipeline: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'resolvePipeline', 'query', input),
    getCameraSwitches: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getCameraSwitches', 'query', input),
    setCameraSwitch: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'setCameraSwitch', 'mutation', input),
    getCameraStatus: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getCameraStatus', 'query', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatchSystem('pipelineOrchestrator', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const pipelineRunnerInterface = {
    detachCamera: (input?: unknown) => dispatchSystem('pipelineRunner', 'detachCamera', 'mutation', input),
    getCameraMetrics: (input?: unknown) => dispatchSystem('pipelineRunner', 'getCameraMetrics', 'query', input),
    requestOccupancyBurst: (input?: unknown) => dispatchSystem('pipelineRunner', 'requestOccupancyBurst', 'mutation', input),
    runDetailSubtree: (input?: unknown) => dispatchSystem('pipelineRunner', 'runDetailSubtree', 'mutation', input),
    parkTrackFrame: (input?: unknown) => dispatchSystem('pipelineRunner', 'parkTrackFrame', 'mutation', input),
    getParkedTrackFrame: (input?: unknown) => dispatchSystem('pipelineRunner', 'getParkedTrackFrame', 'query', input),
    releaseParkedTrackFrames: (input?: unknown) => dispatchSystem('pipelineRunner', 'releaseParkedTrackFrames', 'mutation', input),
  }

  const plateGalleryInterface = {
    listPlates: (input?: unknown) => dispatchSystem('plateGallery', 'listPlates', 'query', input),
    getPlateByTrack: (input?: unknown) => dispatchSystem('plateGallery', 'getPlateByTrack', 'query', input),
  }

  const recordingArchiveInterface = {
    getDeviceConfig: (input?: unknown) => dispatchSystem('recordingArchive', 'getDeviceConfig', 'query', input),
    locateSegment: (input?: unknown) => dispatchSystem('recordingArchive', 'locateSegment', 'query', input),
    readSegmentBytes: (input?: unknown) => dispatchSystem('recordingArchive', 'readSegmentBytes', 'query', input),
    readGopBytes: (input?: unknown) => dispatchSystem('recordingArchive', 'readGopBytes', 'query', input),
    readWindowBytes: (input?: unknown) => dispatchSystem('recordingArchive', 'readWindowBytes', 'query', input),
    setDeviceConfig: (input?: unknown) => dispatchSystem('recordingArchive', 'setDeviceConfig', 'mutation', input),
    rescanStorage: (input?: unknown) => dispatchSystem('recordingArchive', 'rescanStorage', 'mutation', input),
    pruneFootage: (input?: unknown) => dispatchSystem('recordingArchive', 'pruneFootage', 'mutation', input),
    deleteFootprint: (input?: unknown) => dispatchSystem('recordingArchive', 'deleteFootprint', 'mutation', input),
    renderGif: (input?: unknown) => dispatchSystem('recordingArchive', 'renderGif', 'mutation', input),
    renderClip: (input?: unknown) => dispatchSystem('recordingArchive', 'renderClip', 'mutation', input),
    getStatus: (input?: unknown) => dispatchSystem('recordingArchive', 'getStatus', 'query', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatchSystem('recordingArchive', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatchSystem('recordingArchive', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatchSystem('recordingArchive', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  const recordingExportInterface = {
    listExports: (input?: unknown) => dispatchSystem('recordingExport', 'listExports', 'query', input),
  }

  const streamBrokerInterface = {
    reportStreamSignal: (input?: unknown) => dispatchSystem('streamBroker', 'reportStreamSignal', 'mutation', input),
    publishCameraStream: (input?: unknown) => dispatchSystem('streamBroker', 'publishCameraStream', 'mutation', input),
    retractCameraStream: (input?: unknown) => dispatchSystem('streamBroker', 'retractCameraStream', 'mutation', input),
    assignProfile: (input?: unknown) => dispatchSystem('streamBroker', 'assignProfile', 'mutation', input),
    unassignProfile: (input?: unknown) => dispatchSystem('streamBroker', 'unassignProfile', 'mutation', input),
    forgetDeviceHardware: (input?: unknown) => dispatchSystem('streamBroker', 'forgetDeviceHardware', 'mutation', input),
    renderPreBufferClip: (input?: unknown) => dispatchSystem('streamBroker', 'renderPreBufferClip', 'mutation', input),
    produceEventMedia: (input?: unknown) => dispatchSystem('streamBroker', 'produceEventMedia', 'mutation', input),
    restartProfile: (input?: unknown) => dispatchSystem('streamBroker', 'restartProfile', 'mutation', input),
    getDeviceAudioMute: (input?: unknown) => dispatchSystem('streamBroker', 'getDeviceAudioMute', 'query', input),
    setDeviceAudioMute: (input?: unknown) => dispatchSystem('streamBroker', 'setDeviceAudioMute', 'mutation', input),
    getDeviceSettingsContribution: (input?: unknown) => dispatchSystem('streamBroker', 'getDeviceSettingsContribution', 'query', input),
    getDeviceLiveContribution: (input?: unknown) => dispatchSystem('streamBroker', 'getDeviceLiveContribution', 'query', input),
    applyDeviceSettingsPatch: (input?: unknown) => dispatchSystem('streamBroker', 'applyDeviceSettingsPatch', 'mutation', input),
  }

  return {
    deviceId: binding.deviceId,
    binding,
    state: {
      airQualitySensor: createSliceHandle<InferRuntimeState<typeof airQualitySensorCapability>>(stateSource, binding.deviceId, 'air-quality-sensor'),
      alarmPanel: createSliceHandle<InferRuntimeState<typeof alarmPanelCapability>>(stateSource, binding.deviceId, 'alarm-panel'),
      ambientLightSensor: createSliceHandle<InferRuntimeState<typeof ambientLightSensorCapability>>(stateSource, binding.deviceId, 'ambient-light-sensor'),
      audioMetrics: createSliceHandle<InferRuntimeState<typeof audioMetricsCapability>>(stateSource, binding.deviceId, 'audio-metrics'),
      automationControl: createSliceHandle<InferRuntimeState<typeof automationControlCapability>>(stateSource, binding.deviceId, 'automation-control'),
      battery: createSliceHandle<InferRuntimeState<typeof batteryCapability>>(stateSource, binding.deviceId, 'battery'),
      binary: createSliceHandle<InferRuntimeState<typeof binaryCapability>>(stateSource, binding.deviceId, 'binary'),
      brightness: createSliceHandle<InferRuntimeState<typeof brightnessCapability>>(stateSource, binding.deviceId, 'brightness'),
      cameraStreams: createSliceHandle<InferRuntimeState<typeof cameraStreamsCapability>>(stateSource, binding.deviceId, 'camera-streams'),
      carbonMonoxide: createSliceHandle<InferRuntimeState<typeof carbonMonoxideCapability>>(stateSource, binding.deviceId, 'carbon-monoxide'),
      climateControl: createSliceHandle<InferRuntimeState<typeof climateControlCapability>>(stateSource, binding.deviceId, 'climate-control'),
      color: createSliceHandle<InferRuntimeState<typeof colorCapability>>(stateSource, binding.deviceId, 'color'),
      connectivity: createSliceHandle<InferRuntimeState<typeof connectivityCapability>>(stateSource, binding.deviceId, 'connectivity'),
      consumables: createSliceHandle<InferRuntimeState<typeof consumablesCapability>>(stateSource, binding.deviceId, 'consumables'),
      contact: createSliceHandle<InferRuntimeState<typeof contactCapability>>(stateSource, binding.deviceId, 'contact'),
      control: createSliceHandle<InferRuntimeState<typeof controlCapability>>(stateSource, binding.deviceId, 'control'),
      cover: createSliceHandle<InferRuntimeState<typeof coverCapability>>(stateSource, binding.deviceId, 'cover'),
      dayNight: createSliceHandle<InferRuntimeState<typeof dayNightCapability>>(stateSource, binding.deviceId, 'day-night'),
      deviceDiscovery: createSliceHandle<InferRuntimeState<typeof deviceDiscoveryCapability>>(stateSource, binding.deviceId, 'device-discovery'),
      deviceStatus: createSliceHandle<InferRuntimeState<typeof deviceStatusCapability>>(stateSource, binding.deviceId, 'device-status'),
      dishwasher: createSliceHandle<InferRuntimeState<typeof dishwasherCapability>>(stateSource, binding.deviceId, 'dishwasher'),
      doorbell: createSliceHandle<InferRuntimeState<typeof doorbellCapability>>(stateSource, binding.deviceId, 'doorbell'),
      enumSensor: createSliceHandle<InferRuntimeState<typeof enumSensorCapability>>(stateSource, binding.deviceId, 'enum-sensor'),
      eventEmitter: createSliceHandle<InferRuntimeState<typeof eventEmitterCapability>>(stateSource, binding.deviceId, 'event-emitter'),
      fanControl: createSliceHandle<InferRuntimeState<typeof fanControlCapability>>(stateSource, binding.deviceId, 'fan-control'),
      featureProbe: createSliceHandle<InferRuntimeState<typeof featureProbeCapability>>(stateSource, binding.deviceId, 'feature-probe'),
      flood: createSliceHandle<InferRuntimeState<typeof floodCapability>>(stateSource, binding.deviceId, 'flood'),
      gas: createSliceHandle<InferRuntimeState<typeof gasCapability>>(stateSource, binding.deviceId, 'gas'),
      groupActive: createSliceHandle<InferRuntimeState<typeof groupActiveCapability>>(stateSource, binding.deviceId, 'group-active'),
      groupCommands: createSliceHandle<InferRuntimeState<typeof groupCommandsCapability>>(stateSource, binding.deviceId, 'group-commands'),
      groupStatus: createSliceHandle<InferRuntimeState<typeof groupStatusCapability>>(stateSource, binding.deviceId, 'group-status'),
      heatingValve: createSliceHandle<InferRuntimeState<typeof heatingValveCapability>>(stateSource, binding.deviceId, 'heating-valve'),
      humidifier: createSliceHandle<InferRuntimeState<typeof humidifierCapability>>(stateSource, binding.deviceId, 'humidifier'),
      humiditySensor: createSliceHandle<InferRuntimeState<typeof humiditySensorCapability>>(stateSource, binding.deviceId, 'humidity-sensor'),
      image: createSliceHandle<InferRuntimeState<typeof imageCapability>>(stateSource, binding.deviceId, 'image'),
      imageSettings: createSliceHandle<InferRuntimeState<typeof imageSettingsCapability>>(stateSource, binding.deviceId, 'image-settings'),
      intercom: createSliceHandle<InferRuntimeState<typeof intercomCapability>>(stateSource, binding.deviceId, 'intercom'),
      lawnMowerControl: createSliceHandle<InferRuntimeState<typeof lawnMowerControlCapability>>(stateSource, binding.deviceId, 'lawn-mower-control'),
      lockControl: createSliceHandle<InferRuntimeState<typeof lockControlCapability>>(stateSource, binding.deviceId, 'lock-control'),
      mediaPlayer: createSliceHandle<InferRuntimeState<typeof mediaPlayerCapability>>(stateSource, binding.deviceId, 'media-player'),
      meter: createSliceHandle<InferRuntimeState<typeof meterCapability>>(stateSource, binding.deviceId, 'meter'),
      motion: createSliceHandle<InferRuntimeState<typeof motionCapability>>(stateSource, binding.deviceId, 'motion'),
      motionTrigger: createSliceHandle<InferRuntimeState<typeof motionTriggerCapability>>(stateSource, binding.deviceId, 'motion-trigger'),
      motionZones: createSliceHandle<InferRuntimeState<typeof motionZonesCapability>>(stateSource, binding.deviceId, 'motion-zones'),
      nativeObjectDetection: createSliceHandle<InferRuntimeState<typeof nativeObjectDetectionCapability>>(stateSource, binding.deviceId, 'native-object-detection'),
      navigation: createSliceHandle<InferRuntimeState<typeof navigationCapability>>(stateSource, binding.deviceId, 'navigation'),
      networkLink: createSliceHandle<InferRuntimeState<typeof networkLinkCapability>>(stateSource, binding.deviceId, 'network-link'),
      notifier: createSliceHandle<InferRuntimeState<typeof notifierCapability>>(stateSource, binding.deviceId, 'notifier'),
      numericSensor: createSliceHandle<InferRuntimeState<typeof numericSensorCapability>>(stateSource, binding.deviceId, 'numeric-sensor'),
      petFeeder: createSliceHandle<InferRuntimeState<typeof petFeederCapability>>(stateSource, binding.deviceId, 'pet-feeder'),
      powerMeter: createSliceHandle<InferRuntimeState<typeof powerMeterCapability>>(stateSource, binding.deviceId, 'power-meter'),
      presence: createSliceHandle<InferRuntimeState<typeof presenceCapability>>(stateSource, binding.deviceId, 'presence'),
      pressureSensor: createSliceHandle<InferRuntimeState<typeof pressureSensorCapability>>(stateSource, binding.deviceId, 'pressure-sensor'),
      privacyMask: createSliceHandle<InferRuntimeState<typeof privacyMaskCapability>>(stateSource, binding.deviceId, 'privacy-mask'),
      ptzAutotrack: createSliceHandle<InferRuntimeState<typeof ptzAutotrackCapability>>(stateSource, binding.deviceId, 'ptz-autotrack'),
      recordingOnboard: createSliceHandle<InferRuntimeState<typeof recordingOnboardCapability>>(stateSource, binding.deviceId, 'recording-onboard'),
      recordingSignal: createSliceHandle<InferRuntimeState<typeof recordingSignalCapability>>(stateSource, binding.deviceId, 'recording-signal'),
      runningState: createSliceHandle<InferRuntimeState<typeof runningStateCapability>>(stateSource, binding.deviceId, 'running-state'),
      sceneMonitor: createSliceHandle<InferRuntimeState<typeof sceneMonitorCapability>>(stateSource, binding.deviceId, 'scene-monitor'),
      scriptRunner: createSliceHandle<InferRuntimeState<typeof scriptRunnerCapability>>(stateSource, binding.deviceId, 'script-runner'),
      smoke: createSliceHandle<InferRuntimeState<typeof smokeCapability>>(stateSource, binding.deviceId, 'smoke'),
      streamCatalog: createSliceHandle<InferRuntimeState<typeof streamCatalogCapability>>(stateSource, binding.deviceId, 'stream-catalog'),
      streamParams: createSliceHandle<InferRuntimeState<typeof streamParamsCapability>>(stateSource, binding.deviceId, 'stream-params'),
      streamSignals: createSliceHandle<InferRuntimeState<typeof streamSignalsCapability>>(stateSource, binding.deviceId, 'stream-signals'),
      switch: createSliceHandle<InferRuntimeState<typeof switchCapability>>(stateSource, binding.deviceId, 'switch'),
      tamper: createSliceHandle<InferRuntimeState<typeof tamperCapability>>(stateSource, binding.deviceId, 'tamper'),
      temperatureSensor: createSliceHandle<InferRuntimeState<typeof temperatureSensorCapability>>(stateSource, binding.deviceId, 'temperature-sensor'),
      update: createSliceHandle<InferRuntimeState<typeof updateCapability>>(stateSource, binding.deviceId, 'update'),
      vacuumControl: createSliceHandle<InferRuntimeState<typeof vacuumControlCapability>>(stateSource, binding.deviceId, 'vacuum-control'),
      valve: createSliceHandle<InferRuntimeState<typeof valveCapability>>(stateSource, binding.deviceId, 'valve'),
      vibration: createSliceHandle<InferRuntimeState<typeof vibrationCapability>>(stateSource, binding.deviceId, 'vibration'),
      waterHeater: createSliceHandle<InferRuntimeState<typeof waterHeaterCapability>>(stateSource, binding.deviceId, 'water-heater'),
      weather: createSliceHandle<InferRuntimeState<typeof weatherCapability>>(stateSource, binding.deviceId, 'weather'),
      zoneAnalytics: createSliceHandle<InferRuntimeState<typeof zoneAnalyticsCapability>>(stateSource, binding.deviceId, 'zone-analytics'),
      zoneRules: createSliceHandle<InferRuntimeState<typeof zoneRulesCapability>>(stateSource, binding.deviceId, 'zone-rules'),
      zones: createSliceHandle<InferRuntimeState<typeof zonesCapability>>(stateSource, binding.deviceId, 'zones'),
    },
    ...(bound('accessories') ? { accessories: accessoriesInterface } : {}),
    ...(bound('air-quality-sensor') ? { airQualitySensor: airQualitySensorInterface } : {}),
    ...(bound('alarm-panel') ? { alarmPanel: alarmPanelInterface } : {}),
    ...(bound('ambient-light-sensor') ? { ambientLightSensor: ambientLightSensorInterface } : {}),
    ...(bound('audio-analysis') ? { audioAnalysis: audioAnalysisInterface } : {}),
    ...(bound('audio-metrics') ? { audioMetrics: audioMetricsInterface } : {}),
    ...(bound('automation-control') ? { automationControl: automationControlInterface } : {}),
    ...(bound('battery') ? { battery: batteryInterface } : {}),
    ...(bound('binary') ? { binary: binaryInterface } : {}),
    ...(bound('brightness') ? { brightness: brightnessInterface } : {}),
    ...(bound('button') ? { button: buttonInterface } : {}),
    ...(bound('camera-credentials') ? { cameraCredentials: cameraCredentialsInterface } : {}),
    ...(bound('camera-grid-layout') ? { cameraGridLayout: cameraGridLayoutInterface } : {}),
    ...(bound('camera-pipeline-config') ? { cameraPipelineConfig: cameraPipelineConfigInterface } : {}),
    ...(bound('camera-streams') ? { cameraStreams: cameraStreamsInterface } : {}),
    ...(bound('carbon-monoxide') ? { carbonMonoxide: carbonMonoxideInterface } : {}),
    ...(bound('climate-control') ? { climateControl: climateControlInterface } : {}),
    ...(bound('color') ? { color: colorInterface } : {}),
    ...(bound('connectivity') ? { connectivity: connectivityInterface } : {}),
    ...(bound('consumables') ? { consumables: consumablesInterface } : {}),
    ...(bound('contact') ? { contact: contactInterface } : {}),
    ...(bound('control') ? { control: controlInterface } : {}),
    ...(bound('cover') ? { cover: coverInterface } : {}),
    ...(bound('day-night') ? { dayNight: dayNightInterface } : {}),
    ...(bound('detection-pipeline') ? { detectionPipeline: detectionPipelineInterface } : {}),
    ...(bound('device-admin-link') ? { deviceAdminLink: deviceAdminLinkInterface } : {}),
    ...(bound('device-discovery') ? { deviceDiscovery: deviceDiscoveryInterface } : {}),
    ...(bound('device-extension') ? { deviceExtension: deviceExtensionInterface } : {}),
    ...(bound('device-ops') ? { deviceOps: deviceOpsInterface } : {}),
    ...(bound('device-status') ? { deviceStatus: deviceStatusInterface } : {}),
    ...(bound('dishwasher') ? { dishwasher: dishwasherInterface } : {}),
    ...(bound('doorbell') ? { doorbell: doorbellInterface } : {}),
    ...(bound('enum-sensor') ? { enumSensor: enumSensorInterface } : {}),
    ...(bound('event-emitter') ? { eventEmitter: eventEmitterInterface } : {}),
    ...(bound('fan-control') ? { fanControl: fanControlInterface } : {}),
    ...(bound('feature-probe') ? { featureProbe: featureProbeInterface } : {}),
    ...(bound('flood') ? { flood: floodInterface } : {}),
    ...(bound('gas') ? { gas: gasInterface } : {}),
    ...(bound('group-active') ? { groupActive: groupActiveInterface } : {}),
    ...(bound('group-commands') ? { groupCommands: groupCommandsInterface } : {}),
    ...(bound('group-status') ? { groupStatus: groupStatusInterface } : {}),
    ...(bound('heating-valve') ? { heatingValve: heatingValveInterface } : {}),
    ...(bound('humidifier') ? { humidifier: humidifierInterface } : {}),
    ...(bound('humidity-sensor') ? { humiditySensor: humiditySensorInterface } : {}),
    ...(bound('image') ? { image: imageInterface } : {}),
    ...(bound('image-settings') ? { imageSettings: imageSettingsInterface } : {}),
    ...(bound('intercom') ? { intercom: intercomInterface } : {}),
    ...(bound('lawn-mower-control') ? { lawnMowerControl: lawnMowerControlInterface } : {}),
    ...(bound('lock-control') ? { lockControl: lockControlInterface } : {}),
    ...(bound('media-player') ? { mediaPlayer: mediaPlayerInterface } : {}),
    ...(bound('meter') ? { meter: meterInterface } : {}),
    ...(bound('motion') ? { motion: motionInterface } : {}),
    ...(bound('motion-detection') ? { motionDetection: motionDetectionInterface } : {}),
    ...(bound('motion-trigger') ? { motionTrigger: motionTriggerInterface } : {}),
    ...(bound('motion-zones') ? { motionZones: motionZonesInterface } : {}),
    ...(bound('native-object-detection') ? { nativeObjectDetection: nativeObjectDetectionInterface } : {}),
    ...(bound('navigation') ? { navigation: navigationInterface } : {}),
    ...(bound('network-link') ? { networkLink: networkLinkInterface } : {}),
    ...(bound('notifier') ? { notifier: notifierInterface } : {}),
    ...(bound('numeric-sensor') ? { numericSensor: numericSensorInterface } : {}),
    ...(bound('osd') ? { osd: osdInterface } : {}),
    ...(bound('pet-feeder') ? { petFeeder: petFeederInterface } : {}),
    ...(bound('pipeline-analytics') ? { pipelineAnalytics: pipelineAnalyticsInterface } : {}),
    ...(bound('power-meter') ? { powerMeter: powerMeterInterface } : {}),
    ...(bound('presence') ? { presence: presenceInterface } : {}),
    ...(bound('pressure-sensor') ? { pressureSensor: pressureSensorInterface } : {}),
    ...(bound('privacy-mask') ? { privacyMask: privacyMaskInterface } : {}),
    ...(bound('ptz') ? { ptz: ptzInterface } : {}),
    ...(bound('ptz-autotrack') ? { ptzAutotrack: ptzAutotrackInterface } : {}),
    ...(bound('reboot') ? { reboot: rebootInterface } : {}),
    ...(bound('recording') ? { recording: recordingInterface } : {}),
    ...(bound('recording-onboard') ? { recordingOnboard: recordingOnboardInterface } : {}),
    ...(bound('recording-signal') ? { recordingSignal: recordingSignalInterface } : {}),
    ...(bound('running-state') ? { runningState: runningStateInterface } : {}),
    ...(bound('scene-monitor') ? { sceneMonitor: sceneMonitorInterface } : {}),
    ...(bound('script-runner') ? { scriptRunner: scriptRunnerInterface } : {}),
    ...(bound('smoke') ? { smoke: smokeInterface } : {}),
    ...(bound('snapshot') ? { snapshot: snapshotInterface } : {}),
    ...(bound('stream-catalog') ? { streamCatalog: streamCatalogInterface } : {}),
    ...(bound('stream-params') ? { streamParams: streamParamsInterface } : {}),
    ...(bound('stream-signals') ? { streamSignals: streamSignalsInterface } : {}),
    ...(bound('switch') ? { switch: switchInterface } : {}),
    ...(bound('tamper') ? { tamper: tamperInterface } : {}),
    ...(bound('temperature-sensor') ? { temperatureSensor: temperatureSensorInterface } : {}),
    ...(bound('update') ? { update: updateInterface } : {}),
    ...(bound('vacuum-control') ? { vacuumControl: vacuumControlInterface } : {}),
    ...(bound('valve') ? { valve: valveInterface } : {}),
    ...(bound('vibration') ? { vibration: vibrationInterface } : {}),
    ...(bound('videoclips') ? { videoclips: videoclipsInterface } : {}),
    ...(bound('water-heater') ? { waterHeater: waterHeaterInterface } : {}),
    ...(bound('weather') ? { weather: weatherInterface } : {}),
    ...(bound('webrtc-session') ? { webrtcSession: webrtcSessionInterface } : {}),
    ...(bound('zone-analytics') ? { zoneAnalytics: zoneAnalyticsInterface } : {}),
    ...(bound('zone-rules') ? { zoneRules: zoneRulesInterface } : {}),
    ...(bound('zones') ? { zones: zonesInterface } : {}),
    actions: actionsInterface,
    addonSettings: addonSettingsInterface,
    audioAnalyzer: audioAnalyzerInterface,
    deviceAdoption: deviceAdoptionInterface,
    deviceExport: deviceExportInterface,
    deviceHistory: deviceHistoryInterface,
    deviceManager: deviceManagerInterface,
    deviceState: deviceStateInterface,
    faceGallery: faceGalleryInterface,
    networkQuality: networkQualityInterface,
    notificationRules: notificationRulesInterface,
    osdManager: osdManagerInterface,
    pipelineExecutor: pipelineExecutorInterface,
    pipelineOrchestrator: pipelineOrchestratorInterface,
    pipelineRunner: pipelineRunnerInterface,
    plateGallery: plateGalleryInterface,
    recordingArchive: recordingArchiveInterface,
    recordingExport: recordingExportInterface,
    streamBroker: streamBrokerInterface,
  }
}
