/**
 * PTZ HomeKit switch labels — kept PURE (no hap-nodejs / SDK deps) so the
 * naming convention is unit-testable in isolation.
 *
 * Each label is a BARE, HAP-valid action string: no em-dash, no camera-name
 * prefix. `ptz.ts` qualifies it with the camera through `ptzServiceName` and
 * publishes the result via `applyServiceLabel`. The em-dash (U+2014) that a
 * previous `${displayName} — <action>` form embedded is outside Apple's
 * permitted set and made hap-nodejs' `checkName` warn, so it must never come
 * back into a label here.
 */

export interface PtzDirection {
  readonly label: string
  readonly subtype: string
  readonly cmd: { readonly pan?: number; readonly tilt?: number }
}

/** Momentary directional pad — one HomeKit switch per entry. */
export const PTZ_DIRECTIONS: readonly PtzDirection[] = [
  { label: 'Pan Left', subtype: 'ptz-pan-left', cmd: { pan: -1 } },
  { label: 'Pan Right', subtype: 'ptz-pan-right', cmd: { pan: 1 } },
  { label: 'Tilt Up', subtype: 'ptz-tilt-up', cmd: { tilt: 1 } },
  { label: 'Tilt Down', subtype: 'ptz-tilt-down', cmd: { tilt: -1 } },
]

/** Stateful autotrack toggle label. */
export const PTZ_AUTOTRACK_LABEL = 'Autotrack'

/** Per-preset switch label, e.g. `ptzPresetLabel('stanza') === 'Preset stanza'`. */
export function ptzPresetLabel(presetName: string): string {
  return `Preset ${presetName}`
}
