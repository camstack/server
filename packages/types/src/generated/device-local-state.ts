// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { InferRuntimeState } from '../capabilities/capability-definition.js'
import type { airQualitySensorCapability } from '../capabilities/air-quality-sensor.cap.js'
import type { alarmPanelCapability } from '../capabilities/alarm-panel.cap.js'
import type { ambientLightSensorCapability } from '../capabilities/ambient-light-sensor.cap.js'
import type { audioMetricsCapability } from '../capabilities/audio-metrics.cap.js'
import type { automationControlCapability } from '../capabilities/automation-control.cap.js'
import type { batteryCapability } from '../capabilities/battery.cap.js'
import type { binaryCapability } from '../capabilities/binary.cap.js'
import type { brightnessCapability } from '../capabilities/brightness.cap.js'
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
import type { deviceStatusCapability } from '../capabilities/device-status.cap.js'
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
import type { motionTriggerCapability } from '../capabilities/motion-trigger.cap.js'
import type { motionZonesCapability } from '../capabilities/motion-zones.cap.js'
import type { nativeObjectDetectionCapability } from '../capabilities/native-object-detection.cap.js'
import type { navigationCapability } from '../capabilities/navigation.cap.js'
import type { networkLinkCapability } from '../capabilities/network-link.cap.js'
import type { notifierCapability } from '../capabilities/notifier.cap.js'
import type { numericSensorCapability } from '../capabilities/numeric-sensor.cap.js'
import type { petFeederCapability } from '../capabilities/pet-feeder.cap.js'
import type { petFountainCapability } from '../capabilities/pet-fountain.cap.js'
import type { powerMeterCapability } from '../capabilities/power-meter.cap.js'
import type { powerSourceCapability } from '../capabilities/power-source.cap.js'
import type { presenceCapability } from '../capabilities/presence.cap.js'
import type { pressureSensorCapability } from '../capabilities/pressure-sensor.cap.js'
import type { privacyMaskCapability } from '../capabilities/privacy-mask.cap.js'
import type { ptzAutotrackCapability } from '../capabilities/ptz-autotrack.cap.js'
import type { pumpCycleCapability } from '../capabilities/pump-cycle.cap.js'
import type { recordingOnboardCapability } from '../capabilities/recording-onboard.cap.js'
import type { recordingSignalCapability } from '../capabilities/recording-signal.cap.js'
import type { runningStateCapability } from '../capabilities/running-state.cap.js'
import type { sceneMonitorCapability } from '../capabilities/scene-monitor.cap.js'
import type { scriptRunnerCapability } from '../capabilities/script-runner.cap.js'
import type { sirenCapability } from '../capabilities/siren.cap.js'
import type { smokeCapability } from '../capabilities/smoke.cap.js'
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
import type { waterHeaterCapability } from '../capabilities/water-heater.cap.js'
import type { weatherCapability } from '../capabilities/weather.cap.js'
import type { weatherStationCapability } from '../capabilities/weather-station.cap.js'
import type { workloadCapability } from '../capabilities/workload.cap.js'
import type { zoneAnalyticsCapability } from '../capabilities/zone-analytics.cap.js'
import type { zoneRulesCapability } from '../capabilities/zone-rules.cap.js'
import type { zonesCapability } from '../capabilities/zones.cap.js'

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
  deviceStatus: InferRuntimeState<typeof deviceStatusCapability>
  dishwasher: InferRuntimeState<typeof dishwasherCapability>
  doNotDisturb: InferRuntimeState<typeof doNotDisturbCapability>
  doorbell: InferRuntimeState<typeof doorbellCapability>
  energySystem: InferRuntimeState<typeof energySystemCapability>
  enumSensor: InferRuntimeState<typeof enumSensorCapability>
  error: InferRuntimeState<typeof errorCapability>
  eventEmitter: InferRuntimeState<typeof eventEmitterCapability>
  fanControl: InferRuntimeState<typeof fanControlCapability>
  featureProbe: InferRuntimeState<typeof featureProbeCapability>
  flood: InferRuntimeState<typeof floodCapability>
  gas: InferRuntimeState<typeof gasCapability>
  groupActive: InferRuntimeState<typeof groupActiveCapability>
  groupCommands: InferRuntimeState<typeof groupCommandsCapability>
  groupStatus: InferRuntimeState<typeof groupStatusCapability>
  heatingValve: InferRuntimeState<typeof heatingValveCapability>
  heatPumpStatus: InferRuntimeState<typeof heatPumpStatusCapability>
  humidifier: InferRuntimeState<typeof humidifierCapability>
  humiditySensor: InferRuntimeState<typeof humiditySensorCapability>
  image: InferRuntimeState<typeof imageCapability>
  imageSettings: InferRuntimeState<typeof imageSettingsCapability>
  intercom: InferRuntimeState<typeof intercomCapability>
  irTransmitter: InferRuntimeState<typeof irTransmitterCapability>
  lawnMowerControl: InferRuntimeState<typeof lawnMowerControlCapability>
  lockControl: InferRuntimeState<typeof lockControlCapability>
  lowPowerSleep: InferRuntimeState<typeof lowPowerSleepCapability>
  mediaPlayer: InferRuntimeState<typeof mediaPlayerCapability>
  meter: InferRuntimeState<typeof meterCapability>
  motion: InferRuntimeState<typeof motionCapability>
  motionTrigger: InferRuntimeState<typeof motionTriggerCapability>
  motionZones: InferRuntimeState<typeof motionZonesCapability>
  nativeObjectDetection: InferRuntimeState<typeof nativeObjectDetectionCapability>
  navigation: InferRuntimeState<typeof navigationCapability>
  networkLink: InferRuntimeState<typeof networkLinkCapability>
  notifier: InferRuntimeState<typeof notifierCapability>
  numericSensor: InferRuntimeState<typeof numericSensorCapability>
  petFeeder: InferRuntimeState<typeof petFeederCapability>
  petFountain: InferRuntimeState<typeof petFountainCapability>
  powerMeter: InferRuntimeState<typeof powerMeterCapability>
  powerSource: InferRuntimeState<typeof powerSourceCapability>
  presence: InferRuntimeState<typeof presenceCapability>
  pressureSensor: InferRuntimeState<typeof pressureSensorCapability>
  privacyMask: InferRuntimeState<typeof privacyMaskCapability>
  ptzAutotrack: InferRuntimeState<typeof ptzAutotrackCapability>
  pumpCycle: InferRuntimeState<typeof pumpCycleCapability>
  recordingOnboard: InferRuntimeState<typeof recordingOnboardCapability>
  recordingSignal: InferRuntimeState<typeof recordingSignalCapability>
  runningState: InferRuntimeState<typeof runningStateCapability>
  sceneMonitor: InferRuntimeState<typeof sceneMonitorCapability>
  scriptRunner: InferRuntimeState<typeof scriptRunnerCapability>
  siren: InferRuntimeState<typeof sirenCapability>
  smoke: InferRuntimeState<typeof smokeCapability>
  streamCatalog: InferRuntimeState<typeof streamCatalogCapability>
  streamParams: InferRuntimeState<typeof streamParamsCapability>
  streamSignals: InferRuntimeState<typeof streamSignalsCapability>
  switch: InferRuntimeState<typeof switchCapability>
  tamper: InferRuntimeState<typeof tamperCapability>
  temperatureSensor: InferRuntimeState<typeof temperatureSensorCapability>
  timedRun: InferRuntimeState<typeof timedRunCapability>
  update: InferRuntimeState<typeof updateCapability>
  vacuumControl: InferRuntimeState<typeof vacuumControlCapability>
  valve: InferRuntimeState<typeof valveCapability>
  vibration: InferRuntimeState<typeof vibrationCapability>
  waterHeater: InferRuntimeState<typeof waterHeaterCapability>
  weather: InferRuntimeState<typeof weatherCapability>
  weatherStation: InferRuntimeState<typeof weatherStationCapability>
  workload: InferRuntimeState<typeof workloadCapability>
  zoneAnalytics: InferRuntimeState<typeof zoneAnalyticsCapability>
  zoneRules: InferRuntimeState<typeof zoneRulesCapability>
  zones: InferRuntimeState<typeof zonesCapability>
}

/**
 * Runtime registry: cap-property-name → cap NAME. `BaseDevice`'s `state`
 * getter looks the name up here to construct a slice proxy lazily on first
 * access; the proxy reads only `cap.name`. Names, not definitions, so this file
 * pulls no schema into a bundle (guard `check-device-local-state-schema-free`,
 * D1073). Generated alongside the type so type and registry can never drift apart.
 */
export const DEVICE_LOCAL_STATE_CAP_NAMES: Readonly<Record<keyof DeviceLocalState, string>> = {
  airQualitySensor: 'air-quality-sensor',
  alarmPanel: 'alarm-panel',
  ambientLightSensor: 'ambient-light-sensor',
  audioMetrics: 'audio-metrics',
  automationControl: 'automation-control',
  battery: 'battery',
  binary: 'binary',
  brightness: 'brightness',
  cameraStreams: 'camera-streams',
  carbonMonoxide: 'carbon-monoxide',
  climateControl: 'climate-control',
  color: 'color',
  connectivity: 'connectivity',
  consumables: 'consumables',
  contact: 'contact',
  control: 'control',
  cover: 'cover',
  dayNight: 'day-night',
  deviceStatus: 'device-status',
  dishwasher: 'dishwasher',
  doNotDisturb: 'do-not-disturb',
  doorbell: 'doorbell',
  energySystem: 'energy-system',
  enumSensor: 'enum-sensor',
  error: 'error',
  eventEmitter: 'event-emitter',
  fanControl: 'fan-control',
  featureProbe: 'feature-probe',
  flood: 'flood',
  gas: 'gas',
  groupActive: 'group-active',
  groupCommands: 'group-commands',
  groupStatus: 'group-status',
  heatingValve: 'heating-valve',
  heatPumpStatus: 'heat-pump-status',
  humidifier: 'humidifier',
  humiditySensor: 'humidity-sensor',
  image: 'image',
  imageSettings: 'image-settings',
  intercom: 'intercom',
  irTransmitter: 'ir-transmitter',
  lawnMowerControl: 'lawn-mower-control',
  lockControl: 'lock-control',
  lowPowerSleep: 'low-power-sleep',
  mediaPlayer: 'media-player',
  meter: 'meter',
  motion: 'motion',
  motionTrigger: 'motion-trigger',
  motionZones: 'motion-zones',
  nativeObjectDetection: 'native-object-detection',
  navigation: 'navigation',
  networkLink: 'network-link',
  notifier: 'notifier',
  numericSensor: 'numeric-sensor',
  petFeeder: 'pet-feeder',
  petFountain: 'pet-fountain',
  powerMeter: 'power-meter',
  powerSource: 'power-source',
  presence: 'presence',
  pressureSensor: 'pressure-sensor',
  privacyMask: 'privacy-mask',
  ptzAutotrack: 'ptz-autotrack',
  pumpCycle: 'pump-cycle',
  recordingOnboard: 'recording-onboard',
  recordingSignal: 'recording-signal',
  runningState: 'running-state',
  sceneMonitor: 'scene-monitor',
  scriptRunner: 'script-runner',
  siren: 'siren',
  smoke: 'smoke',
  streamCatalog: 'stream-catalog',
  streamParams: 'stream-params',
  streamSignals: 'stream-signals',
  switch: 'switch',
  tamper: 'tamper',
  temperatureSensor: 'temperature-sensor',
  timedRun: 'timed-run',
  update: 'update',
  vacuumControl: 'vacuum-control',
  valve: 'valve',
  vibration: 'vibration',
  waterHeater: 'water-heater',
  weather: 'weather',
  weatherStation: 'weather-station',
  workload: 'workload',
  zoneAnalytics: 'zone-analytics',
  zoneRules: 'zone-rules',
  zones: 'zones',
}

/**
 * Cap-name keyed runtime-state map (kebab-case keys, e.g. `'battery'`,
 * `'day-night'`). Companion to `DeviceLocalState` (which uses
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
  'device-status': InferRuntimeState<typeof deviceStatusCapability>
  'dishwasher': InferRuntimeState<typeof dishwasherCapability>
  'do-not-disturb': InferRuntimeState<typeof doNotDisturbCapability>
  'doorbell': InferRuntimeState<typeof doorbellCapability>
  'energy-system': InferRuntimeState<typeof energySystemCapability>
  'enum-sensor': InferRuntimeState<typeof enumSensorCapability>
  'error': InferRuntimeState<typeof errorCapability>
  'event-emitter': InferRuntimeState<typeof eventEmitterCapability>
  'fan-control': InferRuntimeState<typeof fanControlCapability>
  'feature-probe': InferRuntimeState<typeof featureProbeCapability>
  'flood': InferRuntimeState<typeof floodCapability>
  'gas': InferRuntimeState<typeof gasCapability>
  'group-active': InferRuntimeState<typeof groupActiveCapability>
  'group-commands': InferRuntimeState<typeof groupCommandsCapability>
  'group-status': InferRuntimeState<typeof groupStatusCapability>
  'heating-valve': InferRuntimeState<typeof heatingValveCapability>
  'heat-pump-status': InferRuntimeState<typeof heatPumpStatusCapability>
  'humidifier': InferRuntimeState<typeof humidifierCapability>
  'humidity-sensor': InferRuntimeState<typeof humiditySensorCapability>
  'image': InferRuntimeState<typeof imageCapability>
  'image-settings': InferRuntimeState<typeof imageSettingsCapability>
  'intercom': InferRuntimeState<typeof intercomCapability>
  'ir-transmitter': InferRuntimeState<typeof irTransmitterCapability>
  'lawn-mower-control': InferRuntimeState<typeof lawnMowerControlCapability>
  'lock-control': InferRuntimeState<typeof lockControlCapability>
  'low-power-sleep': InferRuntimeState<typeof lowPowerSleepCapability>
  'media-player': InferRuntimeState<typeof mediaPlayerCapability>
  'meter': InferRuntimeState<typeof meterCapability>
  'motion': InferRuntimeState<typeof motionCapability>
  'motion-trigger': InferRuntimeState<typeof motionTriggerCapability>
  'motion-zones': InferRuntimeState<typeof motionZonesCapability>
  'native-object-detection': InferRuntimeState<typeof nativeObjectDetectionCapability>
  'navigation': InferRuntimeState<typeof navigationCapability>
  'network-link': InferRuntimeState<typeof networkLinkCapability>
  'notifier': InferRuntimeState<typeof notifierCapability>
  'numeric-sensor': InferRuntimeState<typeof numericSensorCapability>
  'pet-feeder': InferRuntimeState<typeof petFeederCapability>
  'pet-fountain': InferRuntimeState<typeof petFountainCapability>
  'power-meter': InferRuntimeState<typeof powerMeterCapability>
  'power-source': InferRuntimeState<typeof powerSourceCapability>
  'presence': InferRuntimeState<typeof presenceCapability>
  'pressure-sensor': InferRuntimeState<typeof pressureSensorCapability>
  'privacy-mask': InferRuntimeState<typeof privacyMaskCapability>
  'ptz-autotrack': InferRuntimeState<typeof ptzAutotrackCapability>
  'pump-cycle': InferRuntimeState<typeof pumpCycleCapability>
  'recording-onboard': InferRuntimeState<typeof recordingOnboardCapability>
  'recording-signal': InferRuntimeState<typeof recordingSignalCapability>
  'running-state': InferRuntimeState<typeof runningStateCapability>
  'scene-monitor': InferRuntimeState<typeof sceneMonitorCapability>
  'script-runner': InferRuntimeState<typeof scriptRunnerCapability>
  'siren': InferRuntimeState<typeof sirenCapability>
  'smoke': InferRuntimeState<typeof smokeCapability>
  'stream-catalog': InferRuntimeState<typeof streamCatalogCapability>
  'stream-params': InferRuntimeState<typeof streamParamsCapability>
  'stream-signals': InferRuntimeState<typeof streamSignalsCapability>
  'switch': InferRuntimeState<typeof switchCapability>
  'tamper': InferRuntimeState<typeof tamperCapability>
  'temperature-sensor': InferRuntimeState<typeof temperatureSensorCapability>
  'timed-run': InferRuntimeState<typeof timedRunCapability>
  'update': InferRuntimeState<typeof updateCapability>
  'vacuum-control': InferRuntimeState<typeof vacuumControlCapability>
  'valve': InferRuntimeState<typeof valveCapability>
  'vibration': InferRuntimeState<typeof vibrationCapability>
  'water-heater': InferRuntimeState<typeof waterHeaterCapability>
  'weather': InferRuntimeState<typeof weatherCapability>
  'weather-station': InferRuntimeState<typeof weatherStationCapability>
  'workload': InferRuntimeState<typeof workloadCapability>
  'zone-analytics': InferRuntimeState<typeof zoneAnalyticsCapability>
  'zone-rules': InferRuntimeState<typeof zoneRulesCapability>
  'zones': InferRuntimeState<typeof zonesCapability>
}
