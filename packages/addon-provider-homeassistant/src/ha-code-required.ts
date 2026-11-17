/**
 * Whether an HA lock / alarm panel needs a PIN — the `codeRequired` field of
 * its slice (#459). `null` = unknown (D393), never `false`.
 *
 * HA writes `code_format` differently per domain, so absence means different
 * things:
 *   - `lock`: the attribute is emitted only when set, so absent = no code.
 *   - `alarm_control_panel`: the attribute is always emitted (`null` when no
 *     code), so absent = the attributes were not delivered = unknown.
 */
export function haLockCodeRequired(attributes: Readonly<Record<string, unknown>>): boolean {
  return hasCodeFormat(attributes)
}

export function haAlarmCodeRequired(attributes: Readonly<Record<string, unknown>>): boolean | null {
  if (!('code_format' in attributes)) return null
  return hasCodeFormat(attributes)
}

function hasCodeFormat(attributes: Readonly<Record<string, unknown>>): boolean {
  const format = attributes['code_format']
  return format !== undefined && format !== null
}
