import { TemperatureSensorStatusSchema } from '@camstack/types'
import { iface, numericValueField } from './shared.js'
import type { GenericAdapter } from './types.js'

/** A temperature change under half a degree is not worth a ChangeReport. */
export const TEMPERATURE_DEADBAND_CELSIUS = 0.5
/** A numeric sensor reports at most once a minute per property (D869). */
export const SENSOR_MIN_INTERVAL_MS = 60_000

/** `temperature-sensor` → `Alexa.TemperatureSensor` (TEMPERATURE_SENSOR). */
export const temperatureAdapter: GenericAdapter = {
  cap: 'temperature-sensor',
  stateCaps: ['temperature-sensor'],
  discoveryReads: [],
  describe: () => ({
    kind: 'publish',
    capabilities: [iface('Alexa.TemperatureSensor', 'temperature')],
    category: 'TEMPERATURE_SENSOR',
  }),
  properties: (_cap, slice) => {
    const p = TemperatureSensorStatusSchema.pick({ celsius: true }).safeParse(slice)
    return p.success
      ? [
          {
            namespace: 'Alexa.TemperatureSensor',
            name: 'temperature',
            value: { value: Math.round(p.data.celsius * 10) / 10, scale: 'CELSIUS' },
          },
        ]
      : []
  },
  directives: [],
  shaping: () => ({
    deadband: TEMPERATURE_DEADBAND_CELSIUS,
    minIntervalMs: SENSOR_MIN_INTERVAL_MS,
    numericOf: numericValueField,
  }),
}
