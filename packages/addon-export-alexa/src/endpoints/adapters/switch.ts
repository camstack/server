import { BrightnessStatusSchema, DeviceRole, SwitchStatusSchema } from '@camstack/types'
import { handleSetBrightness } from '../../handlers/brightness-controller.js'
import { handlePower } from '../../handlers/power-controller.js'
import { iface, plainNumber } from './shared.js'
import type { AlexaDisplayCategory } from '../types.js'
import type { AdapterDevice, AdapterDirective, GenericAdapter, GenericProperty } from './types.js'

/** A dimmer ramp reports its final level, once things have been quiet for this long. */
export const BRIGHTNESS_DEBOUNCE_MS = 1000

const POWER_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.PowerController/TurnOn',
  'Alexa.PowerController/TurnOff',
].map((key) => ({
  key,
  needsReachableDevice: true,
  handle: (c) => handlePower(c.header, c.endpoint, c.deps.powerController, c.identity),
}))

const BRIGHTNESS_DIRECTIVE: AdapterDirective = {
  key: 'Alexa.BrightnessController/SetBrightness',
  needsReachableDevice: true,
  handle: (c) =>
    handleSetBrightness(c.header, c.endpoint, c.payload, c.deps.brightnessController, c.identity),
}

/** An outlet (D875: its source says so, e.g. HA `device_class: outlet`) is a
 *  smart plug; every other switch is a SWITCH. */
function switchCategory(device: AdapterDevice): AlexaDisplayCategory {
  return device.role === DeviceRole.Outlet ? 'SMARTPLUG' : 'SWITCH'
}

/**
 * `switch` → `Alexa.PowerController` (SWITCH, LIGHT when it dims or the device
 * IS a light); with the `brightness` cap bound, `Alexa.BrightnessController`.
 */
export const switchAdapter: GenericAdapter = {
  cap: 'switch',
  stateCaps: ['switch', 'brightness'],
  discoveryReads: [],
  describe: (device) => {
    const dimmable = device.capNames.includes('brightness')
    return {
      kind: 'publish',
      capabilities: [
        iface('Alexa.PowerController', 'powerState'),
        ...(dimmable ? [iface('Alexa.BrightnessController', 'brightness')] : []),
      ],
      category: dimmable || device.type === 'light' ? 'LIGHT' : switchCategory(device),
    }
  },
  properties: (capName, slice): readonly GenericProperty[] => {
    if (capName === 'brightness') {
      const p = BrightnessStatusSchema.pick({ level: true }).safeParse(slice)
      return p.success
        ? [
            {
              namespace: 'Alexa.BrightnessController',
              name: 'brightness',
              value: Math.max(0, Math.min(100, Math.round(p.data.level))),
            },
          ]
        : []
    }
    const p = SwitchStatusSchema.pick({ on: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.PowerController',
            name: 'powerState',
            value: p.data.on ? 'ON' : 'OFF',
          },
        ]
      : []
  },
  directives: [...POWER_DIRECTIVES, BRIGHTNESS_DIRECTIVE],
  shaping: (property) =>
    property.name === 'brightness'
      ? { deadband: 1, debounceMs: BRIGHTNESS_DEBOUNCE_MS, numericOf: plainNumber }
      : null,
}
