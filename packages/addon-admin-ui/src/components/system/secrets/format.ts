const FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }

/** A timestamp as the Secrets page prints it — short, so a date never widens a column; `null` = never. */
export function formatWhen(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString(undefined, FORMAT)
}
