/**
 * camstack device → Google Home `SyncDevice`.
 *
 * Pure: everything it needs arrives in `ExportableDeviceFacts`, so the whole
 * projection is testable without a hub. The I/O that gathers those facts lives
 * in `../intents/sync.ts`.
 *
 * **Coverage is decided by CAPABILITIES, not by `DeviceType`.** That doctrine
 * is already written into the live Home Assistant exporter
 * (`SUPPORTED_DEVICE_KINDS` in `ha-export.addon.ts`) and it is what kept the
 * previous exporter confined to cameras. `DeviceType` is consulted for exactly
 * one thing here — picking between two Google types that carry the SAME traits
 * (a LIGHT and a SWITCH are both OnOff). A washer, dryer or dishwasher is
 * withheld even when some other trait would match: Google's laundry types
 * require RunCycle, and this export does not publish that trait.
 */
import { applianceExport, DeviceType } from '@camstack/types'

import type { GoogleDeviceType, GoogleTraitName, SyncDevice } from './protocol.js'
import { traitsForCaps } from './trait-catalog.js'

/** Everything the projection needs about one device. */
export interface ExportableDeviceFacts {
  readonly deviceId: number
  readonly name: string
  /** `DeviceInfo.type` — a `DeviceType` value, but string-typed on the wire. */
  readonly deviceType: string
  /** `DeviceInfo.features` — `DeviceFeature` values. */
  readonly features: readonly string[]
  /** Capability names from `deviceManager.getBindings`. */
  readonly capNames: readonly string[]
}

const MANUFACTURER = 'CamStack'

/**
 * Pick the Google device type. Trait-led, then type-led:
 *
 * - a lock is a LOCK and a cover is a SHUTTER regardless of anything else —
 *   the trait fully determines the affordance Google renders;
 * - otherwise the device is an on/off actuator, and only then does
 *   `DeviceType` choose between LIGHT and SWITCH.
 *
 * `Siren` deliberately lands on SWITCH: Google has no siren type, and SWITCH
 * is the only type whose single trait (OnOff) the device actually implements.
 * A SECURITYSYSTEM would promise `ArmDisarm`, which nothing here answers.
 */
export function resolveGoogleDeviceType(
  deviceType: string,
  traits: readonly GoogleTraitName[],
): GoogleDeviceType | null {
  const withheld = applianceExport('google', deviceType)
  if (withheld !== null && !withheld.exported) return null
  if (traits.includes('action.devices.traits.LockUnlock')) return 'action.devices.types.LOCK'
  if (traits.includes('action.devices.traits.OpenClose')) return 'action.devices.types.SHUTTER'
  if (
    !traits.includes('action.devices.traits.OnOff') &&
    !traits.includes('action.devices.traits.Brightness')
  ) {
    return null
  }
  if (deviceType === DeviceType.Light) return 'action.devices.types.LIGHT'
  return 'action.devices.types.SWITCH'
}

/**
 * Build the SYNC entry for one device, or `null` when nothing in the catalog
 * matches its bound capabilities.
 *
 * `null` is a real outcome, not an error: the operator can expose any device
 * the picker offers, and a device whose only capabilities are `camera-streams`
 * and `snapshot` has no Google representation this addon can honour. The
 * CALLER logs it with `tags: { deviceId }` — a device that silently fails to
 * appear in the Home app is the single hardest thing to diagnose here.
 */
export function buildSyncDevice(facts: ExportableDeviceFacts): SyncDevice | null {
  const descriptors = traitsForCaps(facts.capNames)
  if (descriptors.length === 0) return null

  const traits: readonly GoogleTraitName[] = descriptors.map((d) => d.trait)
  const type = resolveGoogleDeviceType(facts.deviceType, traits)
  if (type === null) return null

  const attributes: Record<string, unknown> = {}
  for (const descriptor of descriptors) {
    Object.assign(attributes, descriptor.attributes(facts.features))
  }

  const base: SyncDevice = {
    id: String(facts.deviceId),
    type,
    traits,
    name: { name: facts.name },
    // Never true in this addon. See `SyncDevice.willReportState`.
    willReportState: false,
    deviceInfo: { manufacturer: MANUFACTURER, model: facts.deviceType },
  }
  return Object.keys(attributes).length > 0 ? { ...base, attributes } : base
}

/**
 * camstack device kinds the `device-export` picker should offer. Derived from
 * the same catalog rather than hand-listed, so a new trait row widens the
 * picker in the same commit that makes the trait work.
 *
 * `listSupportedDeviceKinds` is only a UI filter (nothing enforces it on
 * `exposeDevice`), which is exactly why `buildSyncDevice` still returns `null`
 * for an unmappable device instead of trusting this list.
 */
export const SUPPORTED_DEVICE_KINDS: readonly string[] = [
  DeviceType.Light,
  DeviceType.Switch,
  DeviceType.Siren,
  DeviceType.Lock,
  DeviceType.Cover,
]
