/**
 * Reading history back from Loki (D898): `GET /loki/api/v1/query_range`,
 * newest first.
 *
 * The label selector narrows by what IS a label (`job`, `node`, `level` —
 * see `loki-payload.ts` for why nothing else is); line filters (`|=`, `|~`)
 * narrow by device, addon and text on the JSON body; the shared
 * `lineMatches` then decides exactly, so a line filter only has to be a
 * superset.
 *
 * The cursor is the nanosecond timestamp of the oldest line returned plus a
 * short hash of each line returned AT that nanosecond: entries share
 * timestamps (they are millisecond-precise), so "older than t" would drop the
 * siblings a page cut through, and "t or older" would repeat them. The next
 * page asks for `end = t + 1` (Loki's end is exclusive) and skips the hashes.
 */
import { z } from 'zod'
import type { LogLevel, LogReadEntry, LogReadQuery, LogReadResult } from '@camstack/types'
import { compileLogFilter, lineMatches, type ReadableLine } from '../../logging/log-read-filter.js'

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
/** How far back a read may go when the query sets no `since`. */
export const LOKI_READ_HORIZON_DAYS = 30
/** One query_range window. A busy stream fills `limit` long before this. */
export const LOKI_WINDOW_MS: number = 6 * 60 * 60 * 1000
const MS_NS = 1_000_000n

const CURSOR_PREFIX = 'l1.'
/** Where a Loki page stopped. */
export interface LokiCursor {
  /** Nanosecond epoch, decimal string. */
  readonly n: string
  /** Hashes of the lines already returned at exactly `n`. */
  readonly h: string[]
}

const LokiCursorSchema: z.ZodType<LokiCursor> = z.object({
  /** Nanosecond epoch, decimal string. */
  n: z.string().regex(/^\d{1,22}$/),
  /** Hashes of the lines already returned at exactly `n`. */
  h: z.array(z.string().max(16)).max(1000),
})

export function encodeLokiCursor(cursor: LokiCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

export function decodeLokiCursor(raw: string): LokiCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX)) return null
  try {
    const parsed = LokiCursorSchema.safeParse(
      JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** FNV-1a, 32 bit, hex — a dedupe key, not a security property. */
export function lineHash(line: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < line.length; i += 1) {
    h ^= line.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** A LogQL double-quoted string literal. */
function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[\\.+*?()|[\]{}^$]/g, (c) => `\\${c}`)
}

export interface LokiQueryLabels {
  readonly job: string
}

/** The LogQL for a read. Pure. */
export function buildLogQl(query: LogReadQuery, labels: LokiQueryLabels): string {
  const selectors = [`job=${quote(labels.job)}`]
  if (query.fromNodeId !== undefined) selectors.push(`node=${quote(query.fromNodeId)}`)
  if (query.level !== undefined && query.level !== 'debug') {
    const floor = LEVELS.indexOf(query.level)
    selectors.push(`level=~${quote(LEVELS.slice(floor).join('|'))}`)
  }
  let logql = `{${selectors.join(',')}}`
  if (query.deviceId !== undefined) logql += ` |= ${quote(`"deviceId":${String(query.deviceId)}`)}`
  if (query.fromAddonId !== undefined) {
    const bare = query.fromAddonId.split('@')[0] ?? query.fromAddonId
    logql += ` |= ${quote(`"addonId":"${bare}`)}`
  }
  const text = query.text?.trim()
  if (text !== undefined && text.length > 0) logql += ` |~ ${quote(`(?i)${escapeRegex(text)}`)}`
  return logql
}

const LokiResponseSchema = z.object({
  data: z.object({
    result: z.array(
      z.object({
        stream: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.string(), z.string()])),
      }),
    ),
  }),
})

const LokiLineSchema = z.object({
  id: z.string().optional(),
  message: z.string(),
  scope: z.string().optional(),
  tags: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

export interface LokiRow {
  readonly ns: bigint
  readonly hash: string
  readonly entry: LogReadEntry
  readonly line: ReadableLine
}

function levelOf(label: string | undefined): LogLevel {
  return label === 'debug' || label === 'warn' || label === 'error' ? label : 'info'
}

/** A query_range body → rows, newest first. Lines that are not ours are dropped. */
export function parseQueryRange(body: unknown): LokiRow[] {
  const parsed = LokiResponseSchema.safeParse(body)
  if (!parsed.success) throw new Error('Loki answered with an unexpected query_range shape')
  const rows: LokiRow[] = []
  for (const stream of parsed.data.data.result) {
    const level = levelOf(stream.stream['level'])
    for (const [nsText, text] of stream.values) {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        continue
      }
      const line = LokiLineSchema.safeParse(json)
      if (!line.success) continue
      const ns = BigInt(nsText)
      const timestamp = Number(ns / MS_NS)
      const tags: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(line.data.tags ?? {})) {
        if (typeof v === 'string' || typeof v === 'number') tags[k] = v
      }
      const hasTags = Object.keys(tags).length > 0
      const entry: LogReadEntry = {
        ...(line.data.id !== undefined ? { id: line.data.id } : {}),
        timestamp,
        level,
        ...(line.data.scope !== undefined ? { scope: line.data.scope } : {}),
        message: line.data.message,
        ...(hasTags ? { tags } : {}),
        ...(line.data.meta !== undefined ? { meta: line.data.meta } : {}),
      }
      rows.push({
        ns,
        hash: lineHash(text),
        entry,
        line: {
          timestamp,
          level,
          message: line.data.message,
          scope: line.data.scope,
          tags: hasTags ? tags : undefined,
          meta: line.data.meta,
        },
      })
    }
  }
  return rows.toSorted((a, b) => (a.ns < b.ns ? 1 : a.ns > b.ns ? -1 : 0))
}

/** One query_range call: newest-first rows in [startNs, endNs). */
export type LokiRangeQuery = (args: {
  readonly logql: string
  readonly startNs: bigint
  readonly endNs: bigint
  readonly limit: number
}) => Promise<{ readonly rows: LokiRow[]; readonly bytes: number }>

/**
 * One backward slice over Loki: windows of {@link LOKI_WINDOW_MS}, newest
 * first, until `limit` matches, the horizon, the budget or a cancel.
 */
export async function readLokiBackward(args: {
  readonly query: LogReadQuery
  readonly labels: LokiQueryLabels
  readonly range: LokiRangeQuery
  readonly isCancelled: () => boolean
  readonly now?: () => number
}): Promise<LogReadResult> {
  const { query } = args
  const now = args.now ?? Date.now
  const filter = compileLogFilter(query)
  const limit = query.limit ?? 200
  const deadline = now() + Math.min(query.budgetMs ?? 2000, 10_000)
  const logql = buildLogQl(query, args.labels)
  const horizonMs = query.since ?? now() - LOKI_READ_HORIZON_DAYS * 86_400_000
  const horizonNs = BigInt(Math.trunc(horizonMs)) * MS_NS
  const cursor = query.before !== undefined ? decodeLokiCursor(query.before) : null
  const untilNs = query.until !== undefined ? BigInt(Math.trunc(query.until) + 1) * MS_NS : null
  // `end` is exclusive: +1 keeps the siblings at the cursor's nanosecond.
  let endNs = cursor !== null ? BigInt(cursor.n) + 1n : (untilNs ?? BigInt(now() + 1) * MS_NS)
  let seenAtBoundary = new Set(cursor?.h ?? [])
  let boundaryNs = cursor !== null ? BigInt(cursor.n) : null
  const entries: LogReadEntry[] = []
  let bytes = 0

  while (endNs > horizonNs) {
    if (args.isCancelled()) {
      return {
        entries,
        nextBefore: encodeLokiCursor({ n: String(endNs - 1n), h: [...seenAtBoundary] }),
        nextAfter: null,
        scannedBytes: bytes,
        done: false,
        cancelled: true,
      }
    }
    const windowStart = endNs - BigInt(LOKI_WINDOW_MS) * MS_NS
    const startNs = windowStart > horizonNs ? windowStart : horizonNs
    const want = limit - entries.length + seenAtBoundary.size
    const { rows, bytes: got } = await args.range({ logql, startNs, endNs, limit: want })
    bytes += got
    let oldest: bigint | null = null
    for (const row of rows) {
      if (boundaryNs !== null && row.ns === boundaryNs && seenAtBoundary.has(row.hash)) continue
      if (oldest === null || row.ns < oldest) {
        if (oldest !== null && row.ns < oldest) seenAtBoundary = new Set()
        oldest = row.ns
      }
      if (row.ns === oldest) seenAtBoundary.add(row.hash)
      boundaryNs = oldest
      if (!lineMatches(row.line, filter)) continue
      entries.push(row.entry)
      if (entries.length >= limit) {
        return {
          entries,
          nextBefore: encodeLokiCursor({ n: String(row.ns), h: [...seenAtBoundary] }),
          nextAfter: null,
          scannedBytes: bytes,
          done: false,
        }
      }
    }
    if (rows.length >= want && oldest !== null) {
      // The window was cut by the limit: resume inside it, at the oldest line.
      endNs = oldest + 1n
    } else {
      endNs = startNs
      seenAtBoundary = new Set()
      boundaryNs = null
    }
    if (now() >= deadline) break
  }
  const done = endNs <= horizonNs
  return {
    entries,
    nextBefore: done ? null : encodeLokiCursor({ n: String(endNs - 1n), h: [...seenAtBoundary] }),
    nextAfter: null,
    scannedBytes: bytes,
    done,
  }
}
