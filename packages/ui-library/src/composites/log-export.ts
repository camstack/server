/**
 * The log export (#570): the query string of `GET /api/logs/export` and the
 * pure rules around it — what a stream's scope pre-fills, what a source can
 * reach back, and how a time range is held to that reach.
 *
 * The hub owns the defaults — no `since` means the last six hours — so the
 * "6 hours" choice is the same as sending nothing; the other ranges send
 * `since` only. Lists are comma-separated, as the route reads them.
 */
export const LOG_EXPORT_RANGES_HOURS = [1, 6, 24, 72, 168] as const
export type LogExportRangeHours = (typeof LOG_EXPORT_RANGES_HOURS)[number]
export const LOG_EXPORT_DEFAULT_RANGE_HOURS: LogExportRangeHours = 6
const HOURS_PER_DAY = 24
const MS_PER_HOUR = 3_600_000

export interface LogExportSelection {
  readonly components: readonly string[]
  readonly deviceIds: readonly number[]
  readonly rangeHours: LogExportRangeHours
  /** A readable `log-destination` addon id; absent = the hub's default. */
  readonly source?: string | undefined
}

export function isLogExportRange(value: number): value is LogExportRangeHours {
  return LOG_EXPORT_RANGES_HOURS.some((h) => h === value)
}

export function logExportQuery(selection: LogExportSelection, now: number): string {
  const params = new URLSearchParams()
  if (selection.components.length > 0) params.set('components', selection.components.join(','))
  if (selection.deviceIds.length > 0) params.set('deviceIds', selection.deviceIds.join(','))
  if (selection.rangeHours !== LOG_EXPORT_DEFAULT_RANGE_HOURS) {
    params.set('since', String(now - selection.rangeHours * MS_PER_HOUR))
  }
  if (selection.source !== undefined && selection.source !== '') {
    params.set('source', selection.source)
  }
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ''
}

export function logExportFileName(now: number): string {
  return `camstack-logs-${new Date(now).toISOString().replace(/[:.]/g, '-')}.ndjson`
}

/** What a `LogStream` is looking at, as the export dialog's starting point. */
export interface LogExportScopeInput {
  readonly addonId?: string | undefined
  readonly deviceId?: number | undefined
  /** A container's subtree view: the container is the export's device. */
  readonly containerDeviceId?: number | undefined
  /** The history source the stream is reading. */
  readonly source?: string | undefined
}

export interface LogExportScope {
  readonly components: readonly string[]
  readonly deviceIds: readonly number[]
  readonly source: string | undefined
}

/** The stream's lock becomes the export's filters; an open level exports everything. */
export function logExportScopeOf(input: LogExportScopeInput): LogExportScope {
  const device = input.containerDeviceId ?? input.deviceId
  return {
    components: input.addonId !== undefined && input.addonId !== '' ? [input.addonId] : [],
    deviceIds: device !== undefined && Number.isFinite(device) ? [device] : [],
    source: input.source,
  }
}

/** One entry of `logs.sources`, narrowed to what the dialog reads. */
export interface LogSourceReach {
  readonly addonId: string
  readonly readable: boolean
  readonly reason: string | null
  readonly isDefault: boolean
  /** Days the store reaches back; null = the provider does not know (never 0). */
  readonly retentionDays: number | null
}

export type SourceReach =
  | { readonly kind: 'unreadable'; readonly reason: string | null }
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'unknown' }

export function sourceReach(source: LogSourceReach): SourceReach {
  if (!source.readable) return { kind: 'unreadable', reason: source.reason }
  return source.retentionDays === null
    ? { kind: 'unknown' }
    : { kind: 'days', days: source.retentionDays }
}

/** The longest range, in hours, the source can answer; null when it is unknown. */
export function reachLimitHours(retentionDays: number | null): number | null {
  return retentionDays === null ? null : retentionDays * HOURS_PER_DAY
}

export function rangeExceedsReach(
  rangeHours: LogExportRangeHours,
  retentionDays: number | null,
): boolean {
  const limit = reachLimitHours(retentionDays)
  return limit !== null && rangeHours > limit
}

/** The offered ranges a source can fully answer. Unknown reach offers all of them. */
export function rangesWithinReach(retentionDays: number | null): readonly LogExportRangeHours[] {
  const within = LOG_EXPORT_RANGES_HOURS.filter((h) => !rangeExceedsReach(h, retentionDays))
  return within.length > 0 ? within : [LOG_EXPORT_RANGES_HOURS[0]]
}

/** The chosen range, brought down to the longest offered one the source reaches. */
export function clampRangeToReach(
  rangeHours: LogExportRangeHours,
  retentionDays: number | null,
): LogExportRangeHours {
  if (!rangeExceedsReach(rangeHours, retentionDays)) return rangeHours
  return rangesWithinReach(retentionDays).at(-1) ?? LOG_EXPORT_DEFAULT_RANGE_HOURS
}

/** The source the dialog starts on: the stream's, when readable, else the default readable one. */
export function initialExportSource(
  wanted: string | undefined,
  sources: readonly LogSourceReach[],
): string | undefined {
  const readable = sources.filter((s) => s.readable)
  if (wanted !== undefined && readable.some((s) => s.addonId === wanted)) return wanted
  return (readable.find((s) => s.isDefault) ?? readable[0])?.addonId
}
