import { HumiditySensorStatusSchema } from '@camstack/types'
import { iface, numericValueField } from './shared.js'
import { SENSOR_MIN_INTERVAL_MS } from './temperature.js'
import type { GenericAdapter } from './types.js'

/** A humidity change under two points is not worth a ChangeReport. */
export const HUMIDITY_DEADBAND_PERCENT = 2

/** `humidity-sensor` → `Alexa.HumiditySensor` (TEMPERATURE_SENSOR). */
export const humidityAdapter: GenericAdapter = {
  cap: 'humidity-sensor',
  stateCaps: ['humidity-sensor'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.HumiditySensor', 'relativeHumidity')],
    category: 'TEMPERATURE_SENSOR',
  }),
  properties: (_cap, slice) => {
    const p = HumiditySensorStatusSchema.pick({ humidity: true }).safeParse(slice)
    // A refused sample is null (D944 §4, D393). Publishing 0 would be a dry room.
    if (!p.success || p.data.humidity === null) return []
    return [
      {
        namespace: 'Alexa.HumiditySensor',
        name: 'relativeHumidity',
        value: { value: Math.max(0, Math.min(100, p.data.humidity)) },
      },
    ]
  },
  directives: [],
  shaping: () => ({
    deadband: HUMIDITY_DEADBAND_PERCENT,
    minIntervalMs: SENSOR_MIN_INTERVAL_MS,
    numericOf: numericValueField,
  }),
}
