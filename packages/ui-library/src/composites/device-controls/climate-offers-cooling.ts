import type { HvacMode } from '@camstack/types'

/** Modes that mean the device can cool, dry, or move air — an air conditioner. */
const COOLING_MODES: ReadonlySet<HvacMode> = new Set(['cool', 'heat_cool', 'dry', 'fan_only'])

/**
 * A heater offers heat (and maybe auto/off) and none of the cooling modes. The
 * one test of "can this device cool": the AC panel and the climate card both
 * ask it, so a heat-only thermostat is never drawn as cooling.
 */
export function climateOffersCooling(modes: readonly HvacMode[]): boolean {
  return modes.some((mode) => COOLING_MODES.has(mode))
}
