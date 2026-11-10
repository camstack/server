/**
 * The words that name a capability, in ONE place.
 *
 * A cap definition carries no label, so every surface that names a capability
 * ("No device provides Temperature") asks here: the admin catalogue key
 * `uiLibrary.capability.<name>` when the host has one, else the name made
 * readable (`temperature-sensor` -> "Temperature sensor"). No per-capability
 * message exists anywhere: a new cap needs no UI work to be named.
 *
 * Framework-free (a type import only) so the viewer can copy it.
 */
import type { UiTextFn } from '../contexts/ui-text'

/** `temperature-sensor`, `temperature_sensor`, `temperatureSensor` -> "Temperature sensor". */
export function humanizeIdentifier(capName: string): string {
  const words = capName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.:]+/g, ' ')
    .trim()
    .toLowerCase()
  if (words === '') return capName
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The label for a capability: the catalogue's word when it has one, else the humanized name. */
export function capabilityLabel(capName: string, t?: UiTextFn): string {
  const fallback = humanizeIdentifier(capName)
  return t === undefined ? fallback : t(`uiLibrary.capability.${capName}`, fallback)
}

/** "A", "A or B", "A, B or C" — the capabilities a field asks for, in one phrase. */
export function capabilityListLabel(
  capNames: readonly string[],
  t?: UiTextFn,
  or: string = 'or',
): string {
  const labels = capNames.map((c) => capabilityLabel(c, t))
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} ${or} ${labels[labels.length - 1]}`
}
