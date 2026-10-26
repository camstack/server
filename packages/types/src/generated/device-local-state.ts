// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { CapabilityDefinition, InferRuntimeState } from '../capabilities/capability-definition.js'
import { airQualitySensorCapability } from '../capabilities/air-quality-sensor.cap.js'
import { alarmPanelCapability } from '../capabilities/alarm-panel.cap.js'
import { ambientLightSensorCapability } from '../capabilities/ambient-light-sensor.cap.js'
import { audioMetricsCapability } from '../capabilities/audio-metrics.cap.js'
import { automationControlCapability } from '../capabilities/automation-control.cap.js'
import { batteryCapability } from '../capabilities/battery.cap.js'
import { binaryCapability } from '../capabilities/binary.cap.js'
import { brightnessCapability } from '../capabilities/brightness.cap.js'
import { cameraStreamsCapability } from '../capabilities/camera-streams.cap.js'
import { carbonMonoxideCapability } from '../capabilities/carbon-monoxide.cap.js'
import { climateControlCapability } from '../capabilities/climate-control.cap.js'
import { colorCapability } from '../capabilities/color.cap.js'
import { connectivityCapability } from '../capabilities/connectivity.cap.js'
import { consumablesCapability } from '../capabilities/consumables.cap.js'
import { contactCapability } from '../capabilities/contact.cap.js'
import { controlCapability } from '../capabilities/control.cap.js'
import { coverCapability } from '../capabilities/cover.cap.js'
import { dayNightCapability } from '../capabilities/day-night.cap.js'
import { deviceDiscoveryCapability } from '../capabilities/device-discovery.cap.js'
import { deviceStatusCapability } from '../capabilities/device-status.cap.js'
import { dishwasherCapability } from '../capabilities/dishwasher.cap.js'
import { doorbellCapability } from '../capabilities/doorbell.cap.js'
import { enumSensorCapability } from '../capabilities/enum-sensor.cap.js'
import { eventEmitterCapability } from '../capabilities/event-emitter.cap.js'
import { fanControlCapability } from '../capabilities/fan-control.cap.js'
import { featureProbeCapability } from '../capabilities/feature-probe.cap.js'
import { floodCapability } from '../capabilities/flood.cap.js'
import { gasCapability } from '../capabilities/gas.cap.js'
import { groupStatusCapability } from '../capabilities/group-status.cap.js'
import { heatingValveCapability } from '../capabilities/heating-valve.cap.js'
import { humidifierCapability } from '../capabilities/humidifier.cap.js'
import { humiditySensorCapability } from '../capabilities/humidity-sensor.cap.js'
import { imageCapability } from '../capabilities/image.cap.js'
import { imageSettingsCapability } from '../capabilities/image-settings.cap.js'
import { intercomCapability } from '../capabilities/intercom.cap.js'
import { lawnMowerControlCapability } from '../capabilities/lawn-mower-control.cap.js'
import { lockControlCapability } from '../capabilities/lock-control.cap.js'
import { mediaPlayerCapability } from '../capabilities/media-player.cap.js'
import { motionCapability } from '../capabilities/motion.cap.js'
import { motionTriggerCapability } from '../capabilities/motion-trigger.cap.js'
import { motionZonesCapability } from '../capabilities/motion-zones.cap.js'
import { nativeObjectDetectionCapability } from '../capabilities/native-object-detection.cap.js'
import { navigationCapability } from '../capabilities/navigation.cap.js'
import { networkLinkCapability } from '../capabilities/network-link.cap.js'
import { notifierCapability } from '../capabilities/notifier.cap.js'
import { numericSensorCapability } from '../capabilities/numeric-sensor.cap.js'
import { petFeederCapability } from '../capabilities/pet-feeder.cap.js'
import { powerMeterCapability } from '../capabilities/power-meter.cap.js'
import { presenceCapability } from '../capabilities/presence.cap.js'
import { pressureSensorCapability } from '../capabilities/pressure-sensor.cap.js'
import { privacyMaskCapability } from '../capabilities/privacy-mask.cap.js'
import { ptzAutotrackCapability } from '../capabilities/ptz-autotrack.cap.js'
import { recordingOnboardCapability } from '../capabilities/recording-onboard.cap.js'
import { recordingSignalCapability } from '../capabilities/recording-signal.cap.js'
import { runningStateCapability } from '../capabilities/running-state.cap.js'
import { sceneMonitorCapability } from '../capabilities/scene-monitor.cap.js'
import { scriptRunnerCapability } from '../capabilities/script-runner.cap.js'
import { smokeCapability } from '../capabilities/smoke.cap.js'
import { streamCatalogCapability } from '../capabilities/stream-catalog.cap.js'
import { streamParamsCapability } from '../capabilities/stream-params.cap.js'
import { streamSignalsCapability } from '../capabilities/stream-signals.cap.js'
import { switchCapability } from '../capabilities/switch.cap.js'
import { tamperCapability } from '../capabilities/tamper.cap.js'
import { temperatureSensorCapability } from '../capabilities/temperature-sensor.cap.js'
import { updateCapability } from '../capabilities/update.cap.js'
import { vacuumControlCapability } from '../capabilities/vacuum-control.cap.js'
import { valveCapability } from '../capabilities/valve.cap.js'
import { vibrationCapability } from '../capabilities/vibration.cap.js'
import { waterHeaterCapability } from '../capabilities/water-heater.cap.js'
import { weatherCapability } from '../capabilities/weather.cap.js'
import { zoneAnalyticsCapability } from '../capabilities/zone-analytics.cap.js'
import { zoneRulesCapability } from '../capabilities/zone-rules.cap.js'
import { zonesCapability } from '../capabilities/zones.cap.js'

/**
 * Server-side, write-capable per-cap state shape for any device that
 * extends `BaseDevice`. One entry per cap with `runtimeState:` declared.
 *
 * Drivers access via `this.state.<capName>.<field>` — both reads and
 * writes route through the device's runtime-state slice (validate,
 * persist, fire `<cap>.onChanged`). No string keys, no manual generic.
 *
 * Adding a new cap with `runtimeState:` auto-extends this interface —
 * regenerate with `npm run codegen`.
 */
export interface DeviceLocalState {
  airQualitySensor: InferRuntimeState<typeof airQualitySensorCapability>
  alarmPanel: InferRuntimeState<typeof alarmPanelCapability>
  ambientLightSensor: InferRuntimeState<typeof ambientLightSensorCapability>
  audioMetrics: InferRuntimeState<typeof audioMetricsCapability>
  automationControl: InferRuntimeState<typeof automationControlCapability>
  battery: InferRuntimeState<typeof batteryCapability>
  binary: InferRuntimeState<typeof binaryCapability>
  brightness: InferRuntimeState<typeof brightnessCapability>
  cameraStreams: InferRuntimeState<typeof cameraStreamsCapability>
  carbonMonoxide: InferRuntimeState<typeof carbonMonoxideCapability>
  climateControl: InferRuntimeState<typeof climateControlCapability>
  color: InferRuntimeState<typeof colorCapability>
  connectivity: InferRuntimeState<typeof connectivityCapability>
  consumables: InferRuntimeState<typeof consumablesCapability>
  contact: InferRuntimeState<typeof contactCapability>
  control: InferRuntimeState<typeof controlCapability>
  cover: InferRuntimeState<typeof coverCapability>
  dayNight: InferRuntimeState<typeof dayNightCapability>
  deviceDiscovery: InferRuntimeState<typeof deviceDiscoveryCapability>
  deviceStatus: InferRuntimeState<typeof deviceStatusCapability>
  dishwasher: InferRuntimeState<typeof dishwasherCapability>
  doorbell: InferRuntimeState<typeof doorbellCapability>
  enumSensor: InferRuntimeState<typeof enumSensorCapability>
  eventEmitter: InferRuntimeState<typeof eventEmitterCapability>
  fanControl: InferRuntimeState<typeof fanControlCapability>
  featureProbe: InferRuntimeState<typeof featureProbeCapability>
  flood: InferRuntimeState<typeof floodCapability>
  gas: InferRuntimeState<typeof gasCapability>
  groupStatus: InferRuntimeState<typeof groupStatusCapability>
  heatingValve: InferRuntimeState<typeof heatingValveCapability>
  humidifier: InferRuntimeState<typeof humidifierCapability>
  humiditySensor: InferRuntimeState<typeof humiditySensorCapability>
  image: InferRuntimeState<typeof imageCapability>
  imageSettings: InferRuntimeState<typeof imageSettingsCapability>
  intercom: InferRuntimeState<typeof intercomCapability>
  lawnMowerControl: InferRuntimeState<typeof lawnMowerControlCapability>
  lockControl: InferRuntimeState<typeof lockControlCapability>
  mediaPlayer: InferRuntimeState<typeof mediaPlayerCapability>
  motion: InferRuntimeState<typeof motionCapability>
  motionTrigger: InferRuntimeState<typeof motionTriggerCapability>
  motionZones: InferRuntimeState<typeof motionZonesCapability>
  nativeObjectDetection: InferRuntimeState<typeof nativeObjectDetectionCapability>
  navigation: InferRuntimeState<typeof navigationCapability>
  networkLink: InferRuntimeState<typeof networkLinkCapability>
  notifier: InferRuntimeState<typeof notifierCapability>
  numericSensor: InferRuntimeState<typeof numericSensorCapability>
  petFeeder: InferRuntimeState<typeof petFeederCapability>
  powerMeter: InferRuntimeState<typeof powerMeterCapability>
  presence: InferRuntimeState<typeof presenceCapability>
  pressureSensor: InferRuntimeState<typeof pressureSensorCapability>
  privacyMask: InferRuntimeState<typeof privacyMaskCapability>
  ptzAutotrack: InferRuntimeState<typeof ptzAutotrackCapability>
  recordingOnboard: InferRuntimeState<typeof recordingOnboardCapability>
  recordingSignal: InferRuntimeState<typeof recordingSignalCapability>
  runningState: InferRuntimeState<typeof runningStateCapability>
  sceneMonitor: InferRuntimeState<typeof sceneMonitorCapability>
  scriptRunner: InferRuntimeState<typeof scriptRunnerCapability>
  smoke: InferRuntimeState<typeof smokeCapability>
  streamCatalog: InferRuntimeState<typeof streamCatalogCapability>
  streamParams: InferRuntimeState<typeof streamParamsCapability>
  streamSignals: InferRuntimeState<typeof streamSignalsCapability>
  switch: InferRuntimeState<typeof switchCapability>
  tamper: InferRuntimeState<typeof tamperCapability>
  temperatureSensor: InferRuntimeState<typeof temperatureSensorCapability>
  update: InferRuntimeState<typeof updateCapability>
  vacuumControl: InferRuntimeState<typeof vacuumControlCapability>
  valve: InferRuntimeState<typeof valveCapability>
  vibration: InferRuntimeState<typeof vibrationCapability>
  waterHeater: InferRuntimeState<typeof waterHeaterCapability>
  weather: InferRuntimeState<typeof weatherCapability>
  zoneAnalytics: InferRuntimeState<typeof zoneAnalyticsCapability>
  zoneRules: InferRuntimeState<typeof zoneRulesCapability>
  zones: InferRuntimeState<typeof zonesCapability>
}

/**
 * Runtime registry: cap-property-name → cap definition. `BaseDevice`'s
 * `state` getter looks up the cap definition here to construct a
 * `sliceProxy()` lazily on first access. Generated alongside the type
 * so type and runtime registry can never drift apart.
 */
export const DEVICE_LOCAL_STATE_CAPS: Record<keyof DeviceLocalState, CapabilityDefinition> = {
  airQualitySensor: airQualitySensorCapability,
  alarmPanel: alarmPanelCapability,
  ambientLightSensor: ambientLightSensorCapability,
  audioMetrics: audioMetricsCapability,
  automationControl: automationControlCapability,
  battery: batteryCapability,
  binary: binaryCapability,
  brightness: brightnessCapability,
  cameraStreams: cameraStreamsCapability,
  carbonMonoxide: carbonMonoxideCapability,
  climateControl: climateControlCapability,
  color: colorCapability,
  connectivity: connectivityCapability,
  consumables: consumablesCapability,
  contact: contactCapability,
  control: controlCapability,
  cover: coverCapability,
  dayNight: dayNightCapability,
  deviceDiscovery: deviceDiscoveryCapability,
  deviceStatus: deviceStatusCapability,
  dishwasher: dishwasherCapability,
  doorbell: doorbellCapability,
  enumSensor: enumSensorCapability,
  eventEmitter: eventEmitterCapability,
  fanControl: fanControlCapability,
  featureProbe: featureProbeCapability,
  flood: floodCapability,
  gas: gasCapability,
  groupStatus: groupStatusCapability,
  heatingValve: heatingValveCapability,
  humidifier: humidifierCapability,
  humiditySensor: humiditySensorCapability,
  image: imageCapability,
  imageSettings: imageSettingsCapability,
  intercom: intercomCapability,
  lawnMowerControl: lawnMowerControlCapability,
  lockControl: lockControlCapability,
  mediaPlayer: mediaPlayerCapability,
  motion: motionCapability,
  motionTrigger: motionTriggerCapability,
  motionZones: motionZonesCapability,
  nativeObjectDetection: nativeObjectDetectionCapability,
  navigation: navigationCapability,
  networkLink: networkLinkCapability,
  notifier: notifierCapability,
  numericSensor: numericSensorCapability,
  petFeeder: petFeederCapability,
  powerMeter: powerMeterCapability,
  presence: presenceCapability,
  pressureSensor: pressureSensorCapability,
  privacyMask: privacyMaskCapability,
  ptzAutotrack: ptzAutotrackCapability,
  recordingOnboard: recordingOnboardCapability,
  recordingSignal: recordingSignalCapability,
  runningState: runningStateCapability,
  sceneMonitor: sceneMonitorCapability,
  scriptRunner: scriptRunnerCapability,
  smoke: smokeCapability,
  streamCatalog: streamCatalogCapability,
  streamParams: streamParamsCapability,
  streamSignals: streamSignalsCapability,
  switch: switchCapability,
  tamper: tamperCapability,
  temperatureSensor: temperatureSensorCapability,
  update: updateCapability,
  vacuumControl: vacuumControlCapability,
  valve: valveCapability,
  vibration: vibrationCapability,
  waterHeater: waterHeaterCapability,
  weather: weatherCapability,
  zoneAnalytics: zoneAnalyticsCapability,
  zoneRules: zoneRulesCapability,
  zones: zonesCapability,
}

/**
 * Cap-name keyed runtime-state map (kebab-case keys, e.g. `'battery'`,
 * `'device-discovery'`). Companion to `DeviceLocalState` (which uses
 * camelCase property keys). Consumed by the
 * `IDeviceRuntimeState.getCapState` overload so callers passing a
 * cap-name literal get the typed slice back without an explicit
 * generic argument:
 *
 *   const slice = this.runtimeState.getCapState('battery')
 *   //    ^^^^^ inferred as InferRuntimeState<typeof batteryCapability>
 *
 * Eliminates the `as`-cast at every `getCapState<X>('cap-name')` site.
 */
export interface CapNameToRuntimeStateMap {
  'air-quality-sensor': InferRuntimeState<typeof airQualitySensorCapability>
  'alarm-panel': InferRuntimeState<typeof alarmPanelCapability>
  'ambient-light-sensor': InferRuntimeState<typeof ambientLightSensorCapability>
  'audio-metrics': InferRuntimeState<typeof audioMetricsCapability>
  'automation-control': InferRuntimeState<typeof automationControlCapability>
  'battery': InferRuntimeState<typeof batteryCapability>
  'binary': InferRuntimeState<typeof binaryCapability>
  'brightness': InferRuntimeState<typeof brightnessCapability>
  'camera-streams': InferRuntimeState<typeof cameraStreamsCapability>
  'carbon-monoxide': InferRuntimeState<typeof carbonMonoxideCapability>
  'climate-control': InferRuntimeState<typeof climateControlCapability>
  'color': InferRuntimeState<typeof colorCapability>
  'connectivity': InferRuntimeState<typeof connectivityCapability>
  'consumables': InferRuntimeState<typeof consumablesCapability>
  'contact': InferRuntimeState<typeof contactCapability>
  'control': InferRuntimeState<typeof controlCapability>
  'cover': InferRuntimeState<typeof coverCapability>
  'day-night': InferRuntimeState<typeof dayNightCapability>
  'device-discovery': InferRuntimeState<typeof deviceDiscoveryCapability>
  'device-status': InferRuntimeState<typeof deviceStatusCapability>
  'dishwasher': InferRuntimeState<typeof dishwasherCapability>
  'doorbell': InferRuntimeState<typeof doorbellCapability>
  'enum-sensor': InferRuntimeState<typeof enumSensorCapability>
  'event-emitter': InferRuntimeState<typeof eventEmitterCapability>
  'fan-control': InferRuntimeState<typeof fanControlCapability>
  'feature-probe': InferRuntimeState<typeof featureProbeCapability>
  'flood': InferRuntimeState<typeof floodCapability>
  'gas': InferRuntimeState<typeof gasCapability>
  'group-status': InferRuntimeState<typeof groupStatusCapability>
  'heating-valve': InferRuntimeState<typeof heatingValveCapability>
  'humidifier': InferRuntimeState<typeof humidifierCapability>
  'humidity-sensor': InferRuntimeState<typeof humiditySensorCapability>
  'image': InferRuntimeState<typeof imageCapability>
  'image-settings': InferRuntimeState<typeof imageSettingsCapability>
  'intercom': InferRuntimeState<typeof intercomCapability>
  'lawn-mower-control': InferRuntimeState<typeof lawnMowerControlCapability>
  'lock-control': InferRuntimeState<typeof lockControlCapability>
  'media-player': InferRuntimeState<typeof mediaPlayerCapability>
  'motion': InferRuntimeState<typeof motionCapability>
  'motion-trigger': InferRuntimeState<typeof motionTriggerCapability>
  'motion-zones': InferRuntimeState<typeof motionZonesCapability>
  'native-object-detection': InferRuntimeState<typeof nativeObjectDetectionCapability>
  'navigation': InferRuntimeState<typeof navigationCapability>
  'network-link': InferRuntimeState<typeof networkLinkCapability>
  'notifier': InferRuntimeState<typeof notifierCapability>
  'numeric-sensor': InferRuntimeState<typeof numericSensorCapability>
  'pet-feeder': InferRuntimeState<typeof petFeederCapability>
  'power-meter': InferRuntimeState<typeof powerMeterCapability>
  'presence': InferRuntimeState<typeof presenceCapability>
  'pressure-sensor': InferRuntimeState<typeof pressureSensorCapability>
  'privacy-mask': InferRuntimeState<typeof privacyMaskCapability>
  'ptz-autotrack': InferRuntimeState<typeof ptzAutotrackCapability>
  'recording-onboard': InferRuntimeState<typeof recordingOnboardCapability>
  'recording-signal': InferRuntimeState<typeof recordingSignalCapability>
  'running-state': InferRuntimeState<typeof runningStateCapability>
  'scene-monitor': InferRuntimeState<typeof sceneMonitorCapability>
  'script-runner': InferRuntimeState<typeof scriptRunnerCapability>
  'smoke': InferRuntimeState<typeof smokeCapability>
  'stream-catalog': InferRuntimeState<typeof streamCatalogCapability>
  'stream-params': InferRuntimeState<typeof streamParamsCapability>
  'stream-signals': InferRuntimeState<typeof streamSignalsCapability>
  'switch': InferRuntimeState<typeof switchCapability>
  'tamper': InferRuntimeState<typeof tamperCapability>
  'temperature-sensor': InferRuntimeState<typeof temperatureSensorCapability>
  'update': InferRuntimeState<typeof updateCapability>
  'vacuum-control': InferRuntimeState<typeof vacuumControlCapability>
  'valve': InferRuntimeState<typeof valveCapability>
  'vibration': InferRuntimeState<typeof vibrationCapability>
  'water-heater': InferRuntimeState<typeof waterHeaterCapability>
  'weather': InferRuntimeState<typeof weatherCapability>
  'zone-analytics': InferRuntimeState<typeof zoneAnalyticsCapability>
  'zone-rules': InferRuntimeState<typeof zoneRulesCapability>
  'zones': InferRuntimeState<typeof zonesCapability>
}
