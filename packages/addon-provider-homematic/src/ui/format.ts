/** A percentage the CCU reported, or an em dash when it did not (`null` is unknown, never 0). */
export function percentOrDash(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 10) / 10}%`
}

export function textOrDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : value
}

export function dateTimeOrDash(epochMs: number | null): string {
  return epochMs === null ? '—' : new Date(epochMs).toLocaleString()
}
