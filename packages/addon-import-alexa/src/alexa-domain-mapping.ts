import { DeviceType } from '@camstack/types'

/**
 * Pure mapping from an Alexa smart-home capability interface to the CamStack
 * typed cap the accessory child registers. Inverts the Alexa EXPORTER's
 * discovery table (`addon-export-alexa/endpoints/builder.ts`). Unit-tested in
 * isolation — NO alexa-remote2 import here so the mapping is a pure, total
 * function over plain interface-name strings.
 *
 * Plan §1.2 table. An Alexa appliance reports one or more capability interfaces;
 * each maps to a CamStack cap, and a multi-capability appliance yields several
 * caps on one child (e.g. a colour bulb = PowerController + BrightnessController
 * + ColorController → switch + brightness + color).
 */

/** The CamStack device-native caps an Alexa interface can map onto (v1 subset). */
export type AlexaCap =
  | 'switch'
  | 'brightness'
  | 'color'
  | 'lock-control'
  | 'climate-control'
  | 'cover'
  | 'temperature-sensor'
  | 'humidity-sensor'
  | 'contact'
  | 'motion'
  | 'control'
  | 'button'
  | 'numeric-sensor'

/** One Alexa capability interface → the caps it contributes. */
const INTERFACE_TO_CAPS: ReadonlyMap<string, readonly AlexaCap[]> = new Map<
  string,
  readonly AlexaCap[]
>([
  ['Alexa.PowerController', ['switch']],
  ['Alexa.BrightnessController', ['brightness']],
  ['Alexa.ColorController', ['color']],
  ['Alexa.ColorTemperatureController', ['color']],
  ['Alexa.LockController', ['lock-control']],
  ['Alexa.ThermostatController', ['climate-control']],
  ['Alexa.TemperatureSensor', ['temperature-sensor']],
  ['Alexa.HumiditySensor', ['humidity-sensor']],
  ['Alexa.ContactSensor', ['contact']],
  ['Alexa.MotionSensor', ['motion']],
  ['Alexa.RangeController', ['control']],
  ['Alexa.PercentageController', ['cover']],
  ['Alexa.ModeController', ['control']],
  ['Alexa.ToggleController', ['switch']],
  ['Alexa.SceneController', ['button']],
])

/** Stable cap order so a derived child's cap list is deterministic. */
const CAP_ORDER: readonly AlexaCap[] = [
  'switch',
  'brightness',
  'color',
  'lock-control',
  'climate-control',
  'cover',
  'control',
  'temperature-sensor',
  'humidity-sensor',
  'contact',
  'motion',
  'button',
  'numeric-sensor',
]

export interface AlexaApplianceMapping {
  /** The CamStack device type the appliance materialises as. */
  readonly deviceType: DeviceType
  /** The caps the appliance child registers (deterministic order). */
  readonly capabilities: readonly AlexaCap[]
}

/**
 * Reduce an Alexa appliance's reported capability interfaces to its CamStack
 * device type + caps. Pure + total: an appliance with no recognised interface
 * maps to a Generic device with no caps (the adoption layer skips empty ones).
 */
export function mapAlexaCapabilitiesToCamStack(
  interfaceNames: readonly string[],
): AlexaApplianceMapping {
  const caps = new Set<AlexaCap>()
  for (const name of interfaceNames) {
    const contributed = INTERFACE_TO_CAPS.get(name)
    if (contributed === undefined) continue
    for (const cap of contributed) caps.add(cap)
  }
  const ordered = CAP_ORDER.filter((c) => caps.has(c))
  return {
    deviceType: deviceTypeForCaps(ordered),
    capabilities: ordered,
  }
}

/** Pick the most-specific CamStack device type for a cap set. */
function deviceTypeForCaps(caps: readonly AlexaCap[]): DeviceType {
  if (caps.includes('lock-control')) return DeviceType.Lock
  if (caps.includes('cover')) return DeviceType.Cover
  if (caps.includes('climate-control')) return DeviceType.Thermostat
  if (caps.includes('color') || caps.includes('brightness')) return DeviceType.Light
  if (caps.includes('switch')) return DeviceType.Switch
  if (caps.includes('button')) return DeviceType.Button
  if (caps.includes('control')) return DeviceType.Control
  if (
    caps.includes('temperature-sensor') ||
    caps.includes('humidity-sensor') ||
    caps.includes('contact') ||
    caps.includes('motion')
  ) {
    return DeviceType.Sensor
  }
  return DeviceType.Generic
}
