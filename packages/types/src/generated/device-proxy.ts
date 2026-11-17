// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { InferDeviceProxyCap, InferRuntimeState } from '../capabilities/capability-definition.js'
import type { DeviceBinding } from '../device/device-binding.js'
import { createSliceHandle, createLazyTrpcSource, type SliceHandle, type SliceHandleSource } from '../device/device-state-handle.js'
import { addonSliceHandleApi } from '../helpers/addon-slice-handle.js'
import type { CommandOriginRequestOptions } from '../cap-call-context.js'
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
import type { deviceExtensionCapability } from '../capabilities/device-extension.cap.js'
import type { deviceOpsCapability } from '../capabilities/device-ops.cap.js'
import type { deviceRunsCapability } from '../capabilities/device-runs.cap.js'
import type { deviceStatusCapability } from '../capabilities/device-status.cap.js'
import type { deviceTransitionsCapability } from '../capabilities/device-transitions.cap.js'
import type { dishwasherCapability } from '../capabilities/dishwasher.cap.js'
import type { doNotDisturbCapability } from '../capabilities/do-not-disturb.cap.js'
import type { doorbellCapability } from '../capabilities/doorbell.cap.js'
import type { energySystemCapability } from '../capabilities/energy-system.cap.js'
import type { enumSensorCapability } from '../capabilities/enum-sensor.cap.js'
import type { errorCapability } from '../capabilities/error.cap.js'
import type { eventEmitterCapability } from '../capabilities/event-emitter.cap.js'
import type { fanControlCapability } from '../capabilities/fan-control.cap.js'
import type { featureProbeCapability } from '../capabilities/feature-probe.cap.js'
import type { floodCapability } from '../capabilities/flood.cap.js'
import type { gasCapability } from '../capabilities/gas.cap.js'
import type { groupActiveCapability } from '../capabilities/group-active.cap.js'
import type { groupCommandsCapability } from '../capabilities/group-commands.cap.js'
import type { groupStatusCapability } from '../capabilities/group-status.cap.js'
import type { heatingValveCapability } from '../capabilities/heating-valve.cap.js'
import type { heatPumpControlCapability } from '../capabilities/heat-pump-control.cap.js'
import type { heatPumpStatusCapability } from '../capabilities/heat-pump-status.cap.js'
import type { humidifierCapability } from '../capabilities/humidifier.cap.js'
import type { humiditySensorCapability } from '../capabilities/humidity-sensor.cap.js'
import type { imageCapability } from '../capabilities/image.cap.js'
import type { imageSettingsCapability } from '../capabilities/image-settings.cap.js'
import type { intercomCapability } from '../capabilities/intercom.cap.js'
import type { irTransmitterCapability } from '../capabilities/ir-transmitter.cap.js'
import type { lawnMowerControlCapability } from '../capabilities/lawn-mower-control.cap.js'
import type { lockControlCapability } from '../capabilities/lock-control.cap.js'
import type { lowPowerSleepCapability } from '../capabilities/low-power-sleep.cap.js'
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
import type { petFountainCapability } from '../capabilities/pet-fountain.cap.js'
import type { pipelineAnalyticsCapability } from '../capabilities/pipeline-analytics.cap.js'
import type { powerMeterCapability } from '../capabilities/power-meter.cap.js'
import type { powerSourceCapability } from '../capabilities/power-source.cap.js'
import type { presenceCapability } from '../capabilities/presence.cap.js'
import type { pressureSensorCapability } from '../capabilities/pressure-sensor.cap.js'
import type { privacyMaskCapability } from '../capabilities/privacy-mask.cap.js'
import type { ptzCapability } from '../capabilities/ptz.cap.js'
import type { ptzAutotrackCapability } from '../capabilities/ptz-autotrack.cap.js'
import type { pumpCycleCapability } from '../capabilities/pump-cycle.cap.js'
import type { rebootCapability } from '../capabilities/reboot.cap.js'
import type { recordingCapability } from '../capabilities/recording.cap.js'
import type { recordingOnboardCapability } from '../capabilities/recording-onboard.cap.js'
import type { recordingSignalCapability } from '../capabilities/recording-signal.cap.js'
import type { resyncCapability } from '../capabilities/resync.cap.js'
import type { runningStateCapability } from '../capabilities/running-state.cap.js'
import type { sceneMonitorCapability } from '../capabilities/scene-monitor.cap.js'
import type { scriptRunnerCapability } from '../capabilities/script-runner.cap.js'
import type { sirenCapability } from '../capabilities/siren.cap.js'
import type { smokeCapability } from '../capabilities/smoke.cap.js'
import type { snapshotCapability } from '../capabilities/snapshot.cap.js'
import type { streamCatalogCapability } from '../capabilities/stream-catalog.cap.js'
import type { streamParamsCapability } from '../capabilities/stream-params.cap.js'
import type { streamSignalsCapability } from '../capabilities/stream-signals.cap.js'
import type { switchCapability } from '../capabilities/switch.cap.js'
import type { tamperCapability } from '../capabilities/tamper.cap.js'
import type { temperatureSensorCapability } from '../capabilities/temperature-sensor.cap.js'
import type { timedRunCapability } from '../capabilities/timed-run.cap.js'
import type { updateCapability } from '../capabilities/update.cap.js'
import type { vacuumControlCapability } from '../capabilities/vacuum-control.cap.js'
import type { valveCapability } from '../capabilities/valve.cap.js'
import type { vibrationCapability } from '../capabilities/vibration.cap.js'
import type { videoclipsCapability } from '../capabilities/videoclips.cap.js'
import type { waterHeaterCapability } from '../capabilities/water-heater.cap.js'
import type { weatherCapability } from '../capabilities/weather.cap.js'
import type { weatherStationCapability } from '../capabilities/weather-station.cap.js'
import type { webrtcSessionCapability } from '../capabilities/webrtc-session.cap.js'
import type { workloadCapability } from '../capabilities/workload.cap.js'
import type { zoneAnalyticsCapability } from '../capabilities/zone-analytics.cap.js'
import type { zoneRulesCapability } from '../capabilities/zone-rules.cap.js'
import type { zonesCapability } from '../capabilities/zones.cap.js'
import type { actionsCapability } from '../capabilities/actions.cap.js'
import type { addonSettingsCapability } from '../capabilities/addon-settings.cap.js'
import type { audioAnalyzerCapability } from '../capabilities/audio-analyzer.cap.js'
import type { coreBlocksCapability } from '../capabilities/core-blocks.cap.js'
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
  readonly deviceStatus: SliceHandle<InferRuntimeState<typeof deviceStatusCapability>>
  readonly dishwasher: SliceHandle<InferRuntimeState<typeof dishwasherCapability>>
  readonly doNotDisturb: SliceHandle<InferRuntimeState<typeof doNotDisturbCapability>>
  readonly doorbell: SliceHandle<InferRuntimeState<typeof doorbellCapability>>
  readonly energySystem: SliceHandle<InferRuntimeState<typeof energySystemCapability>>
  readonly enumSensor: SliceHandle<InferRuntimeState<typeof enumSensorCapability>>
  readonly error: SliceHandle<InferRuntimeState<typeof errorCapability>>
  readonly eventEmitter: SliceHandle<InferRuntimeState<typeof eventEmitterCapability>>
  readonly fanControl: SliceHandle<InferRuntimeState<typeof fanControlCapability>>
  readonly featureProbe: SliceHandle<InferRuntimeState<typeof featureProbeCapability>>
  readonly flood: SliceHandle<InferRuntimeState<typeof floodCapability>>
  readonly gas: SliceHandle<InferRuntimeState<typeof gasCapability>>
  readonly groupActive: SliceHandle<InferRuntimeState<typeof groupActiveCapability>>
  readonly groupCommands: SliceHandle<InferRuntimeState<typeof groupCommandsCapability>>
  readonly groupStatus: SliceHandle<InferRuntimeState<typeof groupStatusCapability>>
  readonly heatingValve: SliceHandle<InferRuntimeState<typeof heatingValveCapability>>
  readonly heatPumpStatus: SliceHandle<InferRuntimeState<typeof heatPumpStatusCapability>>
  readonly humidifier: SliceHandle<InferRuntimeState<typeof humidifierCapability>>
  readonly humiditySensor: SliceHandle<InferRuntimeState<typeof humiditySensorCapability>>
  readonly image: SliceHandle<InferRuntimeState<typeof imageCapability>>
  readonly imageSettings: SliceHandle<InferRuntimeState<typeof imageSettingsCapability>>
  readonly intercom: SliceHandle<InferRuntimeState<typeof intercomCapability>>
  readonly irTransmitter: SliceHandle<InferRuntimeState<typeof irTransmitterCapability>>
  readonly lawnMowerControl: SliceHandle<InferRuntimeState<typeof lawnMowerControlCapability>>
  readonly lockControl: SliceHandle<InferRuntimeState<typeof lockControlCapability>>
  readonly lowPowerSleep: SliceHandle<InferRuntimeState<typeof lowPowerSleepCapability>>
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
  readonly petFountain: SliceHandle<InferRuntimeState<typeof petFountainCapability>>
  readonly powerMeter: SliceHandle<InferRuntimeState<typeof powerMeterCapability>>
  readonly powerSource: SliceHandle<InferRuntimeState<typeof powerSourceCapability>>
  readonly presence: SliceHandle<InferRuntimeState<typeof presenceCapability>>
  readonly pressureSensor: SliceHandle<InferRuntimeState<typeof pressureSensorCapability>>
  readonly privacyMask: SliceHandle<InferRuntimeState<typeof privacyMaskCapability>>
  readonly ptzAutotrack: SliceHandle<InferRuntimeState<typeof ptzAutotrackCapability>>
  readonly pumpCycle: SliceHandle<InferRuntimeState<typeof pumpCycleCapability>>
  readonly recordingOnboard: SliceHandle<InferRuntimeState<typeof recordingOnboardCapability>>
  readonly recordingSignal: SliceHandle<InferRuntimeState<typeof recordingSignalCapability>>
  readonly runningState: SliceHandle<InferRuntimeState<typeof runningStateCapability>>
  readonly sceneMonitor: SliceHandle<InferRuntimeState<typeof sceneMonitorCapability>>
  readonly scriptRunner: SliceHandle<InferRuntimeState<typeof scriptRunnerCapability>>
  readonly siren: SliceHandle<InferRuntimeState<typeof sirenCapability>>
  readonly smoke: SliceHandle<InferRuntimeState<typeof smokeCapability>>
  readonly streamCatalog: SliceHandle<InferRuntimeState<typeof streamCatalogCapability>>
  readonly streamParams: SliceHandle<InferRuntimeState<typeof streamParamsCapability>>
  readonly streamSignals: SliceHandle<InferRuntimeState<typeof streamSignalsCapability>>
  readonly switch: SliceHandle<InferRuntimeState<typeof switchCapability>>
  readonly tamper: SliceHandle<InferRuntimeState<typeof tamperCapability>>
  readonly temperatureSensor: SliceHandle<InferRuntimeState<typeof temperatureSensorCapability>>
  readonly timedRun: SliceHandle<InferRuntimeState<typeof timedRunCapability>>
  readonly update: SliceHandle<InferRuntimeState<typeof updateCapability>>
  readonly vacuumControl: SliceHandle<InferRuntimeState<typeof vacuumControlCapability>>
  readonly valve: SliceHandle<InferRuntimeState<typeof valveCapability>>
  readonly vibration: SliceHandle<InferRuntimeState<typeof vibrationCapability>>
  readonly waterHeater: SliceHandle<InferRuntimeState<typeof waterHeaterCapability>>
  readonly weather: SliceHandle<InferRuntimeState<typeof weatherCapability>>
  readonly weatherStation: SliceHandle<InferRuntimeState<typeof weatherStationCapability>>
  readonly workload: SliceHandle<InferRuntimeState<typeof workloadCapability>>
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
  readonly deviceExtension?: InferDeviceProxyCap<typeof deviceExtensionCapability>
  readonly deviceOps?: InferDeviceProxyCap<typeof deviceOpsCapability>
  readonly deviceRuns?: InferDeviceProxyCap<typeof deviceRunsCapability>
  readonly deviceStatus?: InferDeviceProxyCap<typeof deviceStatusCapability>
  readonly deviceTransitions?: InferDeviceProxyCap<typeof deviceTransitionsCapability>
  readonly dishwasher?: InferDeviceProxyCap<typeof dishwasherCapability>
  readonly doNotDisturb?: InferDeviceProxyCap<typeof doNotDisturbCapability>
  readonly doorbell?: InferDeviceProxyCap<typeof doorbellCapability>
  readonly energySystem?: InferDeviceProxyCap<typeof energySystemCapability>
  readonly enumSensor?: InferDeviceProxyCap<typeof enumSensorCapability>
  readonly error?: InferDeviceProxyCap<typeof errorCapability>
  readonly eventEmitter?: InferDeviceProxyCap<typeof eventEmitterCapability>
  readonly fanControl?: InferDeviceProxyCap<typeof fanControlCapability>
  readonly featureProbe?: InferDeviceProxyCap<typeof featureProbeCapability>
  readonly flood?: InferDeviceProxyCap<typeof floodCapability>
  readonly gas?: InferDeviceProxyCap<typeof gasCapability>
  readonly groupActive?: InferDeviceProxyCap<typeof groupActiveCapability>
  readonly groupCommands?: InferDeviceProxyCap<typeof groupCommandsCapability>
  readonly groupStatus?: InferDeviceProxyCap<typeof groupStatusCapability>
  readonly heatingValve?: InferDeviceProxyCap<typeof heatingValveCapability>
  readonly heatPumpControl?: InferDeviceProxyCap<typeof heatPumpControlCapability>
  readonly heatPumpStatus?: InferDeviceProxyCap<typeof heatPumpStatusCapability>
  readonly humidifier?: InferDeviceProxyCap<typeof humidifierCapability>
  readonly humiditySensor?: InferDeviceProxyCap<typeof humiditySensorCapability>
  readonly image?: InferDeviceProxyCap<typeof imageCapability>
  readonly imageSettings?: InferDeviceProxyCap<typeof imageSettingsCapability>
  readonly intercom?: InferDeviceProxyCap<typeof intercomCapability>
  readonly irTransmitter?: InferDeviceProxyCap<typeof irTransmitterCapability>
  readonly lawnMowerControl?: InferDeviceProxyCap<typeof lawnMowerControlCapability>
  readonly lockControl?: InferDeviceProxyCap<typeof lockControlCapability>
  readonly lowPowerSleep?: InferDeviceProxyCap<typeof lowPowerSleepCapability>
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
  readonly petFountain?: InferDeviceProxyCap<typeof petFountainCapability>
  readonly pipelineAnalytics?: InferDeviceProxyCap<typeof pipelineAnalyticsCapability>
  readonly powerMeter?: InferDeviceProxyCap<typeof powerMeterCapability>
  readonly powerSource?: InferDeviceProxyCap<typeof powerSourceCapability>
  readonly presence?: InferDeviceProxyCap<typeof presenceCapability>
  readonly pressureSensor?: InferDeviceProxyCap<typeof pressureSensorCapability>
  readonly privacyMask?: InferDeviceProxyCap<typeof privacyMaskCapability>
  readonly ptz?: InferDeviceProxyCap<typeof ptzCapability>
  readonly ptzAutotrack?: InferDeviceProxyCap<typeof ptzAutotrackCapability>
  readonly pumpCycle?: InferDeviceProxyCap<typeof pumpCycleCapability>
  readonly reboot?: InferDeviceProxyCap<typeof rebootCapability>
  readonly recording?: InferDeviceProxyCap<typeof recordingCapability>
  readonly recordingOnboard?: InferDeviceProxyCap<typeof recordingOnboardCapability>
  readonly recordingSignal?: InferDeviceProxyCap<typeof recordingSignalCapability>
  readonly resync?: InferDeviceProxyCap<typeof resyncCapability>
  readonly runningState?: InferDeviceProxyCap<typeof runningStateCapability>
  readonly sceneMonitor?: InferDeviceProxyCap<typeof sceneMonitorCapability>
  readonly scriptRunner?: InferDeviceProxyCap<typeof scriptRunnerCapability>
  readonly siren?: InferDeviceProxyCap<typeof sirenCapability>
  readonly smoke?: InferDeviceProxyCap<typeof smokeCapability>
  readonly snapshot?: InferDeviceProxyCap<typeof snapshotCapability>
  readonly streamCatalog?: InferDeviceProxyCap<typeof streamCatalogCapability>
  readonly streamParams?: InferDeviceProxyCap<typeof streamParamsCapability>
  readonly streamSignals?: InferDeviceProxyCap<typeof streamSignalsCapability>
  readonly switch?: InferDeviceProxyCap<typeof switchCapability>
  readonly tamper?: InferDeviceProxyCap<typeof tamperCapability>
  readonly temperatureSensor?: InferDeviceProxyCap<typeof temperatureSensorCapability>
  readonly timedRun?: InferDeviceProxyCap<typeof timedRunCapability>
  readonly update?: InferDeviceProxyCap<typeof updateCapability>
  readonly vacuumControl?: InferDeviceProxyCap<typeof vacuumControlCapability>
  readonly valve?: InferDeviceProxyCap<typeof valveCapability>
  readonly vibration?: InferDeviceProxyCap<typeof vibrationCapability>
  readonly videoclips?: InferDeviceProxyCap<typeof videoclipsCapability>
  readonly waterHeater?: InferDeviceProxyCap<typeof waterHeaterCapability>
  readonly weather?: InferDeviceProxyCap<typeof weatherCapability>
  readonly weatherStation?: InferDeviceProxyCap<typeof weatherStationCapability>
  readonly webrtcSession?: InferDeviceProxyCap<typeof webrtcSessionCapability>
  readonly workload?: InferDeviceProxyCap<typeof workloadCapability>
  readonly zoneAnalytics?: InferDeviceProxyCap<typeof zoneAnalyticsCapability>
  readonly zoneRules?: InferDeviceProxyCap<typeof zoneRulesCapability>
  readonly zones?: InferDeviceProxyCap<typeof zonesCapability>
  readonly actions: Pick<InferDeviceProxyCap<typeof actionsCapability>, 'get' | 'run' | 'listForCamera' | 'getLinks'>
  readonly addonSettings: Pick<InferDeviceProxyCap<typeof addonSettingsCapability>, 'getDeviceSettings' | 'updateDeviceSettings'>
  readonly audioAnalyzer: Pick<InferDeviceProxyCap<typeof audioAnalyzerCapability>, 'detachDevice'>
  readonly coreBlocks: Pick<InferDeviceProxyCap<typeof coreBlocksCapability>, 'proposeRunningThreshold'>
  readonly deviceAdoption: Pick<InferDeviceProxyCap<typeof deviceAdoptionCapability>, 'getStatus'>
  readonly deviceExport: Pick<InferDeviceProxyCap<typeof deviceExportCapability>, 'getDeviceSettingsContribution' | 'getDeviceLiveContribution' | 'applyDeviceSettingsPatch'>
  readonly deviceHistory: Pick<InferDeviceProxyCap<typeof deviceHistoryCapability>, 'listSeries' | 'query' | 'getDeviceEnabled' | 'setDeviceEnabled' | 'deleteSeriesRange'>
  readonly deviceManager: Pick<InferDeviceProxyCap<typeof deviceManagerCapability>, 'loadConfig' | 'loadRuntimeState' | 'loadMeta' | 'setName' | 'setAlias' | 'setLocation' | 'setTags' | 'setType' | 'setIntegrationId' | 'setLinkDeviceId' | 'setPrimaryChildEntityId' | 'setChildLayout' | 'setPrimaryChildPreference' | 'setDisplay' | 'getWireableFields' | 'setRole' | 'applyInitialMeta' | 'setMetadata' | 'setIdentifiers' | 'setDisabled' | 'getDevice' | 'getLinkedDevices' | 'getStreamSources' | 'getConfigSchema' | 'getSettingsSchema' | 'updateConfig' | 'enable' | 'disable' | 'remove' | 'getStreamProfileMap' | 'setStreamProfileMap' | 'probeStreams' | 'getBindings' | 'setWrapperActive' | 'getWrapperActivation' | 'getDeviceSettingsAggregate' | 'getDeviceLiveInfoAggregate' | 'getDeviceAggregate' | 'runDeviceAction' | 'updateDeviceField' | 'updateDeviceFieldsBatch' | 'testField' | 'getDeviceStatusAggregate'>
  readonly deviceState: Pick<InferDeviceProxyCap<typeof deviceStateCapability>, 'getSnapshot' | 'getCapSlice' | 'setCapSlice' | 'claimFields' | 'patchOwnedFields' | 'releaseClaim' | 'getNativeCapSlice'>
  readonly faceGallery: Pick<InferDeviceProxyCap<typeof faceGalleryCapability>, 'listRecentFaces' | 'getFaceByTrack'>
  readonly networkQuality: Pick<InferDeviceProxyCap<typeof networkQualityCapability>, 'getDeviceStats' | 'reportClientStats'>
  readonly notificationRules: Pick<InferDeviceProxyCap<typeof notificationRulesCapability>, 'setDeviceMuted'>
  readonly osdManager: Pick<InferDeviceProxyCap<typeof osdManagerCapability>, 'getDeviceOsd' | 'setSlotBinding' | 'clearSlotBinding' | 'setSlotCameraEnabled' | 'previewSlot' | 'previewTemplate' | 'renderDevice'>
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
  function callLeaf(capProp: string, method: string, kind: Kind, merged: unknown, push: unknown, options?: CommandOriginRequestOptions): any {
    return invokeTrpcLeaf(api, capProp, method, kind, merged, push, options)
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
  function dispatch(capName: string, capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown, options?: CommandOriginRequestOptions): any {
    const entry = binding.entries.find((e) => e.capName === capName)
    return callLeaf(capProp, method, kind, mergeInput(input, entry?.providerNodeId), push, options)
  }

  /**
   * System-cap dispatch. No binding gate — system caps are cluster-wide
   * singletons; the nodeId is left absent so caps that load-balance (e.g.
   * `pipeline-runner`) can resolve their own target node.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatchSystem(capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown, options?: CommandOriginRequestOptions): any {
    return callLeaf(capProp, method, kind, mergeInput(input, undefined), push, options)
  }

  /** True when this device's binding lists the cap — gates device-scoped handles. */
  function bound(capName: string): boolean {
    return binding.entries.some((e) => e.capName === capName)
  }

  const accessoriesInterface = {
    setChildHidden: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('accessories', 'accessories', 'setChildHidden', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('accessories', 'accessories', 'getStatus', 'query', input, undefined, options),
  }

  const airQualitySensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('air-quality-sensor', 'airQualitySensor', 'getStatus', 'query', input, undefined, options),
  }

  const alarmPanelInterface = {
    trigger: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('alarm-panel', 'alarmPanel', 'trigger', 'mutation', input, undefined, options),
    disarm: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('alarm-panel', 'alarmPanel', 'disarm', 'mutation', input, undefined, options),
    arm: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('alarm-panel', 'alarmPanel', 'arm', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('alarm-panel', 'alarmPanel', 'getStatus', 'query', input, undefined, options),
  }

  const ambientLightSensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ambient-light-sensor', 'ambientLightSensor', 'getStatus', 'query', input, undefined, options),
  }

  const audioAnalysisInterface = {
    resolveDeviceSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-analysis', 'audioAnalysis', 'resolveDeviceSettings', 'query', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-analysis', 'audioAnalysis', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-analysis', 'audioAnalysis', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-analysis', 'audioAnalysis', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const audioMetricsInterface = {
    getCurrentSnapshot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-metrics', 'audioMetrics', 'getCurrentSnapshot', 'query', input, undefined, options),
    getHistory: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('audio-metrics', 'audioMetrics', 'getHistory', 'query', input, undefined, options),
  }

  const automationControlInterface = {
    enable: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('automation-control', 'automationControl', 'enable', 'mutation', input, undefined, options),
    disable: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('automation-control', 'automationControl', 'disable', 'mutation', input, undefined, options),
    trigger: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('automation-control', 'automationControl', 'trigger', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('automation-control', 'automationControl', 'getStatus', 'query', input, undefined, options),
  }

  const batteryInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('battery', 'battery', 'getStatus', 'query', input, undefined, options),
  }

  const binaryInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('binary', 'binary', 'getStatus', 'query', input, undefined, options),
  }

  const brightnessInterface = {
    setBrightness: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('brightness', 'brightness', 'setBrightness', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('brightness', 'brightness', 'getStatus', 'query', input, undefined, options),
  }

  const buttonInterface = {
    press: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('button', 'button', 'press', 'mutation', input, undefined, options),
  }

  const cameraCredentialsInterface = {
    getCredentials: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-credentials', 'cameraCredentials', 'getCredentials', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-credentials', 'cameraCredentials', 'getStatus', 'query', input, undefined, options),
  }

  const cameraGridLayoutInterface = {
    getLayout: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getLayout', 'query', input, undefined, options),
    saveLayout: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-grid-layout', 'cameraGridLayout', 'saveLayout', 'mutation', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-grid-layout', 'cameraGridLayout', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-grid-layout', 'cameraGridLayout', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const cameraPipelineConfigInterface = {
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-pipeline-config', 'cameraPipelineConfig', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const cameraStreamsInterface = {
    getCameraStreams: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-streams', 'cameraStreams', 'getCameraStreams', 'query', input, undefined, options),
    getBrokerStreams: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-streams', 'cameraStreams', 'getBrokerStreams', 'query', input, undefined, options),
    getRtspEntries: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-streams', 'cameraStreams', 'getRtspEntries', 'query', input, undefined, options),
    getProfileRtspEntries: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-streams', 'cameraStreams', 'getProfileRtspEntries', 'query', input, undefined, options),
    pickStream: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('camera-streams', 'cameraStreams', 'pickStream', 'query', input, undefined, options),
  }

  const carbonMonoxideInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('carbon-monoxide', 'carbonMonoxide', 'getStatus', 'query', input, undefined, options),
  }

  const climateControlInterface = {
    setMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setMode', 'mutation', input, undefined, options),
    setTarget: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setTarget', 'mutation', input, undefined, options),
    setTargetRange: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setTargetRange', 'mutation', input, undefined, options),
    setTargetHumidity: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setTargetHumidity', 'mutation', input, undefined, options),
    setFanMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setFanMode', 'mutation', input, undefined, options),
    setPreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setPreset', 'mutation', input, undefined, options),
    setSwingVertical: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setSwingVertical', 'mutation', input, undefined, options),
    setSwingHorizontal: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'setSwingHorizontal', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('climate-control', 'climateControl', 'getStatus', 'query', input, undefined, options),
  }

  const colorInterface = {
    setColor: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('color', 'color', 'setColor', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('color', 'color', 'getStatus', 'query', input, undefined, options),
  }

  const connectivityInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('connectivity', 'connectivity', 'getStatus', 'query', input, undefined, options),
  }

  const consumablesInterface = {
    reset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('consumables', 'consumables', 'reset', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('consumables', 'consumables', 'getStatus', 'query', input, undefined, options),
  }

  const contactInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('contact', 'contact', 'getStatus', 'query', input, undefined, options),
  }

  const controlInterface = {
    setValue: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'setValue', 'mutation', input, undefined, options),
    next: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'next', 'mutation', input, undefined, options),
    previous: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'previous', 'mutation', input, undefined, options),
    first: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'first', 'mutation', input, undefined, options),
    last: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'last', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('control', 'control', 'getStatus', 'query', input, undefined, options),
  }

  const coverInterface = {
    open: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'open', 'mutation', input, undefined, options),
    close: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'close', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'stop', 'mutation', input, undefined, options),
    setPosition: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'setPosition', 'mutation', input, undefined, options),
    setTiltPosition: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'setTiltPosition', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('cover', 'cover', 'getStatus', 'query', input, undefined, options),
  }

  const dayNightInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('day-night', 'dayNight', 'getOptions', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('day-night', 'dayNight', 'setSettings', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('day-night', 'dayNight', 'getStatus', 'query', input, undefined, options),
  }

  const detectionPipelineInterface = {
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('detection-pipeline', 'detectionPipeline', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('detection-pipeline', 'detectionPipeline', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('detection-pipeline', 'detectionPipeline', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const deviceAdminLinkInterface = {
    getAdminLink: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-admin-link', 'deviceAdminLink', 'getAdminLink', 'query', input, undefined, options),
  }

  const deviceExtensionInterface = {
    listSources: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-extension', 'deviceExtension', 'listSources', 'query', input, undefined, options),
    listSlots: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-extension', 'deviceExtension', 'listSlots', 'query', input, undefined, options),
    listCandidates: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-extension', 'deviceExtension', 'listCandidates', 'query', input, undefined, options),
    setSlot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-extension', 'deviceExtension', 'setSlot', 'mutation', input, undefined, options),
  }

  const deviceOpsInterface = {
    getStreamSources: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'getStreamSources', 'query', input, undefined, options),
    getConfigEntries: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'getConfigEntries', 'query', input, undefined, options),
    setConfig: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'setConfig', 'mutation', input, undefined, options),
    runAction: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'runAction', 'mutation', input, undefined, options),
    removeDevice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'removeDevice', 'mutation', input, undefined, options),
    getSettingsSchema: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'getSettingsSchema', 'query', input, undefined, options),
    getRawState: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-ops', 'deviceOps', 'getRawState', 'query', input, undefined, options),
  }

  const deviceRunsInterface = {
    listRuns: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-runs', 'deviceRuns', 'listRuns', 'query', input, undefined, options),
    getRun: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-runs', 'deviceRuns', 'getRun', 'query', input, undefined, options),
    getCurrentRun: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-runs', 'deviceRuns', 'getCurrentRun', 'query', input, undefined, options),
  }

  const deviceStatusInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-status', 'deviceStatus', 'getStatus', 'query', input, undefined, options),
  }

  const deviceTransitionsInterface = {
    listTransitions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-transitions', 'deviceTransitions', 'listTransitions', 'query', input, undefined, options),
    getTransition: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-transitions', 'deviceTransitions', 'getTransition', 'query', input, undefined, options),
    listRecentTransitions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-transitions', 'deviceTransitions', 'listRecentTransitions', 'query', input, undefined, options),
    record: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-transitions', 'deviceTransitions', 'record', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('device-transitions', 'deviceTransitions', 'getStatus', 'query', input, undefined, options),
  }

  const dishwasherInterface = {
    start: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'start', 'mutation', input, undefined, options),
    pause: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'pause', 'mutation', input, undefined, options),
    resume: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'resume', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'stop', 'mutation', input, undefined, options),
    setProgram: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setProgram', 'mutation', input, undefined, options),
    setPower: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setPower', 'mutation', input, undefined, options),
    setHalfLoad: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setHalfLoad', 'mutation', input, undefined, options),
    setHygienePlus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setHygienePlus', 'mutation', input, undefined, options),
    setExtraDry: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setExtraDry', 'mutation', input, undefined, options),
    setIntensiveZone: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setIntensiveZone', 'mutation', input, undefined, options),
    setVarioSpeedPlus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setVarioSpeedPlus', 'mutation', input, undefined, options),
    setChildLock: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setChildLock', 'mutation', input, undefined, options),
    setOption: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'setOption', 'mutation', input, undefined, options),
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'getOptions', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('dishwasher', 'dishwasher', 'getStatus', 'query', input, undefined, options),
  }

  const doNotDisturbInterface = {
    setEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('do-not-disturb', 'doNotDisturb', 'setEnabled', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('do-not-disturb', 'doNotDisturb', 'getStatus', 'query', input, undefined, options),
  }

  const doorbellInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('doorbell', 'doorbell', 'getStatus', 'query', input, undefined, options),
  }

  const energySystemInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('energy-system', 'energySystem', 'getStatus', 'query', input, undefined, options),
  }

  const enumSensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('enum-sensor', 'enumSensor', 'getStatus', 'query', input, undefined, options),
  }

  const errorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('error', 'error', 'getStatus', 'query', input, undefined, options),
  }

  const eventEmitterInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('event-emitter', 'eventEmitter', 'getStatus', 'query', input, undefined, options),
  }

  const fanControlInterface = {
    setPercentage: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'setPercentage', 'mutation', input, undefined, options),
    setPreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'setPreset', 'mutation', input, undefined, options),
    setDirection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'setDirection', 'mutation', input, undefined, options),
    setOscillating: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'setOscillating', 'mutation', input, undefined, options),
    setOscillationAxis: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'setOscillationAxis', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('fan-control', 'fanControl', 'getStatus', 'query', input, undefined, options),
  }

  const featureProbeInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('feature-probe', 'featureProbe', 'getStatus', 'query', input, undefined, options),
  }

  const floodInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('flood', 'flood', 'getStatus', 'query', input, undefined, options),
  }

  const gasInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('gas', 'gas', 'getStatus', 'query', input, undefined, options),
  }

  const groupActiveInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('group-active', 'groupActive', 'getStatus', 'query', input, undefined, options),
  }

  const groupCommandsInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('group-commands', 'groupCommands', 'getStatus', 'query', input, undefined, options),
  }

  const groupStatusInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('group-status', 'groupStatus', 'getStatus', 'query', input, undefined, options),
  }

  const heatingValveInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heating-valve', 'heatingValve', 'getStatus', 'query', input, undefined, options),
  }

  const heatPumpControlInterface = {
    setSilentMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setSilentMode', 'mutation', input, undefined, options),
    setAwayMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setAwayMode', 'mutation', input, undefined, options),
    setAdditionalHeaterMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setAdditionalHeaterMode', 'mutation', input, undefined, options),
    setHolidayMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setHolidayMode', 'mutation', input, undefined, options),
    setCircuitOperationMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitOperationMode', 'mutation', input, undefined, options),
    setCircuitHeatCoolMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitHeatCoolMode', 'mutation', input, undefined, options),
    setCircuitSummerWinter: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitSummerWinter', 'mutation', input, undefined, options),
    setCircuitComfortSetpoint: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitComfortSetpoint', 'mutation', input, undefined, options),
    setCircuitEcoSetpoint: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitEcoSetpoint', 'mutation', input, undefined, options),
    setCircuitMaxFlowTemp: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setCircuitMaxFlowTemp', 'mutation', input, undefined, options),
    setDhwOperationMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setDhwOperationMode', 'mutation', input, undefined, options),
    setDhwTemperatureLevel: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setDhwTemperatureLevel', 'mutation', input, undefined, options),
    setDhwChargeDuration: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'setDhwChargeDuration', 'mutation', input, undefined, options),
    startExtraHotWater: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-control', 'heatPumpControl', 'startExtraHotWater', 'mutation', input, undefined, options),
  }

  const heatPumpStatusInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('heat-pump-status', 'heatPumpStatus', 'getStatus', 'query', input, undefined, options),
  }

  const humidifierInterface = {
    setOn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('humidifier', 'humidifier', 'setOn', 'mutation', input, undefined, options),
    setTargetHumidity: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('humidifier', 'humidifier', 'setTargetHumidity', 'mutation', input, undefined, options),
    setMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('humidifier', 'humidifier', 'setMode', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('humidifier', 'humidifier', 'getStatus', 'query', input, undefined, options),
  }

  const humiditySensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('humidity-sensor', 'humiditySensor', 'getStatus', 'query', input, undefined, options),
  }

  const imageInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('image', 'image', 'getStatus', 'query', input, undefined, options),
  }

  const imageSettingsInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('image-settings', 'imageSettings', 'getOptions', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('image-settings', 'imageSettings', 'setSettings', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('image-settings', 'imageSettings', 'getStatus', 'query', input, undefined, options),
  }

  const intercomInterface = {
    startSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'startSession', 'mutation', input, undefined, options),
    handleAnswer: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'handleAnswer', 'mutation', input, undefined, options),
    stopSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'stopSession', 'mutation', input, undefined, options),
    startTalkSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'startTalkSession', 'mutation', input, undefined, options),
    pushTalkAudio: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'pushTalkAudio', 'mutation', input, undefined, options),
    endTalkSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'endTalkSession', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('intercom', 'intercom', 'getStatus', 'query', input, undefined, options),
  }

  const irTransmitterInterface = {
    send: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ir-transmitter', 'irTransmitter', 'send', 'mutation', input, undefined, options),
    learn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ir-transmitter', 'irTransmitter', 'learn', 'mutation', input, undefined, options),
    getInfo: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ir-transmitter', 'irTransmitter', 'getInfo', 'query', input, undefined, options),
  }

  const lawnMowerControlInterface = {
    startMowing: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lawn-mower-control', 'lawnMowerControl', 'startMowing', 'mutation', input, undefined, options),
    pause: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lawn-mower-control', 'lawnMowerControl', 'pause', 'mutation', input, undefined, options),
    dock: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lawn-mower-control', 'lawnMowerControl', 'dock', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lawn-mower-control', 'lawnMowerControl', 'getStatus', 'query', input, undefined, options),
  }

  const lockControlInterface = {
    lock: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lock-control', 'lockControl', 'lock', 'mutation', input, undefined, options),
    unlock: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lock-control', 'lockControl', 'unlock', 'mutation', input, undefined, options),
    open: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lock-control', 'lockControl', 'open', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('lock-control', 'lockControl', 'getStatus', 'query', input, undefined, options),
  }

  const lowPowerSleepInterface = {
    wakeUp: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('low-power-sleep', 'lowPowerSleep', 'wakeUp', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('low-power-sleep', 'lowPowerSleep', 'getStatus', 'query', input, undefined, options),
  }

  const mediaPlayerInterface = {
    turnOn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'turnOn', 'mutation', input, undefined, options),
    turnOff: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'turnOff', 'mutation', input, undefined, options),
    volumeUp: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'volumeUp', 'mutation', input, undefined, options),
    volumeDown: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'volumeDown', 'mutation', input, undefined, options),
    channelUp: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'channelUp', 'mutation', input, undefined, options),
    channelDown: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'channelDown', 'mutation', input, undefined, options),
    play: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'play', 'mutation', input, undefined, options),
    pause: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'pause', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'stop', 'mutation', input, undefined, options),
    next: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'next', 'mutation', input, undefined, options),
    previous: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'previous', 'mutation', input, undefined, options),
    setVolume: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'setVolume', 'mutation', input, undefined, options),
    setMute: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'setMute', 'mutation', input, undefined, options),
    setShuffle: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'setShuffle', 'mutation', input, undefined, options),
    setRepeat: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'setRepeat', 'mutation', input, undefined, options),
    selectSource: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'selectSource', 'mutation', input, undefined, options),
    seek: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'seek', 'mutation', input, undefined, options),
    playMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'playMedia', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('media-player', 'mediaPlayer', 'getStatus', 'query', input, undefined, options),
  }

  const meterInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('meter', 'meter', 'getStatus', 'query', input, undefined, options),
  }

  const motionInterface = {
    isDetected: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion', 'motion', 'isDetected', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion', 'motion', 'getStatus', 'query', input, undefined, options),
  }

  const motionDetectionInterface = {
    analyze: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'analyze', 'mutation', input, undefined, options),
    removeCamera: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'removeCamera', 'mutation', input, undefined, options),
    reset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'reset', 'mutation', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-detection', 'motionDetection', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const motionTriggerInterface = {
    setMotionTrigger: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-trigger', 'motionTrigger', 'setMotionTrigger', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-trigger', 'motionTrigger', 'getStatus', 'query', input, undefined, options),
  }

  const motionZonesInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-zones', 'motionZones', 'getOptions', 'query', input, undefined, options),
    setZone: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-zones', 'motionZones', 'setZone', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('motion-zones', 'motionZones', 'getStatus', 'query', input, undefined, options),
  }

  const nativeObjectDetectionInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('native-object-detection', 'nativeObjectDetection', 'getOptions', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('native-object-detection', 'nativeObjectDetection', 'setSettings', 'mutation', input, undefined, options),
    setEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('native-object-detection', 'nativeObjectDetection', 'setEnabled', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('native-object-detection', 'nativeObjectDetection', 'getStatus', 'query', input, undefined, options),
  }

  const navigationInterface = {
    move: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'move', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'stop', 'mutation', input, undefined, options),
    goToPoint: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'goToPoint', 'mutation', input, undefined, options),
    listActions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'listActions', 'query', input, undefined, options),
    runAction: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'runAction', 'mutation', input, undefined, options),
    playSound: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'playSound', 'mutation', input, undefined, options),
    setLightOn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'setLightOn', 'mutation', input, undefined, options),
    setLightMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'setLightMode', 'mutation', input, undefined, options),
    setLightLevel: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'setLightLevel', 'mutation', input, undefined, options),
    getFeatures: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'getFeatures', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('navigation', 'navigation', 'getStatus', 'query', input, undefined, options),
  }

  const networkLinkInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('network-link', 'networkLink', 'getStatus', 'query', input, undefined, options),
  }

  const notifierInterface = {
    send: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('notifier', 'notifier', 'send', 'mutation', input, undefined, options),
    cancel: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('notifier', 'notifier', 'cancel', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('notifier', 'notifier', 'getStatus', 'query', input, undefined, options),
  }

  const numericSensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('numeric-sensor', 'numericSensor', 'getStatus', 'query', input, undefined, options),
  }

  const osdInterface = {
    setOverlay: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('osd', 'osd', 'setOverlay', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('osd', 'osd', 'getStatus', 'query', input, undefined, options),
  }

  const petFeederInterface = {
    feed: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'feed', 'mutation', input, undefined, options),
    cancelFeed: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'cancelFeed', 'mutation', input, undefined, options),
    callPet: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'callPet', 'mutation', input, undefined, options),
    playSound: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'playSound', 'mutation', input, undefined, options),
    resetDesiccant: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'resetDesiccant', 'mutation', input, undefined, options),
    markFoodReplenished: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'markFoodReplenished', 'mutation', input, undefined, options),
    setChildLock: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'setChildLock', 'mutation', input, undefined, options),
    setIndicatorLight: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'setIndicatorLight', 'mutation', input, undefined, options),
    setFeedSound: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'setFeedSound', 'mutation', input, undefined, options),
    setVolume: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'setVolume', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-feeder', 'petFeeder', 'getStatus', 'query', input, undefined, options),
  }

  const petFountainInterface = {
    setPump: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-fountain', 'petFountain', 'setPump', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pet-fountain', 'petFountain', 'getStatus', 'query', input, undefined, options),
  }

  const pipelineAnalyticsInterface = {
    getActiveTracks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getActiveTracks', 'query', input, undefined, options),
    getTrack: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrack', 'query', input, undefined, options),
    listTracks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTracks', 'query', input, undefined, options),
    listRecentTracks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRecentTracks', 'query', input, undefined, options),
    clearTracks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'clearTracks', 'mutation', input, undefined, options),
    getMotionEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getMotionEvents', 'query', input, undefined, options),
    getObjectEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getObjectEvents', 'query', input, undefined, options),
    getAudioEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getAudioEvents', 'query', input, undefined, options),
    listEventKinds: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventKinds', 'query', input, undefined, options),
    listEventKindsBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventKindsBatch', 'query', input, undefined, options),
    getSensorEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getSensorEvents', 'query', input, undefined, options),
    getKeyEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getKeyEvents', 'query', input, undefined, options),
    getKeyEventsBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getKeyEventsBatch', 'query', input, undefined, options),
    readLongTermSeries: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'readLongTermSeries', 'query', input, undefined, options),
    getEventDensity: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventDensity', 'query', input, undefined, options),
    getEventDensityBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventDensityBatch', 'query', input, undefined, options),
    pruneEventsBefore: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneEventsBefore', 'mutation', input, undefined, options),
    pruneTracksBefore: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneTracksBefore', 'mutation', input, undefined, options),
    wipeAllAnalytics: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'wipeAllAnalytics', 'mutation', input, undefined, options),
    reconcileFromDisk: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'reconcileFromDisk', 'mutation', input, undefined, options),
    deleteTracks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteTracks', 'mutation', input, undefined, options),
    setTrackFlags: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackFlags', 'mutation', input, undefined, options),
    listArchivedDebugNotes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listArchivedDebugNotes', 'query', input, undefined, options),
    setTrackRelation: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackRelation', 'mutation', input, undefined, options),
    clearTrackRelation: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'clearTrackRelation', 'mutation', input, undefined, options),
    setTrackPurity: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setTrackPurity', 'mutation', input, undefined, options),
    listTrackRelations: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTrackRelations', 'query', input, undefined, options),
    listBirthDecisions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listBirthDecisions', 'query', input, undefined, options),
    getEventStoreFootprint: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventStoreFootprint', 'query', input, undefined, options),
    getEventMediaFootprintByKind: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventMediaFootprintByKind', 'query', input, undefined, options),
    pruneEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pruneEvents', 'mutation', input, undefined, options),
    deleteDeviceEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteDeviceEvents', 'mutation', input, undefined, options),
    pauseForStorageMigration: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'pauseForStorageMigration', 'mutation', input, undefined, options),
    resumeForStorageMigration: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'resumeForStorageMigration', 'mutation', input, undefined, options),
    refreshStorageLocationsForMigration: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'refreshStorageLocationsForMigration', 'mutation', input, undefined, options),
    startStorageMigrationMove: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'startStorageMigrationMove', 'mutation', input, undefined, options),
    getStorageMigrationMoveStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getStorageMigrationMoveStatus', 'query', input, undefined, options),
    cancelStorageMigrationMove: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'cancelStorageMigrationMove', 'mutation', input, undefined, options),
    relocateMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'relocateMedia', 'mutation', input, undefined, options),
    countUnstampedEventMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'countUnstampedEventMedia', 'query', input, undefined, options),
    getMediaLocationCensus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getMediaLocationCensus', 'query', input, undefined, options),
    countRelocatableMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'countRelocatableMedia', 'query', input, undefined, options),
    listRelocateMediaJobs: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRelocateMediaJobs', 'query', input, undefined, options),
    cancelRelocateMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'cancelRelocateMedia', 'mutation', input, undefined, options),
    listOpsLog: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listOpsLog', 'query', input, undefined, options),
    reclaimDebugMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'reclaimDebugMedia', 'mutation', input, undefined, options),
    getMediaReclaimStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getMediaReclaimStatus', 'query', input, undefined, options),
    getTrainingExportSummary: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrainingExportSummary', 'query', input, undefined, options),
    getTrainingExportUrl: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrainingExportUrl', 'query', input, undefined, options),
    listRetrainStaging: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainStaging', 'query', input, undefined, options),
    listRetrainCorpusPage: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCorpusPage', 'query', input, undefined, options),
    getRetrainCorpusKpi: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainCorpusKpi', 'query', input, undefined, options),
    listRetrainFrames: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainFrames', 'query', input, undefined, options),
    selectRetrainFrames: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'selectRetrainFrames', 'mutation', input, undefined, options),
    deselectRetrainFrame: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deselectRetrainFrame', 'mutation', input, undefined, options),
    getRetrainFrameImage: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainFrameImage', 'query', input, undefined, options),
    proposeRetrainAnnotations: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'proposeRetrainAnnotations', 'mutation', input, undefined, options),
    listRetrainAnnotations: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainAnnotations', 'query', input, undefined, options),
    saveRetrainAnnotations: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'saveRetrainAnnotations', 'mutation', input, undefined, options),
    backfillRetrainOrigins: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'backfillRetrainOrigins', 'mutation', input, undefined, options),
    completeRetrainTrack: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'completeRetrainTrack', 'mutation', input, undefined, options),
    restageRetrainTrack: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'restageRetrainTrack', 'mutation', input, undefined, options),
    getRetrainExportUrl: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getRetrainExportUrl', 'query', input, undefined, options),
    setRetrainFrameComplete: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'setRetrainFrameComplete', 'mutation', input, undefined, options),
    writeRetrainArchive: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'writeRetrainArchive', 'mutation', input, undefined, options),
    offerRetrainArchive: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'offerRetrainArchive', 'mutation', input, undefined, options),
    listRetrainAssistProfiles: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainAssistProfiles', 'query', input, undefined, options),
    proposeRetrainAnnotationsWithLlm: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'proposeRetrainAnnotationsWithLlm', 'mutation', input, undefined, options),
    createRetrainCollection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'createRetrainCollection', 'mutation', input, undefined, options),
    listRetrainCollections: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCollections', 'query', input, undefined, options),
    resolveRetrainTrainingCorpus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'resolveRetrainTrainingCorpus', 'query', input, undefined, options),
    renameRetrainCollection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'renameRetrainCollection', 'mutation', input, undefined, options),
    deleteRetrainCollection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'deleteRetrainCollection', 'mutation', input, undefined, options),
    addRetrainFrameFromRecording: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'addRetrainFrameFromRecording', 'mutation', input, undefined, options),
    addRetrainFramesToCollection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'addRetrainFramesToCollection', 'mutation', input, undefined, options),
    removeRetrainFrameFromCollection: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'removeRetrainFrameFromCollection', 'mutation', input, undefined, options),
    listRetrainCollectionFrames: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listRetrainCollectionFrames', 'query', input, undefined, options),
    getEventMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getEventMedia', 'query', input, undefined, options),
    getTrackMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getTrackMedia', 'query', input, undefined, options),
    listTrackMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listTrackMedia', 'query', input, undefined, options),
    listEventMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'listEventMedia', 'query', input, undefined, options),
    ownersWithMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'ownersWithMedia', 'query', input, undefined, options),
    searchObjectEvents: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'searchObjectEvents', 'query', input, undefined, options),
    wipeObjectEmbeddings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'wipeObjectEmbeddings', 'mutation', input, undefined, options),
    rebuildObjectEmbeddings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'rebuildObjectEmbeddings', 'mutation', input, undefined, options),
    getObjectEmbeddingRebuildStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getObjectEmbeddingRebuildStatus', 'query', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pipeline-analytics', 'pipelineAnalytics', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const powerMeterInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('power-meter', 'powerMeter', 'getStatus', 'query', input, undefined, options),
  }

  const powerSourceInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('power-source', 'powerSource', 'getStatus', 'query', input, undefined, options),
    powerOn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('power-source', 'powerSource', 'powerOn', 'mutation', input, undefined, options),
    powerOff: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('power-source', 'powerSource', 'powerOff', 'mutation', input, undefined, options),
    forceRestart: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('power-source', 'powerSource', 'forceRestart', 'mutation', input, undefined, options),
  }

  const presenceInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('presence', 'presence', 'getStatus', 'query', input, undefined, options),
  }

  const pressureSensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pressure-sensor', 'pressureSensor', 'getStatus', 'query', input, undefined, options),
  }

  const privacyMaskInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('privacy-mask', 'privacyMask', 'getOptions', 'query', input, undefined, options),
    setMask: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('privacy-mask', 'privacyMask', 'setMask', 'mutation', input, undefined, options),
    setAudioEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('privacy-mask', 'privacyMask', 'setAudioEnabled', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('privacy-mask', 'privacyMask', 'getStatus', 'query', input, undefined, options),
  }

  const ptzInterface = {
    move: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'move', 'mutation', input, undefined, options),
    continuousMove: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'continuousMove', 'mutation', input, undefined, options),
    goHome: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'goHome', 'mutation', input, undefined, options),
    getPresets: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getPresets', 'query', input, undefined, options),
    goToPreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'goToPreset', 'mutation', input, undefined, options),
    savePreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'savePreset', 'mutation', input, undefined, options),
    deletePreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'deletePreset', 'mutation', input, undefined, options),
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getOptions', 'query', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'stop', 'mutation', input, undefined, options),
    getHomePreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getHomePreset', 'query', input, undefined, options),
    setHomePreset: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'setHomePreset', 'mutation', input, undefined, options),
    captureHomeHere: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'captureHomeHere', 'mutation', input, undefined, options),
    getHomeReturn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getHomeReturn', 'query', input, undefined, options),
    setHomeReturn: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'setHomeReturn', 'mutation', input, undefined, options),
    getPosition: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getPosition', 'query', input, undefined, options),
    setAutofocus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'setAutofocus', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz', 'ptz', 'getStatus', 'query', input, undefined, options),
  }

  const ptzAutotrackInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz-autotrack', 'ptzAutotrack', 'getStatus', 'query', input, undefined, options),
    setEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz-autotrack', 'ptzAutotrack', 'setEnabled', 'mutation', input, undefined, options),
    getSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz-autotrack', 'ptzAutotrack', 'getSettings', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('ptz-autotrack', 'ptzAutotrack', 'setSettings', 'mutation', input, undefined, options),
  }

  const pumpCycleInterface = {
    setEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pump-cycle', 'pumpCycle', 'setEnabled', 'mutation', input, undefined, options),
    setOnMinutes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pump-cycle', 'pumpCycle', 'setOnMinutes', 'mutation', input, undefined, options),
    setOffMinutes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pump-cycle', 'pumpCycle', 'setOffMinutes', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('pump-cycle', 'pumpCycle', 'getStatus', 'query', input, undefined, options),
  }

  const rebootInterface = {
    reboot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('reboot', 'reboot', 'reboot', 'mutation', input, undefined, options),
  }

  const recordingInterface = {
    listSources: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording', 'recording', 'listSources', 'query', input, undefined, options),
    getAvailability: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording', 'recording', 'getAvailability', 'query', input, undefined, options),
    getDaysWithRecordings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording', 'recording', 'getDaysWithRecordings', 'query', input, undefined, options),
    getPlayback: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording', 'recording', 'getPlayback', 'query', input, undefined, options),
    getPlaybackOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording', 'recording', 'getPlaybackOptions', 'query', input, undefined, options),
  }

  const recordingOnboardInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording-onboard', 'recordingOnboard', 'getOptions', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording-onboard', 'recordingOnboard', 'setSettings', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording-onboard', 'recordingOnboard', 'getStatus', 'query', input, undefined, options),
  }

  const recordingSignalInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('recording-signal', 'recordingSignal', 'getStatus', 'query', input, undefined, options),
  }

  const resyncInterface = {
    resync: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('resync', 'resync', 'resync', 'mutation', input, undefined, options),
  }

  const runningStateInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('running-state', 'runningState', 'getStatus', 'query', input, undefined, options),
  }

  const sceneMonitorInterface = {
    listScenes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'listScenes', 'query', input, undefined, options),
    listScenesBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'listScenesBatch', 'query', input, undefined, options),
    createScene: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'createScene', 'mutation', input, undefined, options),
    updateScene: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'updateScene', 'mutation', input, undefined, options),
    deleteScene: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'deleteScene', 'mutation', input, undefined, options),
    captureReference: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'captureReference', 'mutation', input, undefined, options),
    deleteReference: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'deleteReference', 'mutation', input, undefined, options),
    recheckNow: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'recheckNow', 'mutation', input, undefined, options),
    resetScene: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'resetScene', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('scene-monitor', 'sceneMonitor', 'getStatus', 'query', input, undefined, options),
  }

  const scriptRunnerInterface = {
    run: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('script-runner', 'scriptRunner', 'run', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('script-runner', 'scriptRunner', 'stop', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('script-runner', 'scriptRunner', 'getStatus', 'query', input, undefined, options),
  }

  const sirenInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('siren', 'siren', 'getOptions', 'query', input, undefined, options),
    getPlayChoices: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('siren', 'siren', 'getPlayChoices', 'query', input, undefined, options),
    trigger: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('siren', 'siren', 'trigger', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('siren', 'siren', 'stop', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('siren', 'siren', 'getStatus', 'query', input, undefined, options),
  }

  const smokeInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('smoke', 'smoke', 'getStatus', 'query', input, undefined, options),
  }

  const snapshotInterface = {
    getSnapshot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getSnapshot', 'query', input, undefined, options),
    invalidateCache: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'invalidateCache', 'mutation', input, undefined, options),
    getSnapshotOverview: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getSnapshotOverview', 'query', input, undefined, options),
    getDebugState: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getDebugState', 'query', input, undefined, options),
    getSnapshotLinks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getSnapshotLinks', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getStatus', 'query', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('snapshot', 'snapshot', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const streamCatalogInterface = {
    getCatalog: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-catalog', 'streamCatalog', 'getCatalog', 'query', input, undefined, options),
  }

  const streamParamsInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-params', 'streamParams', 'getOptions', 'query', input, undefined, options),
    setProfile: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-params', 'streamParams', 'setProfile', 'mutation', input, undefined, options),
    getConfigSchema: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-params', 'streamParams', 'getConfigSchema', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-params', 'streamParams', 'getStatus', 'query', input, undefined, options),
  }

  const streamSignalsInterface = {
    listSignals: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('stream-signals', 'streamSignals', 'listSignals', 'query', input, undefined, options),
  }

  const switchInterface = {
    setState: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('switch', 'switch', 'setState', 'mutation', input, undefined, options),
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('switch', 'switch', 'getOptions', 'query', input, undefined, options),
    powerCycle: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('switch', 'switch', 'powerCycle', 'mutation', input, undefined, options),
    toggle: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('switch', 'switch', 'toggle', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('switch', 'switch', 'getStatus', 'query', input, undefined, options),
  }

  const tamperInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('tamper', 'tamper', 'getStatus', 'query', input, undefined, options),
  }

  const temperatureSensorInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('temperature-sensor', 'temperatureSensor', 'getStatus', 'query', input, undefined, options),
  }

  const timedRunInterface = {
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('timed-run', 'timedRun', 'getOptions', 'query', input, undefined, options),
    setSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('timed-run', 'timedRun', 'setSettings', 'mutation', input, undefined, options),
    runFor: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('timed-run', 'timedRun', 'runFor', 'mutation', input, undefined, options),
    cancel: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('timed-run', 'timedRun', 'cancel', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('timed-run', 'timedRun', 'getStatus', 'query', input, undefined, options),
  }

  const updateInterface = {
    installUpdate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('update', 'update', 'installUpdate', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('update', 'update', 'getStatus', 'query', input, undefined, options),
  }

  const vacuumControlInterface = {
    start: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'start', 'mutation', input, undefined, options),
    pause: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'pause', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'stop', 'mutation', input, undefined, options),
    returnToBase: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'returnToBase', 'mutation', input, undefined, options),
    locate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'locate', 'mutation', input, undefined, options),
    setFanSpeed: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'setFanSpeed', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vacuum-control', 'vacuumControl', 'getStatus', 'query', input, undefined, options),
  }

  const valveInterface = {
    open: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('valve', 'valve', 'open', 'mutation', input, undefined, options),
    close: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('valve', 'valve', 'close', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('valve', 'valve', 'stop', 'mutation', input, undefined, options),
    setPosition: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('valve', 'valve', 'setPosition', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('valve', 'valve', 'getStatus', 'query', input, undefined, options),
  }

  const vibrationInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('vibration', 'vibration', 'getStatus', 'query', input, undefined, options),
  }

  const videoclipsInterface = {
    listClips: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'listClips', 'query', input, undefined, options),
    listSources: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'listSources', 'query', input, undefined, options),
    getClipPlayback: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'getClipPlayback', 'query', input, undefined, options),
    readClipBytes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'readClipBytes', 'query', input, undefined, options),
    offerClipBytes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'offerClipBytes', 'query', input, undefined, options),
    dialClipStream: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'dialClipStream', 'query', input, undefined, options),
    getPlaybackOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('videoclips', 'videoclips', 'getPlaybackOptions', 'query', input, undefined, options),
  }

  const waterHeaterInterface = {
    setOperationMode: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('water-heater', 'waterHeater', 'setOperationMode', 'mutation', input, undefined, options),
    setAway: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('water-heater', 'waterHeater', 'setAway', 'mutation', input, undefined, options),
    setTargetTemp: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('water-heater', 'waterHeater', 'setTargetTemp', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('water-heater', 'waterHeater', 'getStatus', 'query', input, undefined, options),
  }

  const weatherInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('weather', 'weather', 'getStatus', 'query', input, undefined, options),
  }

  const weatherStationInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('weather-station', 'weatherStation', 'getStatus', 'query', input, undefined, options),
  }

  const webrtcSessionInterface = {
    listStreams: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'listStreams', 'query', input, undefined, options),
    createSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'createSession', 'mutation', input, undefined, options),
    handleOffer: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'handleOffer', 'mutation', input, undefined, options),
    handleAnswer: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'handleAnswer', 'mutation', input, undefined, options),
    addIceCandidate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'addIceCandidate', 'mutation', input, undefined, options),
    getIceCandidates: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'getIceCandidates', 'query', input, undefined, options),
    closeSession: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'closeSession', 'mutation', input, undefined, options),
    hasAdaptiveBitrate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'hasAdaptiveBitrate', 'query', input, undefined, options),
    getSessionState: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'getSessionState', 'query', input, undefined, options),
    applyDownlinkProbe: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'applyDownlinkProbe', 'mutation', input, undefined, options),
    getSessionDebug: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('webrtc-session', 'webrtcSession', 'getSessionDebug', 'query', input, undefined, options),
  }

  const workloadInterface = {
    start: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'start', 'mutation', input, undefined, options),
    stop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'stop', 'mutation', input, undefined, options),
    restart: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'restart', 'mutation', input, undefined, options),
    pause: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'pause', 'mutation', input, undefined, options),
    resume: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'resume', 'mutation', input, undefined, options),
    forceStop: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'forceStop', 'mutation', input, undefined, options),
    getOptions: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'getOptions', 'query', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('workload', 'workload', 'getStatus', 'query', input, undefined, options),
  }

  const zoneAnalyticsInterface = {
    getCurrentSnapshot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-analytics', 'zoneAnalytics', 'getCurrentSnapshot', 'query', input, undefined, options),
    getCurrentSnapshotBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-analytics', 'zoneAnalytics', 'getCurrentSnapshotBatch', 'query', input, undefined, options),
    getZoneHistory: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-analytics', 'zoneAnalytics', 'getZoneHistory', 'query', input, undefined, options),
    getCameraHistory: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-analytics', 'zoneAnalytics', 'getCameraHistory', 'query', input, undefined, options),
    getUnzonedHistory: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-analytics', 'zoneAnalytics', 'getUnzonedHistory', 'query', input, undefined, options),
  }

  const zoneRulesInterface = {
    listRules: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-rules', 'zoneRules', 'listRules', 'query', input, undefined, options),
    setRules: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zone-rules', 'zoneRules', 'setRules', 'mutation', input, undefined, options),
  }

  const zonesInterface = {
    listZones: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zones', 'zones', 'listZones', 'query', input, undefined, options),
    addZone: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zones', 'zones', 'addZone', 'mutation', input, undefined, options),
    removeZone: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zones', 'zones', 'removeZone', 'mutation', input, undefined, options),
    updateZone: (input?: unknown, options?: CommandOriginRequestOptions) => dispatch('zones', 'zones', 'updateZone', 'mutation', input, undefined, options),
  }

  const actionsInterface = {
    get: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('actions', 'get', 'query', input, undefined, options),
    run: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('actions', 'run', 'mutation', input, undefined, options),
    listForCamera: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('actions', 'listForCamera', 'query', input, undefined, options),
    getLinks: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('actions', 'getLinks', 'query', input, undefined, options),
  }

  const addonSettingsInterface = {
    getDeviceSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('addonSettings', 'getDeviceSettings', 'query', input, undefined, options),
    updateDeviceSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('addonSettings', 'updateDeviceSettings', 'mutation', input, undefined, options),
  }

  const audioAnalyzerInterface = {
    detachDevice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('audioAnalyzer', 'detachDevice', 'mutation', input, undefined, options),
  }

  const coreBlocksInterface = {
    proposeRunningThreshold: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('coreBlocks', 'proposeRunningThreshold', 'query', input, undefined, options),
  }

  const deviceAdoptionInterface = {
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceAdoption', 'getStatus', 'query', input, undefined, options),
  }

  const deviceExportInterface = {
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceExport', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceExport', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceExport', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const deviceHistoryInterface = {
    listSeries: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceHistory', 'listSeries', 'query', input, undefined, options),
    query: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceHistory', 'query', 'query', input, undefined, options),
    getDeviceEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceHistory', 'getDeviceEnabled', 'query', input, undefined, options),
    setDeviceEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceHistory', 'setDeviceEnabled', 'mutation', input, undefined, options),
    deleteSeriesRange: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceHistory', 'deleteSeriesRange', 'mutation', input, undefined, options),
  }

  const deviceManagerInterface = {
    loadConfig: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'loadConfig', 'query', input, undefined, options),
    loadRuntimeState: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'loadRuntimeState', 'query', input, undefined, options),
    loadMeta: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'loadMeta', 'query', input, undefined, options),
    setName: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setName', 'mutation', input, undefined, options),
    setAlias: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setAlias', 'mutation', input, undefined, options),
    setLocation: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setLocation', 'mutation', input, undefined, options),
    setTags: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setTags', 'mutation', input, undefined, options),
    setType: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setType', 'mutation', input, undefined, options),
    setIntegrationId: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setIntegrationId', 'mutation', input, undefined, options),
    setLinkDeviceId: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setLinkDeviceId', 'mutation', input, undefined, options),
    setPrimaryChildEntityId: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setPrimaryChildEntityId', 'mutation', input, undefined, options),
    setChildLayout: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setChildLayout', 'mutation', input, undefined, options),
    setPrimaryChildPreference: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setPrimaryChildPreference', 'mutation', input, undefined, options),
    setDisplay: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setDisplay', 'mutation', input, undefined, options),
    getWireableFields: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getWireableFields', 'query', input, undefined, options),
    setRole: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setRole', 'mutation', input, undefined, options),
    applyInitialMeta: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'applyInitialMeta', 'mutation', input, undefined, options),
    setMetadata: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setMetadata', 'mutation', input, undefined, options),
    setIdentifiers: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setIdentifiers', 'mutation', input, undefined, options),
    setDisabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setDisabled', 'mutation', input, undefined, options),
    getDevice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getDevice', 'query', input, undefined, options),
    getLinkedDevices: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getLinkedDevices', 'query', input, undefined, options),
    getStreamSources: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getStreamSources', 'query', input, undefined, options),
    getConfigSchema: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getConfigSchema', 'query', input, undefined, options),
    getSettingsSchema: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getSettingsSchema', 'query', input, undefined, options),
    updateConfig: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'updateConfig', 'mutation', input, undefined, options),
    enable: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'enable', 'mutation', input, undefined, options),
    disable: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'disable', 'mutation', input, undefined, options),
    remove: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'remove', 'mutation', input, undefined, options),
    getStreamProfileMap: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getStreamProfileMap', 'query', input, undefined, options),
    setStreamProfileMap: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setStreamProfileMap', 'mutation', input, undefined, options),
    probeStreams: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'probeStreams', 'mutation', input, undefined, options),
    getBindings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getBindings', 'query', input, undefined, options),
    setWrapperActive: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'setWrapperActive', 'mutation', input, undefined, options),
    getWrapperActivation: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getWrapperActivation', 'query', input, undefined, options),
    getDeviceSettingsAggregate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getDeviceSettingsAggregate', 'query', input, undefined, options),
    getDeviceLiveInfoAggregate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getDeviceLiveInfoAggregate', 'query', input, undefined, options),
    getDeviceAggregate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getDeviceAggregate', 'query', input, undefined, options),
    runDeviceAction: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'runDeviceAction', 'mutation', input, undefined, options),
    updateDeviceField: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'updateDeviceField', 'mutation', input, undefined, options),
    updateDeviceFieldsBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'updateDeviceFieldsBatch', 'mutation', input, undefined, options),
    testField: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'testField', 'mutation', input, undefined, options),
    getDeviceStatusAggregate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceManager', 'getDeviceStatusAggregate', 'query', input, undefined, options),
  }

  const deviceStateInterface = {
    getSnapshot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'getSnapshot', 'query', input, undefined, options),
    getCapSlice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'getCapSlice', 'query', input, undefined, options),
    setCapSlice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'setCapSlice', 'mutation', input, undefined, options),
    claimFields: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'claimFields', 'mutation', input, undefined, options),
    patchOwnedFields: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'patchOwnedFields', 'mutation', input, undefined, options),
    releaseClaim: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'releaseClaim', 'mutation', input, undefined, options),
    getNativeCapSlice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('deviceState', 'getNativeCapSlice', 'query', input, undefined, options),
  }

  const faceGalleryInterface = {
    listRecentFaces: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('faceGallery', 'listRecentFaces', 'query', input, undefined, options),
    getFaceByTrack: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('faceGallery', 'getFaceByTrack', 'query', input, undefined, options),
  }

  const networkQualityInterface = {
    getDeviceStats: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('networkQuality', 'getDeviceStats', 'query', input, undefined, options),
    reportClientStats: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('networkQuality', 'reportClientStats', 'mutation', input, undefined, options),
  }

  const notificationRulesInterface = {
    setDeviceMuted: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('notificationRules', 'setDeviceMuted', 'mutation', input, undefined, options),
  }

  const osdManagerInterface = {
    getDeviceOsd: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'getDeviceOsd', 'query', input, undefined, options),
    setSlotBinding: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'setSlotBinding', 'mutation', input, undefined, options),
    clearSlotBinding: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'clearSlotBinding', 'mutation', input, undefined, options),
    setSlotCameraEnabled: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'setSlotCameraEnabled', 'mutation', input, undefined, options),
    previewSlot: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'previewSlot', 'mutation', input, undefined, options),
    previewTemplate: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'previewTemplate', 'mutation', input, undefined, options),
    renderDevice: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('osdManager', 'renderDevice', 'mutation', input, undefined, options),
  }

  const pipelineExecutorInterface = {
    runPipeline: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineExecutor', 'runPipeline', 'mutation', input, undefined, options),
    runPipelineBatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineExecutor', 'runPipelineBatch', 'mutation', input, undefined, options),
  }

  const pipelineOrchestratorInterface = {
    assignPipeline: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'assignPipeline', 'mutation', input, undefined, options),
    unassignPipeline: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'unassignPipeline', 'mutation', input, undefined, options),
    setPipelineDevicePin: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'setPipelineDevicePin', 'mutation', input, undefined, options),
    getPipelineDevicePin: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getPipelineDevicePin', 'query', input, undefined, options),
    getPipelineAssignment: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getPipelineAssignment', 'query', input, undefined, options),
    getCameraMetrics: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getCameraMetrics', 'query', input, undefined, options),
    assignAudio: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'assignAudio', 'mutation', input, undefined, options),
    unassignAudio: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'unassignAudio', 'mutation', input, undefined, options),
    getAudioAssignment: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getAudioAssignment', 'query', input, undefined, options),
    getCameraSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getCameraSettings', 'query', input, undefined, options),
    setCameraStepToggle: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'setCameraStepToggle', 'mutation', input, undefined, options),
    getCameraDetectionSource: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getCameraDetectionSource', 'query', input, undefined, options),
    setCameraDetectionSource: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'setCameraDetectionSource', 'mutation', input, undefined, options),
    setCameraStepSettings: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'setCameraStepSettings', 'mutation', input, undefined, options),
    resolvePipeline: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'resolvePipeline', 'query', input, undefined, options),
    getCameraSwitches: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getCameraSwitches', 'query', input, undefined, options),
    setCameraSwitch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'setCameraSwitch', 'mutation', input, undefined, options),
    getCameraStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getCameraStatus', 'query', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineOrchestrator', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const pipelineRunnerInterface = {
    detachCamera: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'detachCamera', 'mutation', input, undefined, options),
    getCameraMetrics: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'getCameraMetrics', 'query', input, undefined, options),
    requestOccupancyBurst: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'requestOccupancyBurst', 'mutation', input, undefined, options),
    runDetailSubtree: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'runDetailSubtree', 'mutation', input, undefined, options),
    parkTrackFrame: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'parkTrackFrame', 'mutation', input, undefined, options),
    getParkedTrackFrame: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'getParkedTrackFrame', 'query', input, undefined, options),
    releaseParkedTrackFrames: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('pipelineRunner', 'releaseParkedTrackFrames', 'mutation', input, undefined, options),
  }

  const plateGalleryInterface = {
    listPlates: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('plateGallery', 'listPlates', 'query', input, undefined, options),
    getPlateByTrack: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('plateGallery', 'getPlateByTrack', 'query', input, undefined, options),
  }

  const recordingArchiveInterface = {
    getDeviceConfig: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'getDeviceConfig', 'query', input, undefined, options),
    locateSegment: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'locateSegment', 'query', input, undefined, options),
    readSegmentBytes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'readSegmentBytes', 'query', input, undefined, options),
    readGopBytes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'readGopBytes', 'query', input, undefined, options),
    readWindowBytes: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'readWindowBytes', 'query', input, undefined, options),
    setDeviceConfig: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'setDeviceConfig', 'mutation', input, undefined, options),
    rescanStorage: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'rescanStorage', 'mutation', input, undefined, options),
    pruneFootage: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'pruneFootage', 'mutation', input, undefined, options),
    deleteFootprint: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'deleteFootprint', 'mutation', input, undefined, options),
    renderGif: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'renderGif', 'mutation', input, undefined, options),
    renderClip: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'renderClip', 'mutation', input, undefined, options),
    getStatus: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'getStatus', 'query', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingArchive', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
  }

  const recordingExportInterface = {
    listExports: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('recordingExport', 'listExports', 'query', input, undefined, options),
  }

  const streamBrokerInterface = {
    reportStreamSignal: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'reportStreamSignal', 'mutation', input, undefined, options),
    publishCameraStream: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'publishCameraStream', 'mutation', input, undefined, options),
    retractCameraStream: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'retractCameraStream', 'mutation', input, undefined, options),
    assignProfile: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'assignProfile', 'mutation', input, undefined, options),
    unassignProfile: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'unassignProfile', 'mutation', input, undefined, options),
    forgetDeviceHardware: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'forgetDeviceHardware', 'mutation', input, undefined, options),
    renderPreBufferClip: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'renderPreBufferClip', 'mutation', input, undefined, options),
    produceEventMedia: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'produceEventMedia', 'mutation', input, undefined, options),
    restartProfile: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'restartProfile', 'mutation', input, undefined, options),
    getDeviceAudioMute: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'getDeviceAudioMute', 'query', input, undefined, options),
    setDeviceAudioMute: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'setDeviceAudioMute', 'mutation', input, undefined, options),
    getDeviceSettingsContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'getDeviceSettingsContribution', 'query', input, undefined, options),
    getDeviceLiveContribution: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'getDeviceLiveContribution', 'query', input, undefined, options),
    applyDeviceSettingsPatch: (input?: unknown, options?: CommandOriginRequestOptions) => dispatchSystem('streamBroker', 'applyDeviceSettingsPatch', 'mutation', input, undefined, options),
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
      deviceStatus: createSliceHandle<InferRuntimeState<typeof deviceStatusCapability>>(stateSource, binding.deviceId, 'device-status'),
      dishwasher: createSliceHandle<InferRuntimeState<typeof dishwasherCapability>>(stateSource, binding.deviceId, 'dishwasher'),
      doNotDisturb: createSliceHandle<InferRuntimeState<typeof doNotDisturbCapability>>(stateSource, binding.deviceId, 'do-not-disturb'),
      doorbell: createSliceHandle<InferRuntimeState<typeof doorbellCapability>>(stateSource, binding.deviceId, 'doorbell'),
      energySystem: createSliceHandle<InferRuntimeState<typeof energySystemCapability>>(stateSource, binding.deviceId, 'energy-system'),
      enumSensor: createSliceHandle<InferRuntimeState<typeof enumSensorCapability>>(stateSource, binding.deviceId, 'enum-sensor'),
      error: createSliceHandle<InferRuntimeState<typeof errorCapability>>(stateSource, binding.deviceId, 'error'),
      eventEmitter: createSliceHandle<InferRuntimeState<typeof eventEmitterCapability>>(stateSource, binding.deviceId, 'event-emitter'),
      fanControl: createSliceHandle<InferRuntimeState<typeof fanControlCapability>>(stateSource, binding.deviceId, 'fan-control'),
      featureProbe: createSliceHandle<InferRuntimeState<typeof featureProbeCapability>>(stateSource, binding.deviceId, 'feature-probe'),
      flood: createSliceHandle<InferRuntimeState<typeof floodCapability>>(stateSource, binding.deviceId, 'flood'),
      gas: createSliceHandle<InferRuntimeState<typeof gasCapability>>(stateSource, binding.deviceId, 'gas'),
      groupActive: createSliceHandle<InferRuntimeState<typeof groupActiveCapability>>(stateSource, binding.deviceId, 'group-active'),
      groupCommands: createSliceHandle<InferRuntimeState<typeof groupCommandsCapability>>(stateSource, binding.deviceId, 'group-commands'),
      groupStatus: createSliceHandle<InferRuntimeState<typeof groupStatusCapability>>(stateSource, binding.deviceId, 'group-status'),
      heatingValve: createSliceHandle<InferRuntimeState<typeof heatingValveCapability>>(stateSource, binding.deviceId, 'heating-valve'),
      heatPumpStatus: createSliceHandle<InferRuntimeState<typeof heatPumpStatusCapability>>(stateSource, binding.deviceId, 'heat-pump-status'),
      humidifier: createSliceHandle<InferRuntimeState<typeof humidifierCapability>>(stateSource, binding.deviceId, 'humidifier'),
      humiditySensor: createSliceHandle<InferRuntimeState<typeof humiditySensorCapability>>(stateSource, binding.deviceId, 'humidity-sensor'),
      image: createSliceHandle<InferRuntimeState<typeof imageCapability>>(stateSource, binding.deviceId, 'image'),
      imageSettings: createSliceHandle<InferRuntimeState<typeof imageSettingsCapability>>(stateSource, binding.deviceId, 'image-settings'),
      intercom: createSliceHandle<InferRuntimeState<typeof intercomCapability>>(stateSource, binding.deviceId, 'intercom'),
      irTransmitter: createSliceHandle<InferRuntimeState<typeof irTransmitterCapability>>(stateSource, binding.deviceId, 'ir-transmitter'),
      lawnMowerControl: createSliceHandle<InferRuntimeState<typeof lawnMowerControlCapability>>(stateSource, binding.deviceId, 'lawn-mower-control'),
      lockControl: createSliceHandle<InferRuntimeState<typeof lockControlCapability>>(stateSource, binding.deviceId, 'lock-control'),
      lowPowerSleep: createSliceHandle<InferRuntimeState<typeof lowPowerSleepCapability>>(stateSource, binding.deviceId, 'low-power-sleep'),
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
      petFountain: createSliceHandle<InferRuntimeState<typeof petFountainCapability>>(stateSource, binding.deviceId, 'pet-fountain'),
      powerMeter: createSliceHandle<InferRuntimeState<typeof powerMeterCapability>>(stateSource, binding.deviceId, 'power-meter'),
      powerSource: createSliceHandle<InferRuntimeState<typeof powerSourceCapability>>(stateSource, binding.deviceId, 'power-source'),
      presence: createSliceHandle<InferRuntimeState<typeof presenceCapability>>(stateSource, binding.deviceId, 'presence'),
      pressureSensor: createSliceHandle<InferRuntimeState<typeof pressureSensorCapability>>(stateSource, binding.deviceId, 'pressure-sensor'),
      privacyMask: createSliceHandle<InferRuntimeState<typeof privacyMaskCapability>>(stateSource, binding.deviceId, 'privacy-mask'),
      ptzAutotrack: createSliceHandle<InferRuntimeState<typeof ptzAutotrackCapability>>(stateSource, binding.deviceId, 'ptz-autotrack'),
      pumpCycle: createSliceHandle<InferRuntimeState<typeof pumpCycleCapability>>(stateSource, binding.deviceId, 'pump-cycle'),
      recordingOnboard: createSliceHandle<InferRuntimeState<typeof recordingOnboardCapability>>(stateSource, binding.deviceId, 'recording-onboard'),
      recordingSignal: createSliceHandle<InferRuntimeState<typeof recordingSignalCapability>>(stateSource, binding.deviceId, 'recording-signal'),
      runningState: createSliceHandle<InferRuntimeState<typeof runningStateCapability>>(stateSource, binding.deviceId, 'running-state'),
      sceneMonitor: createSliceHandle<InferRuntimeState<typeof sceneMonitorCapability>>(stateSource, binding.deviceId, 'scene-monitor'),
      scriptRunner: createSliceHandle<InferRuntimeState<typeof scriptRunnerCapability>>(stateSource, binding.deviceId, 'script-runner'),
      siren: createSliceHandle<InferRuntimeState<typeof sirenCapability>>(stateSource, binding.deviceId, 'siren'),
      smoke: createSliceHandle<InferRuntimeState<typeof smokeCapability>>(stateSource, binding.deviceId, 'smoke'),
      streamCatalog: createSliceHandle<InferRuntimeState<typeof streamCatalogCapability>>(stateSource, binding.deviceId, 'stream-catalog'),
      streamParams: createSliceHandle<InferRuntimeState<typeof streamParamsCapability>>(stateSource, binding.deviceId, 'stream-params'),
      streamSignals: createSliceHandle<InferRuntimeState<typeof streamSignalsCapability>>(stateSource, binding.deviceId, 'stream-signals'),
      switch: createSliceHandle<InferRuntimeState<typeof switchCapability>>(stateSource, binding.deviceId, 'switch'),
      tamper: createSliceHandle<InferRuntimeState<typeof tamperCapability>>(stateSource, binding.deviceId, 'tamper'),
      temperatureSensor: createSliceHandle<InferRuntimeState<typeof temperatureSensorCapability>>(stateSource, binding.deviceId, 'temperature-sensor'),
      timedRun: createSliceHandle<InferRuntimeState<typeof timedRunCapability>>(stateSource, binding.deviceId, 'timed-run'),
      update: createSliceHandle<InferRuntimeState<typeof updateCapability>>(stateSource, binding.deviceId, 'update'),
      vacuumControl: createSliceHandle<InferRuntimeState<typeof vacuumControlCapability>>(stateSource, binding.deviceId, 'vacuum-control'),
      valve: createSliceHandle<InferRuntimeState<typeof valveCapability>>(stateSource, binding.deviceId, 'valve'),
      vibration: createSliceHandle<InferRuntimeState<typeof vibrationCapability>>(stateSource, binding.deviceId, 'vibration'),
      waterHeater: createSliceHandle<InferRuntimeState<typeof waterHeaterCapability>>(stateSource, binding.deviceId, 'water-heater'),
      weather: createSliceHandle<InferRuntimeState<typeof weatherCapability>>(stateSource, binding.deviceId, 'weather'),
      weatherStation: createSliceHandle<InferRuntimeState<typeof weatherStationCapability>>(stateSource, binding.deviceId, 'weather-station'),
      workload: createSliceHandle<InferRuntimeState<typeof workloadCapability>>(stateSource, binding.deviceId, 'workload'),
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
    ...(bound('device-extension') ? { deviceExtension: deviceExtensionInterface } : {}),
    ...(bound('device-ops') ? { deviceOps: deviceOpsInterface } : {}),
    ...(bound('device-runs') ? { deviceRuns: deviceRunsInterface } : {}),
    ...(bound('device-status') ? { deviceStatus: deviceStatusInterface } : {}),
    ...(bound('device-transitions') ? { deviceTransitions: deviceTransitionsInterface } : {}),
    ...(bound('dishwasher') ? { dishwasher: dishwasherInterface } : {}),
    ...(bound('do-not-disturb') ? { doNotDisturb: doNotDisturbInterface } : {}),
    ...(bound('doorbell') ? { doorbell: doorbellInterface } : {}),
    ...(bound('energy-system') ? { energySystem: energySystemInterface } : {}),
    ...(bound('enum-sensor') ? { enumSensor: enumSensorInterface } : {}),
    ...(bound('error') ? { error: errorInterface } : {}),
    ...(bound('event-emitter') ? { eventEmitter: eventEmitterInterface } : {}),
    ...(bound('fan-control') ? { fanControl: fanControlInterface } : {}),
    ...(bound('feature-probe') ? { featureProbe: featureProbeInterface } : {}),
    ...(bound('flood') ? { flood: floodInterface } : {}),
    ...(bound('gas') ? { gas: gasInterface } : {}),
    ...(bound('group-active') ? { groupActive: groupActiveInterface } : {}),
    ...(bound('group-commands') ? { groupCommands: groupCommandsInterface } : {}),
    ...(bound('group-status') ? { groupStatus: groupStatusInterface } : {}),
    ...(bound('heating-valve') ? { heatingValve: heatingValveInterface } : {}),
    ...(bound('heat-pump-control') ? { heatPumpControl: heatPumpControlInterface } : {}),
    ...(bound('heat-pump-status') ? { heatPumpStatus: heatPumpStatusInterface } : {}),
    ...(bound('humidifier') ? { humidifier: humidifierInterface } : {}),
    ...(bound('humidity-sensor') ? { humiditySensor: humiditySensorInterface } : {}),
    ...(bound('image') ? { image: imageInterface } : {}),
    ...(bound('image-settings') ? { imageSettings: imageSettingsInterface } : {}),
    ...(bound('intercom') ? { intercom: intercomInterface } : {}),
    ...(bound('ir-transmitter') ? { irTransmitter: irTransmitterInterface } : {}),
    ...(bound('lawn-mower-control') ? { lawnMowerControl: lawnMowerControlInterface } : {}),
    ...(bound('lock-control') ? { lockControl: lockControlInterface } : {}),
    ...(bound('low-power-sleep') ? { lowPowerSleep: lowPowerSleepInterface } : {}),
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
    ...(bound('pet-fountain') ? { petFountain: petFountainInterface } : {}),
    ...(bound('pipeline-analytics') ? { pipelineAnalytics: pipelineAnalyticsInterface } : {}),
    ...(bound('power-meter') ? { powerMeter: powerMeterInterface } : {}),
    ...(bound('power-source') ? { powerSource: powerSourceInterface } : {}),
    ...(bound('presence') ? { presence: presenceInterface } : {}),
    ...(bound('pressure-sensor') ? { pressureSensor: pressureSensorInterface } : {}),
    ...(bound('privacy-mask') ? { privacyMask: privacyMaskInterface } : {}),
    ...(bound('ptz') ? { ptz: ptzInterface } : {}),
    ...(bound('ptz-autotrack') ? { ptzAutotrack: ptzAutotrackInterface } : {}),
    ...(bound('pump-cycle') ? { pumpCycle: pumpCycleInterface } : {}),
    ...(bound('reboot') ? { reboot: rebootInterface } : {}),
    ...(bound('recording') ? { recording: recordingInterface } : {}),
    ...(bound('recording-onboard') ? { recordingOnboard: recordingOnboardInterface } : {}),
    ...(bound('recording-signal') ? { recordingSignal: recordingSignalInterface } : {}),
    ...(bound('resync') ? { resync: resyncInterface } : {}),
    ...(bound('running-state') ? { runningState: runningStateInterface } : {}),
    ...(bound('scene-monitor') ? { sceneMonitor: sceneMonitorInterface } : {}),
    ...(bound('script-runner') ? { scriptRunner: scriptRunnerInterface } : {}),
    ...(bound('siren') ? { siren: sirenInterface } : {}),
    ...(bound('smoke') ? { smoke: smokeInterface } : {}),
    ...(bound('snapshot') ? { snapshot: snapshotInterface } : {}),
    ...(bound('stream-catalog') ? { streamCatalog: streamCatalogInterface } : {}),
    ...(bound('stream-params') ? { streamParams: streamParamsInterface } : {}),
    ...(bound('stream-signals') ? { streamSignals: streamSignalsInterface } : {}),
    ...(bound('switch') ? { switch: switchInterface } : {}),
    ...(bound('tamper') ? { tamper: tamperInterface } : {}),
    ...(bound('temperature-sensor') ? { temperatureSensor: temperatureSensorInterface } : {}),
    ...(bound('timed-run') ? { timedRun: timedRunInterface } : {}),
    ...(bound('update') ? { update: updateInterface } : {}),
    ...(bound('vacuum-control') ? { vacuumControl: vacuumControlInterface } : {}),
    ...(bound('valve') ? { valve: valveInterface } : {}),
    ...(bound('vibration') ? { vibration: vibrationInterface } : {}),
    ...(bound('videoclips') ? { videoclips: videoclipsInterface } : {}),
    ...(bound('water-heater') ? { waterHeater: waterHeaterInterface } : {}),
    ...(bound('weather') ? { weather: weatherInterface } : {}),
    ...(bound('weather-station') ? { weatherStation: weatherStationInterface } : {}),
    ...(bound('webrtc-session') ? { webrtcSession: webrtcSessionInterface } : {}),
    ...(bound('workload') ? { workload: workloadInterface } : {}),
    ...(bound('zone-analytics') ? { zoneAnalytics: zoneAnalyticsInterface } : {}),
    ...(bound('zone-rules') ? { zoneRules: zoneRulesInterface } : {}),
    ...(bound('zones') ? { zones: zonesInterface } : {}),
    actions: actionsInterface,
    addonSettings: addonSettingsInterface,
    audioAnalyzer: audioAnalyzerInterface,
    coreBlocks: coreBlocksInterface,
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
