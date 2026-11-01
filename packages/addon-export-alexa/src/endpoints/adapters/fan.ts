import { type AddonApi, type FanPreset } from '@camstack/types'
import { handleFanDirective } from '../../handlers/fan-controller.js'
import {
  describeFan,
  fanProperties,
  CUSTOM_PRESETS_KEY,
  INSTANCE_OSCILLATING,
  INSTANCE_PRESET,
  INSTANCE_SPEED,
} from './fan-model.js'
import { iface, plainNumber } from './shared.js'
import type { AdapterDevice, AdapterDirective, GenericAdapter } from './types.js'

/** A speed slider drag reports its final level, once things have been quiet this long. */
export const FAN_SPEED_DEBOUNCE_MS = 1000

function claimsInstance(instance: string): AdapterDirective['claims'] {
  return async (c) => c.header.instance === instance
}

const SPEED_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.RangeController/SetRangeValue',
  'Alexa.RangeController/AdjustRangeValue',
].map((key) => ({
  key,
  needsReachableDevice: true,
  handle: handleFanDirective,
  claims: claimsInstance(INSTANCE_SPEED),
}))

const OSCILLATION_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.ToggleController/TurnOn',
  'Alexa.ToggleController/TurnOff',
].map((key) => ({
  key,
  needsReachableDevice: true,
  handle: handleFanDirective,
  claims: claimsInstance(INSTANCE_OSCILLATING),
}))

const PRESET_DIRECTIVE: AdapterDirective = {
  key: 'Alexa.ModeController/SetMode',
  needsReachableDevice: true,
  handle: handleFanDirective,
  claims: claimsInstance(INSTANCE_PRESET),
}

async function customPresets(
  api: AddonApi,
  deviceId: number,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const presets: readonly FanPreset[] = await api.fanPresets.getPresets.query({ deviceId })
    return { [CUSTOM_PRESETS_KEY]: presets.map((p) => ({ name: p.name })) }
  } catch {
    // No `fan-presets` provider (an older hub) or a failed read: the fan's own modes only.
    return {}
  }
}

/**
 * `fan-control` → a FAN: `Alexa.PowerController` (the fan's `switch`), speed as
 * an `Alexa.RangeController`, oscillation as an `Alexa.ToggleController`, and
 * its presets — the device's own and the operator's custom ones — as one
 * `Alexa.ModeController`. Registered before `switch`, so the endpoint is a FAN
 * and not a SWITCH.
 */
export const fanAdapter: GenericAdapter = {
  cap: 'fan-control',
  stateCaps: ['fan-control'],
  discoveryReads: ['fan-control'],
  discoveryExtras: customPresets,
  describe: (device: AdapterDevice) => {
    const description = describeFan(device)
    if (description.kind === 'skip') return description
    return {
      ...description,
      capabilities: [iface('Alexa.PowerController', 'powerState'), ...description.capabilities],
    }
  },
  properties: (_cap, slice) => fanProperties(slice),
  directives: [...SPEED_DIRECTIVES, ...OSCILLATION_DIRECTIVES, PRESET_DIRECTIVE],
  shaping: (property) =>
    property.namespace === 'Alexa.RangeController'
      ? {
          deadband: 1,
          debounceMs: FAN_SPEED_DEBOUNCE_MS,
          numericOf: plainNumber,
        }
      : null,
}
