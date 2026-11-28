import { DeviceRole, DeviceType, type ReadingQuantity } from '@dominevo/types'
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

/**
 * The quantity a numeric sensor metric reads in, declared on `SourceInfo` (D944) so the display
 * unit and a humanized duration follow from it. Undefined for a metric not on `numeric-sensor`.
 */
export function quantityForMetric(metric: UnifiSensorMetric): ReadingQuantity | undefined {
  switch (metric) {
    case 'cpu_utilization':
      return 'percentage'
    case 'uptime':
      return 'duration'
    case 'clients':
      return 'count'
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
 * The hook that names a PoE port after the client plugged into it (planning#583). Only the
 * classic API (a local account) says which port a wired client sits on (`stat/sta` `sw_mac` +
 * `sw_port`); {@link portClientNamerOf} reads it off the snapshots.
 */
export type UnifiPortClientNamer = (port: UnifiPortRef) => string | null

/** The default {@link UnifiPortClientNamer}: no port has a known client. */
export const NO_PORT_CLIENT_NAMES: UnifiPortClientNamer = () => null

/** The namer that reads each port's client off the infra snapshots. */
export function portClientNamerOf(infra: readonly UnifiInfraSnapshot[]): UnifiPortClientNamer {
  return ({ infraId, portIdx }) =>
    infra.find((d) => d.id === infraId)?.ports.find((p) => p.idx === portIdx)?.clientName ?? null
}

/** The semantic role of a PoE port device: a `switch` device with the `poe-port` role. */
export const UNIFI_POE_PORT_ROLE: DeviceRole = DeviceRole.PoePort

/** A PoE port's name: "<client> (port N)" when its client is known, else "Port N". */
export function portLabel(portIdx: number | undefined, clientName: string | null): string {
  const port = portIdx ?? '?'
  return clientName !== null && clientName.length > 0
    ? `${clientName} (port ${port})`
    : `Port ${port}`
}

/** What to do with an adopted port's name when its client name changed. */
export type UnifiPortNameWrite =
  | { readonly kind: 'keep' }
  | {
      readonly kind: 'rename'
      readonly name: string
      readonly stampUserNamed: boolean
    }

/**
 * Whether an adopted port device may take its new automatic name. A name this addon generated
 * ("Port N", the old "Port N PoE", "<anything> (port N)", the stable-id placeholder) follows the
 * client; anything else is an operator rename and is kept. `stampUserNamed` mirrors the row's
 * flag (the device manager refuses a system rename of a flagged row otherwise). Pure.
 */
export function portNameWrite(input: {
  readonly currentName: string
  readonly userNamed: boolean | undefined
  readonly desiredName: string
  readonly portIdx: number
  readonly stableId: string
}): UnifiPortNameWrite {
  const { currentName, portIdx } = input
  if (currentName === input.desiredName) return { kind: 'keep' }
  const auto =
    currentName === `Port ${portIdx}` ||
    currentName === `Port ${portIdx} PoE` ||
    currentName.endsWith(` (port ${portIdx})`) ||
    currentName === input.stableId
  if (!auto && input.userNamed !== false) return { kind: 'keep' }
  return {
    kind: 'rename',
    name: input.desiredName,
    stampUserNamed: input.userNamed === true,
  }
}

/**
 * Whether an adopted infra device takes the controller's name. The device manager's flag decides:
 * `userNamed` true is an operator rename and is kept; false is a name the system wrote, which
 * follows the controller. A row without the flag (legacy) follows only while it still carries
 * the name this addon adopted it under — any other name is the operator's. Pure.
 */
export function infraNameWrite(input: {
  readonly currentName: string
  readonly userNamed: boolean | undefined
  readonly adoptedName: string | undefined
  readonly desiredName: string
}): { readonly kind: 'keep' } | { readonly kind: 'rename'; readonly name: string } {
  if (input.desiredName.length === 0 || input.currentName === input.desiredName) {
    return { kind: 'keep' }
  }
  if (input.userNamed === true) return { kind: 'keep' }
  if (input.userNamed === undefined && input.currentName !== input.adoptedName) {
    return { kind: 'keep' }
  }
  return { kind: 'rename', name: input.desiredName }
}

/** A human-facing label for a spawned switch/button/sensor child. */
export function featureLabel(
  descriptor: UnifiFeatureDescriptor,
  clientName: string | null = null,
): string {
  switch (descriptor.kind) {
    case 'switch':
      if (descriptor.switchFeature === 'led') return 'LED'
      return portLabel(descriptor.portIdx, clientName)
    case 'port':
      return portLabel(descriptor.portIdx, clientName)
    case 'button':
      if (descriptor.buttonAction === 'restart') return 'Restart'
      return `Port ${descriptor.portIdx ?? '?'} power cycle`
    case 'sensor':
      return descriptor.metric !== undefined ? sensorLabelForMetric(descriptor.metric) : 'Sensor'
  }
}

/** The Dominevo DeviceType a feature descriptor spawns. */
export function deviceTypeForDescriptor(descriptor: UnifiFeatureDescriptor): DeviceType {
  switch (descriptor.kind) {
    case 'switch':
    case 'port':
      return DeviceType.Switch
    case 'button':
      return DeviceType.Button
    case 'sensor':
      return DeviceType.Sensor
  }
}

/** The caps a PoE port device registers: `switch` always — on/off with a local account, else only a native power cycle. */
export function capsForPort(): readonly string[] {
  return ['switch', 'power-meter', 'network-link']
}

/** The cap names a feature descriptor's child registers. */
export function capsForDescriptor(descriptor: UnifiFeatureDescriptor): readonly string[] {
  switch (descriptor.kind) {
    case 'switch':
      return ['switch']
    case 'button':
      return ['button']
    case 'sensor':
      return [descriptor.metric !== undefined ? capForMetric(descriptor.metric) : 'numeric-sensor']
    case 'port':
      return capsForPort()
  }
}

/** The optional `DeviceRole` a feature descriptor's child renders with. */
export function roleForDescriptor(descriptor: UnifiFeatureDescriptor): DeviceRole | undefined {
  if (descriptor.kind === 'sensor' && descriptor.metric !== undefined) {
    return roleForMetric(descriptor.metric)
  }
  if (descriptor.kind === 'port') return UNIFI_POE_PORT_ROLE
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
    case 'port':
      return `port-${descriptor.portIdx ?? 0}`
  }
}

/** The identity of a descriptor for the equality check: a port also differs by `switchable`. */
function featureKey(descriptor: UnifiFeatureDescriptor): string {
  const suffix = featureSuffix(descriptor)
  return descriptor.kind === 'port' ? `${suffix}:${descriptor.switchable === true}` : suffix
}

/**
 * Derive the full feature-descriptor list an infra device fans out into:
 *   - one `port` device per PoE-capable port (a non-PoE port is not a device), `switchable` when
 *     the client can switch PoE (a local account is set) — without it the port offers no switch,
 *     only the power reading and the link. A restart through PoE is the POWERED device's
 *     `power-source` cap pointed at this port's switch, never a button on the port,
 *   - no device-level button: the restart is the device's own `workload.restart`, and an LED
 *     switch is not offered,
 *   - cpu / temp / clients / state / uptime sensors.
 * Pure — no I/O. Unit-testable in isolation.
 */
export function buildInfraFeatures(snapshot: UnifiInfraSnapshot): UnifiFeatureDescriptor[] {
  const features: UnifiFeatureDescriptor[] = []

  // One device per PoE-capable port.
  for (const port of snapshot.ports) {
    if (!port.poeCapable) continue
    features.push({
      kind: 'port',
      portIdx: port.idx,
      switchable: snapshot.poeSwitchable,
    })
  }

  // Telemetry sensors (only surface metrics the model reports).
  if (snapshot.cpuPercent !== null) features.push({ kind: 'sensor', metric: 'cpu_utilization' })
  if (snapshot.cpuTempC !== null) features.push({ kind: 'sensor', metric: 'cpu_temperature' })
  features.push({ kind: 'sensor', metric: 'clients' })
  features.push({ kind: 'sensor', metric: 'state' })
  if (snapshot.uptimeSec !== null) features.push({ kind: 'sensor', metric: 'uptime' })

  return features
}

/**
 * A feature no longer offered: dropped by the reconcile, never re-offered. The LED switch, and the
 * per-port PoE switch + power-cycle button the `port` device replaced (planning#583).
 */
function isRetiredFeature(descriptor: UnifiFeatureDescriptor): boolean {
  if (descriptor.kind === 'switch') return true
  return descriptor.kind === 'button' && descriptor.buttonAction === 'power-cycle'
}

/**
 * The features an adopted infra device keeps after a poll: everything the snapshot derives, plus
 * every feature it already had. A read that did not answer (a device detail without ports,
 * statistics without cpu or uptime) looks like a feature that vanished, so the reconcile only
 * ADDS; only a retired feature is removed. A port's `switchable` follows the snapshot, which
 * takes it from the configuration (a local account), never from a read. Pure.
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
  const aKeys = new Set(a.map(featureKey))
  for (const descriptor of b) {
    if (!aKeys.has(featureKey(descriptor))) return false
  }
  return true
}
