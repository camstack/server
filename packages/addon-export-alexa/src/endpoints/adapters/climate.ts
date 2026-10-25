import { handleClimateDirective, handlesPower } from '../../handlers/climate-controller.js'
import { climateProperties, describeClimate, INSTANCE_FAN, INSTANCE_MODE } from './climate-model.js'
import { numericValueField } from './shared.js'
import { SENSOR_MIN_INTERVAL_MS, TEMPERATURE_DEADBAND_CELSIUS } from './temperature.js'
import type { AdapterDirective, GenericAdapter } from './types.js'

const OWN_INSTANCES: ReadonlySet<string> = new Set([INSTANCE_MODE, INSTANCE_FAN])

const THERMOSTAT_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.ThermostatController/SetTargetTemperature',
  'Alexa.ThermostatController/AdjustTargetTemperature',
  'Alexa.ThermostatController/SetThermostatMode',
].map((key) => ({ key, needsReachableDevice: true, handle: handleClimateDirective }))

const POWER_DIRECTIVES: readonly AdapterDirective[] = [
  'Alexa.PowerController/TurnOn',
  'Alexa.PowerController/TurnOff',
].map((key) => ({
  key,
  needsReachableDevice: true,
  handle: handleClimateDirective,
  claims: handlesPower,
}))

const MODE_DIRECTIVE: AdapterDirective = {
  key: 'Alexa.ModeController/SetMode',
  needsReachableDevice: true,
  handle: handleClimateDirective,
  claims: async (c) => c.header.instance !== undefined && OWN_INSTANCES.has(c.header.instance),
}

/**
 * `climate-control` -> a thermostat (Home Assistant) or an air conditioner
 * (Gree) (D874): `Alexa.ThermostatController` 3.1 with the current temperature,
 * power, and the modes Amazon's vocabulary lacks and the fan mode as
 * ModeControllers. The current temperature is shaped like any temperature
 * sensor; setpoints, mode and fan report on every change.
 */
export const climateAdapter: GenericAdapter = {
  cap: 'climate-control',
  stateCaps: ['climate-control'],
  discoveryReads: ['climate-control'],
  describe: describeClimate,
  properties: (_cap, slice) => climateProperties(slice),
  directives: [...THERMOSTAT_DIRECTIVES, ...POWER_DIRECTIVES, MODE_DIRECTIVE],
  shaping: (property) =>
    property.namespace === 'Alexa.TemperatureSensor'
      ? {
          deadband: TEMPERATURE_DEADBAND_CELSIUS,
          minIntervalMs: SENSOR_MIN_INTERVAL_MS,
          numericOf: numericValueField,
        }
      : null,
}
