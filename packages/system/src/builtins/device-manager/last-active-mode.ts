/**
 * The last mode a climate device actually RAN (D224): "turn on" needs a mode to
 * return to, and a device that reports `off` no longer says which. The mirror's
 * single write path calls this, so every provider's slice carries the field
 * without per-addon code, and a consumer never keeps a second copy.
 *
 * Pure: it only reads the slice being written and the one it replaces.
 */

/** The cap, and the slice field that names its mode. */
const MODE_FIELD_BY_CAP: Readonly<Record<string, string>> = {
  'climate-control': 'mode',
  'water-heater': 'operationMode',
}

const OFF = 'off'

export function carryLastActiveMode(
  capName: string,
  prior: Readonly<Record<string, unknown>> | undefined,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const modeField = MODE_FIELD_BY_CAP[capName]
  if (modeField === undefined) return { ...incoming }
  const mode = incoming[modeField]
  if (typeof mode === 'string' && mode !== OFF) return { ...incoming, lastActiveMode: mode }
  // Not running a mode now: keep what the slice (or the one it replaces) remembered.
  const remembered = incoming['lastActiveMode'] ?? prior?.['lastActiveMode']
  return remembered === undefined ? { ...incoming } : { ...incoming, lastActiveMode: remembered }
}
