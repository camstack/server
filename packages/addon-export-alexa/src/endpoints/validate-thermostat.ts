/**
 * Amazon's rules for `Alexa.ThermostatController` 3.1 (D874): alexa-thermostatcontroller.
 *
 * Properties are `targetSetpoint`, `lowerSetpoint` + `upperSetpoint` (a range
 * travels as a pair) and `thermostatMode`; `configuration.supportedModes` lists
 * the modes the thermostat accepts, each one Amazon documents. A violation here
 * makes Alexa reject the endpoint (and the report carrying it).
 */
import type { AlexaCapability } from './types.js'

const PROPERTIES = new Set(['targetSetpoint', 'lowerSetpoint', 'upperSetpoint', 'thermostatMode'])
const MODES = new Set(['AUTO', 'COOL', 'HEAT', 'ECO', 'OFF'])

type Push = (rule: string) => void

export function validateThermostat(c: AlexaCapability, push: Push): void {
  const supported = new Set((c.properties?.supported ?? []).map((p) => p.name))
  for (const name of supported) {
    if (!PROPERTIES.has(name)) push(`properties.supported ${name} is not a thermostat property`)
  }
  if (!supported.has('thermostatMode')) push('properties.supported must include thermostatMode')
  if (supported.has('lowerSetpoint') !== supported.has('upperSetpoint')) {
    push('lowerSetpoint and upperSetpoint are declared together')
  }
  if (!supported.has('targetSetpoint') && !supported.has('lowerSetpoint')) {
    push('at least one setpoint property is required')
  }
  const modes = c.configuration?.['supportedModes']
  if (!Array.isArray(modes) || modes.length === 0) {
    push('configuration.supportedModes must list at least one mode')
  } else {
    for (const mode of modes) {
      if (typeof mode !== 'string' || !MODES.has(mode)) {
        push(`supportedModes ${String(mode)} is not AUTO, COOL, HEAT, ECO or OFF`)
      }
    }
    if (new Set(modes).size !== modes.length) push('supportedModes values must be unique')
  }
  const scheduling = c.configuration?.['supportsScheduling']
  if (scheduling !== undefined && typeof scheduling !== 'boolean') {
    push('configuration.supportsScheduling must be a boolean')
  }
}
