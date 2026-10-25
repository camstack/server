/** Shared by `check-actuation-not-admin.ts` (D403) and `check-method-roles.ts` (D921). */

/**
 * Caps whose every method is a device ACTUATION — the accessory-control
 * surface an operator with a `create` device grant is meant to drive.
 *
 * Not here on purpose: `update` (installing firmware), `intercom` (opening a
 * live audio channel into the house), `ptz`, `reboot` and every settings /
 * credential / zone cap. Those stay admin.
 */
export const ACTUATION_CAPS: readonly string[] = [
  'alarm-panel',
  'brightness',
  'button',
  'climate-control',
  'color',
  'control',
  'cover',
  'fan-control',
  'humidifier',
  'lawn-mower-control',
  'lock-control',
  'media-player',
  'motion-trigger',
  'pet-feeder',
  'switch',
  'vacuum-control',
  'valve',
  'water-heater',
]
