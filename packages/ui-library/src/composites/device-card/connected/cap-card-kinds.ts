import { DeviceRole, DeviceType } from '@camstack/types'

/**
 * The cards a device gets from ONE cap that its type names: a lock needs
 * `lock-control`, an alarm panel `alarm-panel`, and so on. A siren is the
 * `switch` of a siren device or of a switch in the siren role. A gateway needs
 * none: it is drawn from its reachability and whatever it binds.
 */
export type CapCardKind =
  | 'lock'
  | 'alarm'
  | 'humidifier'
  | 'valve'
  | 'siren'
  | 'pet-feeder'
  | 'pet-fountain'
  | 'weather'
  | 'button'
  | 'update'
  | 'script'
  | 'automation'
  | 'control'
  | 'event'
  | 'image'
  | 'notifier'
  | 'gateway'

const BY_TYPE: Readonly<
  Partial<Record<DeviceType, { readonly cap: string | null; readonly kind: CapCardKind }>>
> = {
  [DeviceType.Lock]: { cap: 'lock-control', kind: 'lock' },
  [DeviceType.AlarmPanel]: { cap: 'alarm-panel', kind: 'alarm' },
  [DeviceType.Humidifier]: { cap: 'humidifier', kind: 'humidifier' },
  [DeviceType.Valve]: { cap: 'valve', kind: 'valve' },
  [DeviceType.Siren]: { cap: 'switch', kind: 'siren' },
  [DeviceType.PetFeeder]: { cap: 'pet-feeder', kind: 'pet-feeder' },
  [DeviceType.PetFountain]: { cap: 'pet-fountain', kind: 'pet-fountain' },
  [DeviceType.Weather]: { cap: 'weather', kind: 'weather' },
  [DeviceType.Button]: { cap: 'button', kind: 'button' },
  [DeviceType.Update]: { cap: 'update', kind: 'update' },
  [DeviceType.Script]: { cap: 'script-runner', kind: 'script' },
  [DeviceType.Automation]: { cap: 'automation-control', kind: 'automation' },
  [DeviceType.Control]: { cap: 'control', kind: 'control' },
  [DeviceType.EventEmitter]: { cap: 'event-emitter', kind: 'event' },
  [DeviceType.Image]: { cap: 'image', kind: 'image' },
  [DeviceType.Notifier]: { cap: 'notifier', kind: 'notifier' },
  // The bridge box has no cap of its own: its card is its reachability, its
  // facts and whichever of `reboot` / `device-admin-link` it binds.
  [DeviceType.Gateway]: { cap: null, kind: 'gateway' },
}

const DEVICE_TYPES: ReadonlySet<string> = new Set(Object.values(DeviceType))
const isDeviceType = (value: string): value is DeviceType => DEVICE_TYPES.has(value)

/**
 * The cap-named card of a device: the kind when it binds the cap, null when it
 * is one of these types but lacks the cap, undefined when the type is not one
 * of these (the caller keeps resolving).
 */
export function capCardKindOf(
  deviceType: string,
  role: string | null | undefined,
  capNames: readonly string[],
): CapCardKind | null | undefined {
  if (deviceType === DeviceType.Switch && role === DeviceRole.Siren)
    return capNames.includes('switch') ? 'siren' : null
  if (!isDeviceType(deviceType)) return undefined
  const entry = BY_TYPE[deviceType]
  if (entry === undefined) return undefined
  return entry.cap === null || capNames.includes(entry.cap) ? entry.kind : null
}
