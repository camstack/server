import type { Sensor } from '@apocaliss92/nodewitt'
import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import {
  capForQuantity,
  deviceGroupForSensor,
  deviceGroupLabel,
  ECOWITT_DEVICE_GROUPS,
  type EcowittDeviceGroup,
  sensorLabel,
} from './ecowitt-mapping.js'

/**
 * Minimal structural subset of a nodewitt {@link Sensor} the discovery code
 * needs. Structurally compatible with the real `Sensor` + test fixtures.
 */
export type EcowittDiscoverableSensor = Pick<
  Sensor,
  'id' | 'quantity' | 'channel' | 'model' | 'name' | 'category'
>

/**
 * The native id a group Container candidate is keyed on: `<gatewayId>:<group>`.
 * `gatewayId` is the gateway Hub's stableId, which ALREADY carries the `ecowitt:`
 * prefix (see `addon.ts` generateStableId) — so this must NOT re-add it, else the
 * id double-prefixes to `ecowitt:ecowitt:<gw>:<group>`. One physical gateway
 * yields THREE candidates (one per {@link EcowittDeviceGroup}).
 */
export function groupNativeId(gatewayId: string, group: EcowittDeviceGroup): string {
  return `${gatewayId}:${group}`
}

export interface BuildEcowittCandidateInput {
  /** The gateway Hub device's stableId (= gateway identity). */
  readonly gatewayId: string
  /** Operator-overridable / derived gateway label. */
  readonly gatewayName: string
  /** Current sensors on the gateway. */
  readonly sensors: readonly EcowittDiscoverableSensor[]
  /**
   * Adopted CamStack device id PER device group, or null when that group's
   * Container is not yet adopted. A missing key is treated as null.
   */
  readonly adoptedDeviceIdByGroup: Readonly<Partial<Record<EcowittDeviceGroup, number | null>>>
}

/** A preview accessory child for one sensor. */
function sensorChild(sensor: EcowittDiscoverableSensor): DiscoveredChildDevice {
  return {
    childNativeId: sensor.id,
    name: sensorLabel(sensor.quantity, sensor.channel, sensor.name, sensor.id),
    type: DeviceType.Sensor,
    status: 'online',
    metadata: sensor.model !== undefined ? { model: sensor.model } : {},
    alreadyAdopted: false,
    adoptedDeviceId: null,
    capabilities: [capForQuantity(sensor.quantity)],
  }
}

/**
 * Build the THREE gateway adoption candidates (one {@link DeviceType.Container}
 * per {@link EcowittDeviceGroup}) for a single physical gateway. Each Container
 * carries only the sensors whose device group matches, as preview accessory
 * children that the Container's `getAccessoryChildren()` materialises on
 * adoption. Pure: no I/O.
 *
 * Discovery option (documented decision): we return 3 SEPARATE top-level
 * Container candidates (not 1 parent with 3 group-tagged children). Each maps 1:1
 * to a real adopted device, so the existing per-candidate adopt/release/resync
 * machinery (keyed on `childNativeId`) extends directly — the alternative
 * (nested group children under one parent) would require a new two-level
 * adoption shape and is higher-risk. Sensors are split by
 * {@link deviceGroupForSensor}; an empty group still yields a Container so its
 * sensors can appear as they come online over time (additive reconcile).
 *
 * Per the plan (model A), each sensor maps to a typed sensor cap; the `weather`
 * cap is intentionally NOT used (a raw station has no sky-state `condition`).
 */
export function buildEcowittGatewayCandidates(
  input: BuildEcowittCandidateInput,
): readonly DiscoveredChildDevice[] {
  const byGroup = new Map<EcowittDeviceGroup, DiscoveredChildDevice[]>()
  for (const group of ECOWITT_DEVICE_GROUPS) byGroup.set(group, [])
  for (const sensor of input.sensors) {
    const group = deviceGroupForSensor(sensor.category, sensor.channel)
    byGroup.get(group)?.push(sensorChild(sensor))
  }

  return ECOWITT_DEVICE_GROUPS.map((group) => {
    const adoptedDeviceId = input.adoptedDeviceIdByGroup[group] ?? null
    const children = byGroup.get(group) ?? []
    return {
      childNativeId: groupNativeId(input.gatewayId, group),
      name: `${input.gatewayName} — ${deviceGroupLabel(group)}`,
      type: DeviceType.Container,
      status: 'online',
      // The device group is already encoded in `childNativeId`
      // (`ecowitt:<gatewayId>:<group>`); metadata is a closed shape, so we keep
      // only the gateway serial here.
      metadata: { serialNumber: input.gatewayId },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: [],
      children,
    } satisfies DiscoveredChildDevice
  })
}
