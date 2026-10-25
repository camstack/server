/**
 * Operator-facing device label for alert messages.
 *
 * Prefer a real name; fall back to `Camera <id>` only when nothing else is
 * known. Never prefer the bare id when a name is present — "Camera 108"
 * next to a named "Kitchen" is how the Recording-stopped alerts used to read.
 */

export function deviceLabelFromEventData(data: Readonly<Record<string, unknown>>): string {
  const name = stringNonEmpty(data['name']) ?? stringNonEmpty(data['deviceName'])
  if (name !== undefined) return name
  const id = data['deviceId']
  if (typeof id === 'number' && Number.isFinite(id)) return `Camera ${String(id)}`
  if (typeof id === 'string' && id.length > 0) return `Camera ${id}`
  return 'unknown device'
}

function stringNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
