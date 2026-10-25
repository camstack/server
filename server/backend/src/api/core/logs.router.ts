/**
 * Logs router — fixed core API (not a capability).
 *
 * Queries and streams log entries via `LoggingService` (thin NestJS DI
 * wrapper over `LogManager` from `@camstack/system`). Admin can read
 * everything; viewers/protected users only see entries matching their
 * allowed providers scope (filtered in `query`).
 */
import { z } from 'zod'
import type { LoggingService } from '../../core/logging/logging.service.js'
import { trpcRouter, adminProcedure, iterableSubscription } from '../trpc/trpc.middleware.js'
import { randomUUID } from 'node:crypto'
import { lineContainsText } from '@camstack/system'
import type { ILogDestination, LogEntry, LogReadEntry, LogReadQuery } from '@camstack/types'
import {
  DEFAULT_LOG_SOURCE,
  DEFAULT_PAGE_LIMIT,
  RING_LOG_SOURCE,
  readLogHistory,
} from '../../core/logging/log-history.js'

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

const LogTagsSchema = z.object({
  agentId: z.string().optional(),
  nodeId: z.string().optional(),
  /** Numeric progressive id (or its string form for legacy callers). */
  deviceId: z.union([z.string(), z.number()]).optional(),
  /** Parent container id — set on every accessory child's logs (and on the
   *  container's own logs). Filtering by it returns the whole container subtree
   *  (container + all children) in one query. */
  containerDeviceId: z.union([z.string(), z.number()]).optional(),
  deviceName: z.string().optional(),
  integrationId: z.string().optional(),
  addonId: z.string().optional(),
  streamId: z.string().optional(),
  streamName: z.string().optional(),
  sessionId: z.string().optional(),
  /**
   * Correlation id used to scope a single short-lived operation
   * (e.g. a `testCreationField` probe). The Add-Device modal generates
   * one per dialog open and providers tag their loggers with it so the
   * modal can stream test logs without a deviceId (the device doesn't
   * exist yet).
   */
  requestId: z.string().optional(),
})

/** Wire shape of a log entry — timestamp is serialised to ISO string by tRPC. */
const LogEntrySchema = z.object({
  /** `<bootId>.<seq>` — identical live and on disk; the client's dedupe key (D898). */
  id: z.string().optional(),
  timestamp: z.string(),
  level: z.string(),
  scope: z.string().optional(),
  message: z.string(),
  tags: z.record(z.string(), z.string().optional()).optional(),
  /**
   * Ad-hoc structured payload attached to the log call (e.g.
   * `{error, brokerId, sourceType, url}` for stream-broker errors).
   * Tags are filterable structural fields; meta is the per-call
   * payload operators read in the expanded LogStream row.
   */
  meta: z.record(z.string(), z.unknown()).optional(),
})

const LogEntryArraySchema = z.array(LogEntrySchema)

/** Wire shape of a history page (D898). */
const LogPageSchema = z.object({
  entries: LogEntryArraySchema,
  /** Pass back as `before` to load the next OLDER page; null = nothing older. */
  nextBefore: z.string().nullable(),
  nextAfter: z.string().nullable(),
  /** Bytes the source scanned for this slice — the "N MB scanned" indicator. */
  scannedBytes: z.number().int().nonnegative(),
  /**
   * True when the source has nothing older. False with fewer than `limit`
   * entries = the slice's time budget ran out first; ask again with
   * `nextBefore` to keep searching.
   */
  done: z.boolean(),
  cancelled: z.boolean().optional(),
  /** The source that answered — `ring` when the requested one cannot read. */
  source: z.string(),
})

const LogSourceSchema = z.object({
  addonId: z.string(),
  readable: z.boolean(),
  reason: z.string().nullable(),
  isDefault: z.boolean(),
  retentionDays: z.number().nullable(),
  filters: z.object({
    deviceId: z.boolean(),
    addonId: z.boolean(),
    nodeId: z.boolean(),
    tags: z.boolean(),
    level: z.boolean(),
    text: z.boolean(),
    timeRange: z.boolean(),
  }),
})

type LogTagsInput = z.infer<typeof LogTagsSchema>
type LogReadScope = Pick<LogReadQuery, 'deviceId' | 'fromAddonId' | 'fromNodeId' | 'tags'>
type WireLogEntry = z.infer<typeof LogEntrySchema>
type LogSource = z.infer<typeof LogSourceSchema>

/** `tags` (the LogStream scope) → the read contract's indexed fields + the rest. */
function readFiltersFromTags(tags: LogTagsInput | undefined): LogReadScope {
  if (tags === undefined) return {}
  const rest: Record<string, string | number> = {}
  let deviceId: number | undefined
  let addonId: string | undefined
  let nodeId: string | undefined
  for (const [key, raw] of Object.entries(tags)) {
    if (raw === undefined) continue
    if (key === 'deviceId') {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isInteger(n)) deviceId = n
      continue
    }
    if (key === 'addonId' && typeof raw === 'string') {
      addonId = raw
      continue
    }
    if (key === 'agentId' && typeof raw === 'string') {
      nodeId = raw
      continue
    }
    if (key === 'containerDeviceId') {
      const n = typeof raw === 'number' ? raw : Number(raw)
      rest[key] = Number.isInteger(n) ? n : String(raw)
      continue
    }
    rest[key] = raw
  }
  return {
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(addonId !== undefined ? { fromAddonId: addonId } : {}),
    ...(nodeId !== undefined ? { fromNodeId: nodeId } : {}),
    ...(Object.keys(rest).length > 0 ? { tags: rest } : {}),
  }
}

function toWire(entry: LogReadEntry): WireLogEntry {
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

/** The one registry read this router makes — `CapabilityRegistry` satisfies it. */
export interface LogDestinationRegistry {
  getCollectionEntries(
    capability: 'log-destination',
  ): readonly (readonly [string, ILogDestination])[]
}

/** Hub-local providers only: an agent's own files hold lines the hub already has. */
function hubLocalDestinations(
  registry: LogDestinationRegistry | null,
): ReadonlyArray<readonly [string, ILogDestination]> {
  if (registry === null) return []
  return registry
    .getCollectionEntries('log-destination')
    .filter(([addonId]) => !addonId.includes('@'))
}

const NOT_READABLE: Omit<LogSource, 'addonId' | 'isDefault'> = {
  readable: false,
  reason: 'This destination only ships lines',
  retentionDays: null,
  filters: {
    deviceId: false,
    addonId: false,
    nodeId: false,
    tags: false,
    level: false,
    text: false,
    timeRange: false,
  },
}

export function createLogsRouter(
  logging: LoggingService,
  capabilityRegistry: LogDestinationRegistry | null = null,
) {
  return trpcRouter({
    /**
     * One page of history (D898): newest first, from the source the client
     * picked (default the hub's rotated files), every filter applied by the
     * source BEFORE the limit. Page older with `before: nextBefore`. A slice
     * is time-bounded — `done: false` with a short page means "still
     * searching", and aborting the request cancels the slice in flight.
     */
    query: adminProcedure
      .input(
        z.object({
          /** A read-capable log-destination addonId, or `ring`. Default `winston-logging`. */
          source: z.string().min(1).max(200).optional(),
          level: LogLevelSchema.optional(),
          since: z.number().optional(),
          until: z.number().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          tags: LogTagsSchema.optional(),
          /** Case-insensitive substring over message, scope, tags and meta. */
          text: z.string().max(200).optional(),
          before: z.string().min(1).max(1024).optional(),
          after: z.string().min(1).max(1024).optional(),
          budgetMs: z.number().int().min(50).max(10_000).optional(),
        }),
      )
      .output(LogPageSchema)
      .query(async ({ input, signal }) => {
        const sourceId = input.source ?? DEFAULT_LOG_SOURCE
        const provider =
          sourceId === RING_LOG_SOURCE
            ? null
            : (hubLocalDestinations(capabilityRegistry).find(([id]) => id === sourceId)?.[1] ??
              null)
        const requestId = randomUUID()
        const text = input.text?.trim()
        const query: LogReadQuery = {
          requestId,
          ...readFiltersFromTags(input.tags),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(text !== undefined && text.length > 0 ? { text } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(input.before !== undefined ? { before: input.before } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
          limit: input.limit ?? DEFAULT_PAGE_LIMIT,
        }
        const onAbort = (): void => {
          void provider?.cancelRead?.({ requestId }).catch(() => undefined)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          const page = await readLogHistory({
            query,
            source: sourceId,
            tail: logging.query({}),
            provider,
          })
          return {
            entries: page.entries.map(toWire),
            nextBefore: page.nextBefore,
            nextAfter: page.nextAfter,
            scannedBytes: page.scannedBytes,
            done: page.done,
            ...(page.cancelled !== undefined ? { cancelled: page.cancelled } : {}),
            source: page.source,
          }
        } finally {
          signal?.removeEventListener('abort', onAbort)
        }
      }),

    /**
     * The history sources the Logs page can offer: every hub-local
     * log-destination with what it can read. A destination without
     * `describeRead` is listed as not readable, never omitted — "ships only"
     * is an answer, "not installed" is a different one.
     */
    sources: adminProcedure.output(z.array(LogSourceSchema)).query(async () => {
      const out: LogSource[] = []
      for (const [addonId, dest] of hubLocalDestinations(capabilityRegistry)) {
        const isDefault = addonId === DEFAULT_LOG_SOURCE
        if (dest.describeRead === undefined) {
          out.push({ addonId, isDefault, ...NOT_READABLE })
          continue
        }
        try {
          const caps = await dest.describeRead()
          out.push({ addonId, isDefault, ...caps })
        } catch (error) {
          out.push({
            addonId,
            isDefault,
            ...NOT_READABLE,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return out
    }),

    /**
     * Drop matching entries from the in-memory ring buffer. Powers
     * the UI's "Clear logs" button — without server-side purge, the
     * cleared rows reappear on the next page open from the historical
     * `query`. Admin-only so a viewer can't wipe context other ops
     * are reading.
     */
    clear: adminProcedure
      .input(
        z.object({
          level: LogLevelSchema.optional(),
          since: z.number().optional(),
          until: z.number().optional(),
          tags: LogTagsSchema.optional(),
        }),
      )
      .output(z.object({ removed: z.number().int().nonnegative() }))
      .mutation(({ input }) => {
        const filter: Record<string, unknown> = {}
        if (input.level) filter.level = input.level
        if (input.since !== undefined) filter.since = new Date(input.since)
        if (input.until !== undefined) filter.until = new Date(input.until)
        if (input.tags) filter.tags = input.tags
        const removed = logging.clear(filter)
        return { removed }
      }),

    // SECURITY (F0.5): the log stream is a system-wide firehose — it carries
    // error context, file paths, config fragments and per-device diagnostics
    // with no reliable per-caller projection. `query` and `clear` are already
    // `adminProcedure`; `subscribe` was the one non-admin door onto the same
    // data, so it is gated to match. (A scoped, device-projected log view is a
    // later, larger change — not a security hotfix.)
    subscribe: adminProcedure
      .input(
        z.object({
          level: LogLevelSchema.optional(),
          tags: LogTagsSchema.optional(),
          /** Same text filter as `query`, applied before the push (D898). */
          text: z.string().max(200).optional(),
        }),
      )
      .subscription(({ input }) => {
        const needle = input.text?.trim().toLowerCase() ?? ''
        return iterableSubscription<unknown>((push) => {
          return logging.subscribe(
            {
              level: input.level,
              tags: input.tags as Record<string, string> | undefined,
            },
            (entry: LogEntry) => {
              if (
                needle.length > 0 &&
                !lineContainsText(
                  {
                    timestamp: 0,
                    level: entry.level,
                    message: entry.message,
                    scope: entry.scope,
                    tags: entry.tags,
                    meta: entry.meta,
                  },
                  needle,
                )
              ) {
                return
              }
              const stringifiedTags = entry.tags
                ? Object.fromEntries(
                    Object.entries(entry.tags).map(([k, v]) => [
                      k,
                      v === undefined ? undefined : String(v),
                    ]),
                  )
                : undefined
              push({
                ...(entry.id !== undefined ? { id: entry.id } : {}),
                timestamp:
                  entry.timestamp instanceof Date
                    ? entry.timestamp.toISOString()
                    : String(entry.timestamp),
                level: entry.level,
                message: entry.message,
                scope: entry.scope,
                tags: stringifiedTags,
                meta: entry.meta,
              })
            },
          )
        })
      }),
  })
}
