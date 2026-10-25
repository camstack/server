/**
 * Hikvision's reserved preset band.
 *
 * The preset namespace is shared: low ids are stored positions, a reserved
 * band triggers camera FUNCTIONS. The camera returns the whole band in
 * `listPtzPresets` with firmware-supplied names, so the operator sees them in
 * the picker looking exactly like their own presets. Measured on the dispensa
 * camera (device 1438) on 2026-09-17:
 *
 *    1 Credenza · 2 Porta · 3 Stanza        <- the operator's
 *   34 Back to origin · 39 Day mode · 40 Night mode · 46 Day/Night Auto Mode
 *   92 Set manual limits · 93 Save manual limits · 94 Remote reboot
 *   95 Call OSD menu                        <- the firmware's
 *
 * Handing 34 to `savePreset` produced `PUT /ISAPI/PTZCtrl/channels/1/presets/34
 * -> HTTP 500`: the camera refusing to let "Back to origin" be overwritten,
 * which reached the operator as a transport failure with no hint of the cause.
 *
 * This table gates WRITES only. A function preset stays a perfectly good
 * DESTINATION -- `goToPreset('34')` is how this camera goes home, and it is
 * where `getHomePreset` gets its `firmware` answer.
 *
 * The band is matched by ID, never by name: an operator may legitimately name
 * their own preset "Day mode", and a name match would make their slot
 * unwritable.
 */
import type { PtzPresetFunction } from '@camstack/types'

const RESERVED: ReadonlyMap<string, PtzPresetFunction> = new Map([
  ['34', 'home'],
  ['39', 'day-mode'],
  ['40', 'night-mode'],
  ['46', 'day-night-auto'],
  ['92', 'set-limits'],
  ['93', 'save-limits'],
  ['94', 'reboot'],
  ['95', 'osd-menu'],
])

/** The firmware function this id performs, or `null` for a stored position. */
export function presetFunctionFor(presetId: string): PtzPresetFunction | null {
  return RESERVED.get(presetId) ?? null
}

/**
 * Whether `savePreset` / `deletePreset` may target this id.
 *
 * Anything outside the known band stays writable: an undocumented firmware
 * must be allowed to refuse for itself rather than be guessed at here.
 */
export function isPresetWritable(presetId: string): boolean {
  return !RESERVED.has(presetId)
}

/**
 * Refuse a write to a reserved id, naming the function that owns it.
 *
 * Extracted so the REFUSAL itself is assertable. With the check inline in
 * `savePreset` / `deletePreset`, deleting it left every test green -- the table
 * spec proves what the band IS, not that anything consults it.
 */
export function assertPresetWritable(presetId: string, action: 'overwritten' | 'deleted'): void {
  const fn = presetFunctionFor(presetId)
  if (fn === null) return
  throw new Error(
    `Preset ${presetId} is a firmware function on this camera (${fn}) and cannot be ${action}` +
      (action === 'overwritten' ? ' — pick an unreserved id' : ''),
  )
}
