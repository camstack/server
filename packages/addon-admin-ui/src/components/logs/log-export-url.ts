/**
 * The Logs page export (#570): the query string of `GET /api/logs/export`
 * (the caller puts it after `hubPath('/api/logs/export')`).
 *
 * The hub owns the defaults — no `since` means the last six hours — so the
 * dialog's "6 hours" choice is the same as sending nothing; the other ranges
 * send `since` only. Lists are comma-separated, as the route reads them.
 */
export const LOG_EXPORT_RANGES_HOURS = [1, 6, 24, 72, 168] as const
export type LogExportRangeHours = (typeof LOG_EXPORT_RANGES_HOURS)[number]
export const LOG_EXPORT_DEFAULT_RANGE_HOURS: LogExportRangeHours = 6

export interface LogExportSelection {
  readonly components: readonly string[]
  readonly deviceIds: readonly number[]
  readonly rangeHours: LogExportRangeHours
}

export function isLogExportRange(value: number): value is LogExportRangeHours {
  return LOG_EXPORT_RANGES_HOURS.some((h) => h === value)
}

export function logExportQuery(selection: LogExportSelection, now: number): string {
  const params = new URLSearchParams()
  if (selection.components.length > 0) params.set('components', selection.components.join(','))
  if (selection.deviceIds.length > 0) params.set('deviceIds', selection.deviceIds.join(','))
  if (selection.rangeHours !== LOG_EXPORT_DEFAULT_RANGE_HOURS) {
    params.set('since', String(now - selection.rangeHours * 3_600_000))
  }
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

export function logExportFileName(now: number): string {
  return `camstack-logs-${new Date(now).toISOString().replace(/[:.]/g, '-')}.ndjson`
}
