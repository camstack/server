/**
 * A pre-D934 tank episode: `tank:<deviceId>:<key>`.
 *
 * Nothing writes these any more. They are closed when the same key is seen on
 * the consumables slice, or by the boot sweep (D934). Pure. No clock, no I/O.
 */

export interface NcTankSubjectParts {
  readonly deviceId: number
  readonly key: string
}

export function tankSubject(deviceId: number, key: string): string {
  return `tank:${String(deviceId)}:${key}`
}

/** `null` for a subject that is not a leftover tank episode. */
export function parseTankSubject(subject: string): NcTankSubjectParts | null {
  const first = subject.indexOf(':')
  const second = first < 0 ? -1 : subject.indexOf(':', first + 1)
  if (first < 0 || second < 0) return null
  if (subject.slice(0, first) !== 'tank') return null
  const deviceId = Number(subject.slice(first + 1, second))
  const key = subject.slice(second + 1)
  if (!Number.isInteger(deviceId) || key.length === 0) return null
  return { deviceId, key }
}
