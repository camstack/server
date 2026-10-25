import { DeviceRole, DeviceType } from '@camstack/types'
import type { UnifiFeatureDescriptor, UnifiSensorMetric } from './config.js'
import type { UnifiInfraSnapshot } from './unifi-client-contract.js'

/** The cap a given sensor metric maps to. */
export type UnifiSensorCap = 'numeric-sensor' | 'temperature-sensor' | 'enum-sensor'

/** Resolve the cap name a sensor metric surfaces on. */
export function capForMetric(metric: UnifiSensorMetric): UnifiSensorCap {
  switch (metric) {
    case 'cpu_temperature':
      return 'temperature-sensor'
    case 'state':
      return 'enum-sensor'
    default:
      // cpu_utilization (%), clients (count), uptime (s)
      return 'numeric-sensor'
  }
}

/** The display unit for a numeric sensor metric, or undefined when unitless. */
export function unitForMetric(metric: UnifiSensorMetric): string | undefined {
  switch (metric) {
    case 'cpu_utilization':
      return '%'
    case 'uptime':
      return 's'
    default:
      return undefined
  }
}

/** The semantic `DeviceRole` a sensor metric renders with. */
export function roleForMetric(metric: UnifiSensorMetric): DeviceRole {
  switch (metric) {
    case 'cpu_temperature':
      return DeviceRole.TemperatureSensor
    case 'state':
      return DeviceRole.EnumSensor
    default:
      return DeviceRole.NumericSensor
  }
}

/** A human-facing label for a sensor metric child. */
export function sensorLabelForMetric(metric: UnifiSensorMetric): string {
  switch (metric) {
    case 'cpu_utilization':
      return 'CPU utilization'
    case 'cpu_temperature':
      return 'CPU temperature'
    case 'clients':
      return 'Clients'
    case 'state':
      return 'State'
    case 'uptime':
      return 'Uptime'
  }
}

/** A human-facing label for a spawned switch/button/sensor child. */
export function featureLabel(descriptor: UnifiFeatureDescriptor): string {
  switch (descriptor.kind) {
    case 'switch':
      if (descriptor.switchFeature === 'led') return 'LED'
      return `Port ${descriptor.portIdx ?? '?'} PoE`
    case 'button':
      if (descriptor.buttonAction === 'restart') return 'Restart'
      return `Port ${descriptor.portIdx ?? '?'} power cycle`
    case 'sensor':
      return descriptor.metric !== undefined ? sensorLabelForMetric(descriptor.metric) : 'Sensor'
  }
}

/** The CamStack DeviceType a feature descriptor spawns. */
export function deviceTypeForDescriptor(descriptor: UnifiFeatureDescriptor): DeviceType {
  switch (descriptor.kind) {
    case 'switch':
      return DeviceType.Switch
    case 'button':
      return DeviceType.Button
    case 'sensor':
      return DeviceType.Sensor
  }
}

/** The cap name a feature descriptor's child registers. */
export function capForDescriptor(descriptor: UnifiFeatureDescriptor): string {
  switch (descriptor.kind) {
    case 'switch':
      return 'switch'
    case 'button':
      return 'button'
    case 'sensor':
      return descriptor.metric !== undefined ? capForMetric(descriptor.metric) : 'numeric-sensor'
  }
}

/** The optional `DeviceRole` a feature descriptor's child renders with. */
export function roleForDescriptor(descriptor: UnifiFeatureDescriptor): DeviceRole | undefined {
  if (descriptor.kind === 'sensor' && descriptor.metric !== undefined) {
    return roleForMetric(descriptor.metric)
  }
  return undefined
}

/** The stable per-(infra, feature) suffix used for the accessory child stableId. */
export function featureSuffix(descriptor: UnifiFeatureDescriptor): string {
  switch (descriptor.kind) {
    case 'switch':
      return descriptor.switchFeature === 'led' ? 'led' : `poe-${descriptor.portIdx ?? 0}`
    case 'button':
      return descriptor.buttonAction === 'restart'
        ? 'restart'
        : `power-cycle-${descriptor.portIdx ?? 0}`
    case 'sensor':
      return `sensor-${descriptor.metric ?? 'unknown'}`
  }
}

/**
 * Derive the full feature-descriptor list an infra device fans out into:
 *   - per-PoE-port PoE switch + power-cycle button,
 *   - a device-level LED switch + restart button,
 *   - cpu / temp / clients / state / uptime sensors.
 * Pure — no I/O. Unit-testable in isolation.
 */
export function buildInfraFeatures(snapshot: UnifiInfraSnapshot): UnifiFeatureDescriptor[] {
  const features: UnifiFeatureDescriptor[] = []

  // Whole-device controls.
  features.push({ kind: 'switch', switchFeature: 'led' })
  features.push({ kind: 'button', buttonAction: 'restart' })

  // Per-PoE-port controls.
  for (const port of snapshot.ports) {
    if (!port.poeCapable) continue
    features.push({ kind: 'switch', switchFeature: 'poe', portIdx: port.idx })
    features.push({ kind: 'button', buttonAction: 'power-cycle', portIdx: port.idx })
  }

  // Telemetry sensors (only surface metrics the model reports).
  if (snapshot.cpuPercent !== null) features.push({ kind: 'sensor', metric: 'cpu_utilization' })
  if (snapshot.cpuTempC !== null) features.push({ kind: 'sensor', metric: 'cpu_temperature' })
  features.push({ kind: 'sensor', metric: 'clients' })
  features.push({ kind: 'sensor', metric: 'state' })
  if (snapshot.uptimeSec !== null) features.push({ kind: 'sensor', metric: 'uptime' })

  return features
}

/** Structural equality of two persisted feature lists (order-independent by suffix). */
export function featuresEqual(
  a: readonly UnifiFeatureDescriptor[],
  b: readonly UnifiFeatureDescriptor[],
): boolean {
  if (a.length !== b.length) return false
  const aKeys = new Set(a.map(featureSuffix))
  for (const descriptor of b) {
    if (!aKeys.has(featureSuffix(descriptor))) return false
  }
  return true
}
