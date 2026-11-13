/**
 * A CCU name on a device or channel (`name: string | null` in nodehomematic).
 * A blank name is "no name", the same as `null` — never the address.
 */
export function hmName(raw: string | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
