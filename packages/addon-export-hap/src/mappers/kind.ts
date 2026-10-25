/**
 * Which orchestrator a device gets, which device types the picker offers, and
 * what a device's HomeKit accessory is called on the wire.
 *
 * Separate from `index.ts` (the factory registry) only so the orchestrators can
 * import the uuid convention without importing the registry that imports them.
 */
import { DeviceType } from '@camstack/types'
import { uuid } from '@homebridge/hap-nodejs'

/** Mapper kind id — the orchestrator that builds a device's accessory. */
export type MapperKind = 'camera' | 'generic'

export const SUPPORTED_MAPPER_KINDS: readonly MapperKind[] = ['camera', 'generic']

/**
 * The device types the Export picker offers, and the answer to the cap's
 * `listSupportedDeviceKinds`.
 *
 * A UI FILTER, nothing more. Whether a device actually exports anything is
 * decided by its capabilities (`rowsForCaps` in the capability table) — the
 * doctrine the HA exporter writes down, and the thing that confined the
 * previous exporter to cameras when it was ignored.
 *
 * Tier A plus `alarm-panel`: the types whose HomeKit services exist today and
 * need no feature-dependent shape. `cover`, `climate`, `fan`, `valve`,
 * `humidifier`, `water-heater`, `button` and `media-player` are deliberately
 * absent — each needs a service whose semantics the table cannot yet honour,
 * and offering the tab before the mapping exists is how an operator gets an
 * accessory that pairs and does nothing.
 *
 * `alarm-panel` is no longer one of them. It maps to `Service.SecuritySystem`
 * (`builders/generic/security-system.ts`), and the two things the table could
 * not previously honour are now honoured explicitly: HomeKit is only ever
 * offered the arm modes the panel accepts, and a panel that requires a PIN
 * refuses the write out loud instead of pretending to arm.
 */
export const HAP_EXPORTABLE_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Camera,
  DeviceType.Light,
  DeviceType.Switch,
  DeviceType.Siren,
  DeviceType.Sensor,
  DeviceType.Lock,
  DeviceType.Presence,
  DeviceType.AlarmPanel,
  DeviceType.Generic,
]

/**
 * Resolve the orchestrator for a device from its TYPE.
 *
 * `null` means "no Export tab": the picker must not offer a type no
 * orchestrator can build. An UNKNOWN type (the device-manager read failed) maps
 * to `camera` — that is what every entry persisted before this function existed
 * carries, and a transient API failure must never re-shape an exposed camera.
 */
export function pickMapperKind(deviceType: string | null | undefined): MapperKind | null {
  if (deviceType === null || deviceType === undefined || deviceType.length === 0) return 'camera'
  if (deviceType === DeviceType.Camera) return 'camera'
  const known = HAP_EXPORTABLE_DEVICE_TYPES.find((type) => type === deviceType)
  return known === undefined ? null : 'generic'
}

/**
 * The deterministic HAP accessory UUID for a device.
 *
 * One function, because three call sites depend on the answer agreeing: the
 * orchestrator that builds the accessory, `unexposeDevice` (which wipes
 * hap-nodejs' pairing blobs by uuid, on a device whose mapper is already gone)
 * and the export sync state that records it.
 *
 * The camera namespace is FROZEN — every camera paired to date derives its MAC
 * from `sha256("camstack:hap:" + uuid)` of this exact string, and changing it
 * would make every paired camera a stranger. Generic devices get their own
 * namespace so a switch and a camera that happen to share a device id are not
 * the same HomeKit accessory.
 */
export function accessoryUuidFor(kind: MapperKind, deviceId: number): string {
  return uuid.generate(
    kind === 'camera' ? `camstack:camera:${deviceId}` : `camstack:device:${deviceId}`,
  )
}
