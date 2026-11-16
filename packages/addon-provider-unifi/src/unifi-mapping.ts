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

/** One port of one infra device. */
export interface UnifiPortRef {
  readonly infraId: string
  readonly portIdx: number
}

/**
 * The hook that names a PoE port after the client plugged into it (planning#583). The
 * Integration API does not say which port a wired client sits on, so the default knows none.
 */
export type UnifiPortClientNamer = (port: UnifiPortRef) => string | null

/** The default {@link UnifiPortClientNamer}: no port has a known client. */
export const NO_PORT_CLIENT_NAMES: UnifiPortClientNamer = () => null

/** A PoE port's label: its client when one is known, else its number. */
export function poePortLabel(portIdx: number | undefined, clientName: string | null): string {
  const port = portIdx ?? '?'
  return clientName !== null && clientName.length > 0
    ? `${clientName} (port ${port})`
    : `Port ${port} PoE`
}

/** A human-facing label for a spawned switch/button/sensor child. */
export function featureLabel(
  descriptor: UnifiFeatureDescriptor,
  clientName: string | null = null,
): string {
  switch (descriptor.kind) {
    case 'switch':
      if (descriptor.switchFeature === 'led') return 'LED'
      return poePortLabel(descriptor.portIdx, clientName)
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
 *   - a device-level restart button (no LED switch: the Integration API can neither read nor
 *     set the LED, so it is not offered),
 *   - cpu / temp / clients / state / uptime sensors.
 * Pure — no I/O. Unit-testable in isolation.
 */
export function buildInfraFeatures(snapshot: UnifiInfraSnapshot): UnifiFeatureDescriptor[] {
  const features: UnifiFeatureDescriptor[] = []

  // Whole-device controls.
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

/** A feature no client can serve any more: dropped by the reconcile, never re-offered. */
function isRetiredFeature(descriptor: UnifiFeatureDescriptor): boolean {
  return descriptor.kind === 'switch' && descriptor.switchFeature === 'led'
}

/**
 * The features an adopted infra device keeps after a poll: everything the snapshot derives, plus
 * every feature it already had. A read that did not answer (a device detail without ports,
 * statistics without cpu or uptime) looks like a feature that vanished, so the reconcile only
 * ADDS; only a retired feature (the LED switch) is removed. Pure.
 */
export function mergeInfraFeatures(
  current: readonly UnifiFeatureDescriptor[],
  derived: readonly UnifiFeatureDescriptor[],
): UnifiFeatureDescriptor[] {
  const derivedKeys = new Set(derived.map(featureSuffix))
  const kept = current.filter((d) => !isRetiredFeature(d) && !derivedKeys.has(featureSuffix(d)))
  return [...derived, ...kept]
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
