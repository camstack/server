/**
 * `logs.query` — one page of history from the source the operator picked,
 * merged with the hub's in-memory tail (D898).
 *
 * The tail is short (a couple of thousand lines) and exists for two things:
 * the boot replay into destinations that register late, and the lines a file
 * destination has accepted but not yet flushed. Everything older comes from
 * the source. Both carry the same `id`, so the merge dedupes exactly.
 */
import {
  compileLogFilter,
  lineMatches,
  type CompiledLogFilter,
  type ReadableLine,
} from '@camstack/system'
import type {
  ILogDestination,
  LogEntry,
  LogReadEntry,
  LogReadQuery,
  LogReadResult,
} from '@camstack/types'

/** The default history source: the hub's rotated files. */
export const DEFAULT_LOG_SOURCE = 'winston-logging'
/** The in-memory tail, addressed as a source when no destination can read. */
export const RING_LOG_SOURCE = 'ring'

export const DEFAULT_PAGE_LIMIT = 200

export interface LogHistoryPage extends LogReadResult {
  /** The source that answered — `ring` when the requested one could not. */
  readonly source: string
}

function toReadable(entry: LogEntry): ReadableLine {
  return {
    timestamp: entryTime(entry),
    level: entry.level,
    message: entry.message,
    scope: entry.scope,
    tags: entry.tags,
    meta: entry.meta,
  }
}

function entryTime(entry: LogEntry): number {
  const ts: unknown = entry.timestamp
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') return Date.parse(ts)
  return 0
}

function toReadEntry(entry: LogEntry): LogReadEntry {
  const tags: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(entry.tags ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') tags[key] = value
  }
  const level = entry.level
  return {
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    timestamp: entryTime(entry),
    level,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    message: entry.message,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  }
}

function tailMatching(
  tail: readonly LogEntry[],
  filter: CompiledLogFilter,
  limit: number,
): LogReadEntry[] {
  const out: LogReadEntry[] = []
  for (const entry of tail) {
    if (!lineMatches(toReadable(entry), filter)) continue
    out.push(toReadEntry(entry))
    if (out.length >= limit) break
  }
  return out
}

function entryKey(entry: LogReadEntry): string {
  return (
    entry.id ?? `${String(entry.timestamp)}|${entry.level}|${entry.scope ?? ''}|${entry.message}`
  )
}

/**
 * The first page (no cursor) merges the tail; a cursor page is the source's
 * alone — the tail only ever holds the NEWEST lines, which the first page
 * already showed.
 */
export async function readLogHistory(args: {
  readonly query: LogReadQuery
  readonly source: string
  /** Newest-first, as `LogManager.query` returns it. */
  readonly tail: readonly LogEntry[]
  readonly provider: ILogDestination | null
}): Promise<LogHistoryPage> {
  const { query, tail, provider } = args
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  const filter = compileLogFilter(query)
  const isFirstPage = query.before === undefined && query.after === undefined

  if (provider === null || provider.read === undefined) {
    if (!isFirstPage) {
      return {
        entries: [],
        nextBefore: null,
        nextAfter: null,
        scannedBytes: 0,
        done: true,
        source: RING_LOG_SOURCE,
      }
    }
    return {
      entries: tailMatching(tail, filter, limit),
      nextBefore: null,
      nextAfter: null,
      scannedBytes: 0,
      done: true,
      source: RING_LOG_SOURCE,
    }
  }

  const page = await provider.read({ ...query, limit })
  if (!isFirstPage) return { ...page, source: args.source }

  // Tail lines newer than the oldest line the source returned (or all of them
  // when the source returned nothing yet): the unflushed lines, and the levels
  // the file destination does not keep.
  const oldest = page.entries.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY
  const byKey = new Map<string, LogReadEntry>()
  for (const entry of page.entries) byKey.set(entryKey(entry), entry)
  for (const entry of tailMatching(tail, filter, limit)) {
    if (entry.timestamp < oldest) continue
    if (!byKey.has(entryKey(entry))) byKey.set(entryKey(entry), entry)
  }
  const entries = [...byKey.values()].toSorted((a, b) => b.timestamp - a.timestamp)
  return { ...page, entries, source: args.source }
}
