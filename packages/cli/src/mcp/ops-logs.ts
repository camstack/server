/**
 * `ops_logs`: the hub's own log API, scoped by device / addon / node / level /
 * window / text, grouped and deduplicated with counts.
 *
 * Two tiers answer: the in-RAM `ring` (recent, fast) and the persisted default
 * destination (`logs.sources`: the one marked default and readable). The ring is
 * asked first; when it does not reach back to the start of the window, the
 * persisted tier is asked instead, and the answer says which tier it came from.
 * Nothing leaves without the output scrub, so a value the scrubber hides stays
 * hidden.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import { cap, readQuery, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'

const LevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof LevelSchema>

const LogEntrySchema = z.looseObject({
  timestamp: z.string(),
  level: z.string(),
  scope: z.string().optional(),
  message: z.string(),
  tags: z.record(z.string(), z.string().optional()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
type LogEntry = z.infer<typeof LogEntrySchema>

const LogPageSchema = z.looseObject({
  entries: z.array(LogEntrySchema),
  done: z.boolean(),
  source: z.string(),
})

const LogSourcesSchema = z.array(
  z.looseObject({
    addonId: z.string(),
    readable: z.boolean(),
    isDefault: z.boolean(),
  }),
)

export const RING_SOURCE = 'ring'
export const DEFAULT_WINDOW_MINUTES = 15
export const MAX_WINDOW_MINUTES = 24 * 60
export const FETCH_LIMIT = 500
export const GROUP_LIMIT = 40
export const DEFAULT_CONTEXT_LINES = 10
export const CONTEXT_RADIUS_MS = 30_000

export interface OpsLogsArgs {
  readonly deviceId?: number
  readonly addonId?: string
  readonly nodeId?: string
  readonly level?: LogLevel
  readonly windowMinutes?: number
  readonly text?: string
  /** Context mode: a track id or event id (or any id the lines mention). */
  readonly around?: string
  /** Context mode: how many lines on each side of the first match. */
  readonly contextLines?: number
}

export interface LogGroup {
  readonly count: number
  readonly level: string
  readonly scope: string | null
  readonly message: string
  readonly firstAt: string
  readonly lastAt: string
  readonly deviceId: string | null
  readonly addonId: string | null
  readonly nodeId: string | null
}

export interface LogLine {
  readonly at: string
  readonly level: string
  readonly scope: string | null
  readonly message: string
  readonly deviceId: string | null
}

export interface OpsLogsResult {
  readonly status: 'ok'
  /** `ring`, or `persisted:<addonId>`. */
  readonly tier: string
  readonly tiersTried: readonly string[]
  readonly window: { readonly sinceMs: number; readonly untilMs: number }
  readonly scanned: number
  /** True when the page was cut by the line cap: older lines exist. */
  readonly partial: boolean
  readonly groups?: readonly LogGroup[]
  readonly groupsTruncated?: number
  readonly context?: {
    readonly around: string
    readonly matchedAt: string | null
    readonly lines: readonly LogLine[]
  }
  readonly unavailable: { readonly [part: string]: string }
}

const SEVERITY: readonly string[] = ['error', 'warn', 'info', 'debug']
const severityRank = (level: string): number => {
  const i = SEVERITY.indexOf(level)
  return i === -1 ? SEVERITY.length : i
}

/** The message with the parts that vary per line folded, so repeats group. */
export function messageKey(message: string): string {
  return (
    message
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
      // Base-36 track and event ids: 8+ alphanumerics mixing letters and digits.
      .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/gi, '<id>')
      .replace(/\d+/g, '#')
  )
}

export function groupEntries(entries: readonly LogEntry[]): LogGroup[] {
  const groups = new Map<string, LogGroup>()
  for (const e of entries) {
    const key = `${e.level}|${e.scope ?? ''}|${e.tags?.['deviceId'] ?? ''}|${messageKey(e.message)}`
    const prior = groups.get(key)
    if (prior) {
      groups.set(key, {
        ...prior,
        count: prior.count + 1,
        firstAt: e.timestamp < prior.firstAt ? e.timestamp : prior.firstAt,
        lastAt: e.timestamp > prior.lastAt ? e.timestamp : prior.lastAt,
      })
    } else {
      groups.set(key, {
        count: 1,
        level: e.level,
        scope: e.scope ?? null,
        message: e.message,
        firstAt: e.timestamp,
        lastAt: e.timestamp,
        deviceId: e.tags?.['deviceId'] ?? null,
        addonId: e.tags?.['addonId'] ?? null,
        nodeId: e.tags?.['nodeId'] ?? null,
      })
    }
  }
  return [...groups.values()].sort(
    (a, b) => severityRank(a.level) - severityRank(b.level) || b.count - a.count,
  )
}

function tagsOf(args: OpsLogsArgs): {
  deviceId?: string
  addonId?: string
  nodeId?: string
} {
  return {
    ...(args.deviceId !== undefined ? { deviceId: String(args.deviceId) } : {}),
    ...(args.addonId ? { addonId: args.addonId } : {}),
    ...(args.nodeId ? { nodeId: args.nodeId } : {}),
  }
}

interface PageQuery {
  readonly source: string
  readonly since: number
  readonly until: number
  readonly args: OpsLogsArgs
  readonly text?: string
  readonly limit: number
  readonly tags?: { deviceId?: string; addonId?: string; nodeId?: string }
}

function pageInput(q: PageQuery): { [key: string]: unknown } {
  const tags = q.tags ?? tagsOf(q.args)
  return {
    source: q.source,
    since: q.since,
    until: q.until,
    limit: q.limit,
    ...(q.args.level ? { level: q.args.level } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(q.text ? { text: q.text } : {}),
  }
}

const toMs = (iso: string): number => Date.parse(iso)

/** The ring covers the window when its oldest line is at or before the window start. */
function ringCovers(entries: readonly LogEntry[], since: number, limit: number): boolean {
  if (entries.length >= limit) return false
  if (entries.length === 0) return false
  const oldest = Math.min(...entries.map((e) => toMs(e.timestamp)))
  return oldest <= since
}

const lineOf = (e: LogEntry): LogLine => ({
  at: e.timestamp,
  level: e.level,
  scope: e.scope ?? null,
  message: e.message,
  deviceId: e.tags?.['deviceId'] ?? null,
})

export async function opsLogs(
  ctx: McpContext,
  args: OpsLogsArgs,
  now: number = Date.now(),
): Promise<OpsLogsResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<OpsLogsResult | RefusedResult> => {
    if (connection.tier !== 'admin') {
      return {
        status: 'refused',
        reason: `logs.query is admin-tier and this credential is not admin-scoped.${connection.adminHint ? ` ${connection.adminHint}` : ''}`,
      }
    }
    const client = connection.client
    const windowMinutes = Math.min(args.windowMinutes ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES)
    const until = now
    const since = now - windowMinutes * 60_000
    const unavailable: { [part: string]: string } = {}
    const tried: string[] = []

    const fetchTier = async (
      source: string,
      q: Omit<PageQuery, 'source'>,
    ): Promise<z.infer<typeof LogPageSchema> | null> => {
      tried.push(source === RING_SOURCE ? RING_SOURCE : `persisted:${source}`)
      const read = await readQuery(client, 'logs.query', pageInput({ ...q, source }), LogPageSchema)
      if (!read.ok) {
        unavailable[source] = read.reason
        return null
      }
      return read.value
    }

    const persistedSource = async (): Promise<string | null> => {
      const sources = await readQuery(client, 'logs.sources', undefined, LogSourcesSchema)
      if (!sources.ok) {
        unavailable['logs.sources'] = sources.reason
        return null
      }
      return sources.value.find((s) => s.isDefault && s.readable)?.addonId ?? null
    }

    // Pick the tier whose page holds the window, ring first.
    const query = async (
      q: Omit<PageQuery, 'source'>,
    ): Promise<{
      tier: string
      page: z.infer<typeof LogPageSchema>
    } | null> => {
      const ring = await fetchTier(RING_SOURCE, q)
      if (ring && ringCovers(ring.entries, q.since, q.limit))
        return { tier: RING_SOURCE, page: ring }
      const persisted = await persistedSource()
      if (persisted !== null) {
        const page = await fetchTier(persisted, q)
        if (page) return { tier: `persisted:${persisted}`, page }
      }
      // The ring is all there is: its answer stands, flagged by `tier`.
      return ring ? { tier: RING_SOURCE, page: ring } : null
    }

    const base = { since, until, args, limit: FETCH_LIMIT }

    if (args.around !== undefined && args.around !== '') {
      const found = await query({ ...base, text: args.around, limit: 20 })
      if (found === null) {
        return {
          status: 'ok',
          tier: 'none',
          tiersTried: tried,
          window: { sinceMs: since, untilMs: until },
          scanned: 0,
          partial: false,
          unavailable,
        }
      }
      const hit = [...found.page.entries].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp))[0]
      if (!hit) {
        return {
          status: 'ok',
          tier: found.tier,
          tiersTried: tried,
          window: { sinceMs: since, untilMs: until },
          scanned: 0,
          partial: false,
          context: { around: args.around, matchedAt: null, lines: [] },
          unavailable,
        }
      }
      const at = toMs(hit.timestamp)
      const hitTags = hit.tags?.['deviceId']
      const around = await query({
        since: at - CONTEXT_RADIUS_MS,
        until: at + CONTEXT_RADIUS_MS,
        args,
        limit: FETCH_LIMIT,
        ...(args.deviceId === undefined && hitTags ? { tags: { deviceId: hitTags } } : {}),
      })
      const n = Math.max(1, args.contextLines ?? DEFAULT_CONTEXT_LINES)
      const ordered = (around?.page.entries ?? []).sort(
        (a, b) => toMs(a.timestamp) - toMs(b.timestamp),
      )
      const index = ordered.findIndex(
        (e) => e.timestamp === hit.timestamp && e.message === hit.message,
      )
      const centre = index === -1 ? 0 : index
      const lines = ordered.slice(Math.max(0, centre - n), centre + n + 1).map(lineOf)
      const out: OpsLogsResult = {
        status: 'ok',
        tier: around?.tier ?? found.tier,
        tiersTried: tried,
        window: { sinceMs: since, untilMs: until },
        scanned: ordered.length,
        partial: false,
        context: {
          around: args.around,
          matchedAt: hit.timestamp,
          lines,
        },
        unavailable,
      }
      return out
    }

    const answered = await query({
      ...base,
      ...(args.text ? { text: args.text } : {}),
    })
    if (answered === null) {
      return {
        status: 'ok',
        tier: 'none',
        tiersTried: tried,
        window: { sinceMs: since, untilMs: until },
        scanned: 0,
        partial: false,
        unavailable,
      }
    }
    const groups = cap(groupEntries(answered.page.entries), GROUP_LIMIT)
    return {
      status: 'ok',
      tier: answered.tier,
      tiersTried: tried,
      window: { sinceMs: since, untilMs: until },
      scanned: answered.page.entries.length,
      partial: !answered.page.done || answered.page.entries.length >= FETCH_LIMIT,
      groups: groups.items,
      groupsTruncated: groups.truncated,
      unavailable,
    }
  })
}
