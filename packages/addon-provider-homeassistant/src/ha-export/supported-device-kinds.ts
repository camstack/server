/**
 * Device types the Home Assistant export picker offers.
 *
 * A UI filter. What actually travels is still the entity catalog: a washer,
 * dryer or dishwasher is offered because its power reading exports as a
 * sensor. running-state stays unmapped.
 */
import { PLUG_APPLIANCE_TYPES } from '@camstack/types'

export const SUPPORTED_DEVICE_KINDS: readonly string[] = [
  'camera',
  'light',
  'siren',
  'switch',
  'sensor',
  'thermostat',
  'climate',
  'button',
  'event-emitter',
  'update',
  'generic',
  'lock',
  'cover',
  'valve',
  'humidifier',
  'water-heater',
  'fan',
  'media-player',
  'alarm-panel',
  'control',
  'presence',
  'weather',
  'vacuum',
  'lawn-mower',
  'container',
  'image',
  'pet-feeder',
  'hub',
  ...PLUG_APPLIANCE_TYPES,
]
