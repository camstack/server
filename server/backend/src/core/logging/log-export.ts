/**
 * The log export (#570): the lines of some components and/or some devices over
 * a time range, by default everything over the last six hours, as NDJSON.
 *
 * One implementation. The admin Logs page and the ops MCP tool both download
 * `GET /api/logs/export` (`api/logs-export-route.ts`), which streams what
 * {@link exportLogEntries} yields. Nothing here builds the export in memory:
 * the source is read one page at a time, the next page only once the socket
 * took the previous lines.
 *
 * Filter semantics: the selected components are OR-ed, the selected devices
 * are OR-ed, and the two facets are AND-ed. Each (component, device) pair is
 * one read through the D898 read contract with its indexed fields
 * (`fromAddonId`, `deviceId`), and the pairs are merged newest first. A line
 * carries one `addonId` and one `deviceId`, so the pairs never overlap; the
 * id set only guards against a source that repeats a line across pages.
 */

import type { LogReadEntry, LogReadQuery, LogReadResult } from '@camstack/types'
import { z } from 'zod'

/** "Everything, last six hours" — the default the issue asked for. */
export const LOG_EXPORT_DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
/** Lines per source page. The read contract caps a page at 1000. */
export const LOG_EXPORT_PAGE_LIMIT = 1000
/** The most lines one export writes; the last line says when it stopped there. */
export const LOG_EXPORT_MAX_ENTRIES = 500_000
/** Pages one pair may ask for before the export gives that pair up. */
const MAX_PAGES_PER_PAIR = 100_000

const LevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

/** Query-string shape: lists are comma-separated, times are epoch ms. */
const RawExportQuerySchema = z.object({
  components: z.string().max(4000).optional(),
  deviceIds: z.string().max(4000).optional(),
  since: z.string().regex(/^\d+$/).optional(),
  until: z.string().regex(/^\d+$/).optional(),
  level: LevelSchema.optional(),
  source: z.string().min(1).max(200).optional(),
})

export type RawLogExportQuery = z.input<typeof RawExportQuerySchema>
export type LogExportLevel = z.infer<typeof LevelSchema>

export interface LogExportRequest {
  /** addonIds; empty means every component (and lines with no addonId). */
  readonly components: readonly string[]
  /** Numeric device ids; empty means every line, with or without a device. */
  readonly deviceIds: readonly number[]
  readonly since: number
  readonly until: number
  readonly level?: LogExportLevel
}

export type ParsedLogExportRequest =
  | { readonly ok: true; readonly request: LogExportRequest }
  | { readonly ok: false; readonly error: string }

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** The query string the route and the MCP tool send, with the defaults applied. */
export function parseLogExportRequest(raw: unknown, now: number): ParsedLogExportRequest {
  const parsed = RawExportQuerySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'bad query' }
  const q = parsed.data
  const deviceIds: number[] = []
  for (const part of splitList(q.deviceIds)) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0)
      return { ok: false, error: `deviceIds: "${part}" is not a device id` }
    deviceIds.push(n)
  }
  const until = q.until !== undefined ? Number(q.until) : now
  const since = q.since !== undefined ? Number(q.since) : until - LOG_EXPORT_DEFAULT_WINDOW_MS
  if (since > until) return { ok: false, error: 'since is after until' }
  return {
    ok: true,
    request: {
      components: [...new Set(splitList(q.components))],
      deviceIds: [...new Set(deviceIds)],
      since,
      until,
      ...(q.level !== undefined ? { level: q.level } : {}),
    },
  }
}

/** The `source` the query string named, if any (the route's default is the hub's files). */
export function exportSourceOf(raw: unknown): string | undefined {
  const parsed = RawExportQuerySchema.safeParse(raw)
  return parsed.success ? parsed.data.source : undefined
}

export type LogPageReader = (query: LogReadQuery) => Promise<LogReadResult>

export interface ExportLogEntriesArgs {
  readonly request: LogExportRequest
  /** One D898 page (production: `readLogHistory` over the chosen source + the hub tail). */
  readonly read: LogPageReader
  readonly pageLimit?: number
  readonly signal?: AbortSignal
}

interface PairFilter {
  readonly fromAddonId?: string
  readonly deviceId?: number
}

function pairsOf(request: LogExportRequest): PairFilter[] {
  const components: (string | undefined)[] =
    request.components.length > 0 ? [...request.components] : [undefined]
  const devices: (number | undefined)[] =
    request.deviceIds.length > 0 ? [...request.deviceIds] : [undefined]
  const pairs: PairFilter[] = []
  for (const fromAddonId of components) {
    for (const deviceId of devices) {
      pairs.push({
        ...(fromAddonId !== undefined ? { fromAddonId } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
      })
    }
  }
  return pairs
}

/** One pair's lines, newest first, paged on demand. */
class PairCursor {
  private buffer: LogReadEntry[] = []
  private before: string | undefined
  private exhausted = false
  private pages = 0

  constructor(
    private readonly base: LogReadQuery,
    private readonly read: LogPageReader,
  ) {}

  /** The newest unread line, reading pages until one has a line or the pair is done. */
  async peek(): Promise<LogReadEntry | undefined> {
    while (this.buffer.length === 0 && !this.exhausted) {
      const page = await this.read({
        ...this.base,
        ...(this.before !== undefined ? { before: this.before } : {}),
      })
      this.pages += 1
      this.buffer = [...page.entries]
      // `done: false` with a short page is a slice whose time budget ran out:
      // ask again from the cursor. No cursor means nothing more to ask for.
      if (page.done || page.nextBefore === null || this.pages >= MAX_PAGES_PER_PAIR) {
        this.exhausted = true
      } else {
        this.before = page.nextBefore
      }
    }
    return this.buffer[0]
  }

  shift(): void {
    this.buffer.shift()
  }
}

/** The export's lines, newest first, inside `[since, until]`. */
export async function* exportLogEntries(
  args: ExportLogEntriesArgs,
): AsyncGenerator<LogReadEntry, void, undefined> {
  const { request, read } = args
  const limit = args.pageLimit ?? LOG_EXPORT_PAGE_LIMIT
  const cursors = pairsOf(request).map(
    (pair) =>
      new PairCursor(
        {
          ...pair,
          since: request.since,
          until: request.until,
          ...(request.level !== undefined ? { level: request.level } : {}),
          limit,
        },
        read,
      ),
  )
  const seen = new Set<string>()
  for (;;) {
    if (args.signal?.aborted === true) return
    let newest: { readonly cursor: PairCursor; readonly entry: LogReadEntry } | null = null
    for (const cursor of cursors) {
      const entry = await cursor.peek()
      if (entry === undefined) continue
      if (newest === null || entry.timestamp > newest.entry.timestamp) newest = { cursor, entry }
    }
    if (newest === null) return
    newest.cursor.shift()
    const { entry } = newest
    if (entry.timestamp < request.since || entry.timestamp > request.until) continue
    if (entry.id !== undefined) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
    }
    yield entry
  }
}

/** One exported line — the same wire shape `logs.query` returns. */
export interface WireLogLine {
  readonly id?: string
  readonly timestamp: string
  readonly level: string
  readonly scope?: string
  readonly message: string
  /** Every tag as a string — `deviceId` included, so a line names its camera. */
  readonly tags?: Record<string, string>
  readonly meta?: Record<string, unknown>
}

export function toWireLogLine(entry: LogReadEntry): WireLogLine {
  return {
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    timestamp: new Date(entry.timestamp).toISOString(),
    level: entry.level,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    message: entry.message,
    ...(entry.tags !== undefined
      ? {
          tags: Object.fromEntries(
            Object.entries(entry.tags).map(([k, v]) => [k, String(v)] as const),
          ),
        }
      : {}),
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  }
}

export function toNdjsonLine(entry: LogReadEntry): string {
  return `${JSON.stringify(toWireLogLine(entry))}\n`
}
