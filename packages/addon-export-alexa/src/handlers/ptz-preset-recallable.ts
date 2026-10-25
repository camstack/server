/**
 * Which `ptz.getPresets` entries Alexa may recall by voice.
 *
 * On several firmwares the preset namespace is shared with camera FUNCTIONS —
 * the dispensa camera (1438) lists `94 Remote reboot`, `95 Call OSD menu`,
 * `39 Day mode`, … among its presets. Offered as `ptz.preset` modes, "Remote
 * reboot" became a voice command that reboots the camera.
 *
 * The signal is the cap's `fn` field, which a provider fills from the id band
 * it KNOWS is reserved — never the name (an operator may call their own
 * position "Day mode"), and never `writable` (ONVIF reports every preset
 * unwritable, and those are ordinary positions). `home` stays: it is a
 * destination, the one function worth recalling. The HomeKit export draws the
 * same line (`addon-export-hap` `mappers/builders/ptz.ts`).
 */
import type { PtzPresetFunction } from '@camstack/types'

const RECALLABLE_FUNCTIONS: ReadonlySet<PtzPresetFunction> = new Set<PtzPresetFunction>(['home'])

export function isAlexaRecallablePreset(preset: {
  readonly fn: PtzPresetFunction | null
}): boolean {
  return preset.fn === null || RECALLABLE_FUNCTIONS.has(preset.fn)
}
