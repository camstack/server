/**
 * The authority badge a scalar card shows. The phrases come from
 * `projectScalarAssignment`; a known device name replaces the field key.
 */
export type ScalarBadge =
  | { readonly kind: 'native' }
  | { readonly kind: 'assigned'; readonly source: string }
  | { readonly kind: 'released' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }

const ASSIGNED_PREFIX = 'Assigned · '

export function scalarBadge(text: string, sourceName: string | null): ScalarBadge {
  if (text === 'Native') return { kind: 'native' }
  if (text === 'Native · source missing') return { kind: 'released' }
  if (text === 'pending') return { kind: 'pending' }
  if (text === 'unknown') return { kind: 'unknown' }
  if (text.startsWith(ASSIGNED_PREFIX)) {
    const suffix = text.slice(ASSIGNED_PREFIX.length)
    return { kind: 'assigned', source: sourceName ?? suffix }
  }
  return { kind: 'unknown' }
}
