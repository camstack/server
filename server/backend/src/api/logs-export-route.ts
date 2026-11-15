/**
 * GET /api/logs/export — the log export (#570) as one NDJSON download.
 *
 * Query string (all optional): `components` (comma-separated addonIds),
 * `deviceIds` (comma-separated numeric ids), `since` / `until` (epoch ms),
 * `level`, `source` (a read-capable log-destination, default the hub's files).
 * Default: everything over the last six hours. The selection and the merge
 * live in `core/logging/log-export.ts`; the admin Logs page and the ops MCP
 * tool both call this route, so there is one implementation.
 *
 * The lines go out at the pace the client reads them (D447): a write the
 * socket did not take waits for `drain`, a client that stops reading is cut
 * after the grace, a client that leaves stops the read, and every exit logs
 * one line. Admin only, Bearer auth, like the backup download.
 */

import type { LogEntry, LogReadEntry, LogReadQuery } from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import {
  exportLogEntries,
  exportSourceOf,
  LOG_EXPORT_MAX_ENTRIES,
  type LogExportRequest,
  parseLogExportRequest,
  toNdjsonLine,
} from '../core/logging/log-export.js'
import { DEFAULT_LOG_SOURCE, RING_LOG_SOURCE, readLogHistory } from '../core/logging/log-history.js'
import {
  BACKUP_DOWNLOAD_DRAIN_GRACE_MS,
  type DownloadSink,
  waitForDrain,
} from './backup-download-pump.js'
import { hubLocalDestinations, type LogDestinationRegistry } from './core/logs.router.js'
import { extractClientIp } from './trpc/client-ip.js'

export const LOGS_EXPORT_PATH = '/api/logs/export'

export interface LogsExportLogger {
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

export interface LogsExportTokenVerifier {
  verifyToken(token: string): { readonly isAdmin: boolean }
}

/** `LoggingService.query` — the hub's in-memory tail, newest first. */
export interface LogsExportTail {
  query(filter: Record<string, never>): LogEntry[]
}

export interface LogsExportRouteOptions {
  readonly verifier: LogsExportTokenVerifier
  readonly registry: LogDestinationRegistry | null
  readonly tail: LogsExportTail
  readonly logger: LogsExportLogger
  readonly graceMs?: number
  readonly maxEntries?: number
  readonly now?: () => number
}

/** The writable this module writes to — `http.ServerResponse` in production. */
export type LogExportSink = DownloadSink

export type LogExportResult =
  | {
      readonly status: 'completed'
      readonly lines: number
      readonly bytes: number
      readonly truncated: boolean
    }
  | { readonly status: 'peer-gone'; readonly lines: number; readonly bytes: number }
  | {
      readonly status: 'drain-timeout'
      readonly lines: number
      readonly bytes: number
      readonly queuedBytes: number
    }
  | {
      readonly status: 'source-failed'
      readonly lines: number
      readonly bytes: number
      readonly error: string
    }

export interface CollectLogExportArgs {
  readonly entries: AsyncIterable<LogReadEntry>
  readonly sink: LogExportSink
  readonly maxEntries?: number
  readonly graceMs?: number
}

/**
 * Write the export's lines into `sink`, one NDJSON line per entry. Past
 * `maxEntries` it stops and writes one last `{"truncated":true,…}` line, so a
 * capped file never looks complete. Never throws: every exit is a result.
 */
export async function collectLogExport(args: CollectLogExportArgs): Promise<LogExportResult> {
  const { sink } = args
  const maxEntries = args.maxEntries ?? LOG_EXPORT_MAX_ENTRIES
  const graceMs = args.graceMs ?? BACKUP_DOWNLOAD_DRAIN_GRACE_MS
  let lines = 0
  let bytes = 0
  let truncated = false

  const write = async (text: string): Promise<'ok' | 'closed' | 'timeout'> => {
    const chunk = Buffer.from(text, 'utf8')
    bytes += chunk.byteLength
    if (sink.write(chunk)) return 'ok'
    const outcome = await waitForDrain(sink, graceMs)
    return outcome === 'drained' ? 'ok' : outcome
  }

  try {
    for await (const entry of args.entries) {
      if (sink.destroyed) return { status: 'peer-gone', lines, bytes }
      if (lines >= maxEntries) {
        truncated = true
        break
      }
      const outcome = await write(toNdjsonLine(entry))
      lines += 1
      if (outcome === 'closed') return { status: 'peer-gone', lines, bytes }
      if (outcome === 'timeout') {
        const queuedBytes = sink.writableLength
        sink.destroy(new Error(`log export: client stopped reading — ${queuedBytes} bytes queued`))
        return { status: 'drain-timeout', lines, bytes, queuedBytes }
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err)
    sink.destroy(new Error(`log export: the log source failed — ${error}`))
    return { status: 'source-failed', lines, bytes, error }
  }
  if (truncated) {
    await write(`${JSON.stringify({ truncated: true, maxEntries, lines })}\n`)
  }
  sink.end()
  return { status: 'completed', lines, bytes, truncated }
}

function attachmentName(request: LogExportRequest): string {
  const stamp = new Date(request.until).toISOString().replace(/[:.]/g, '-')
  return `camstack-logs-${stamp}.ndjson`
}

export function registerLogsExportRoute(
  fastify: FastifyInstance,
  options: LogsExportRouteOptions,
): void {
  const { verifier, registry, tail, logger } = options
  const now = options.now ?? ((): number => Date.now())

  fastify.get(LOGS_EXPORT_PATH, async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader) return reply.status(401).send({ error: 'Unauthorized' })
    try {
      const payload = verifier.verifyToken(authHeader.replace('Bearer ', ''))
      if (!payload.isAdmin) return reply.status(403).send({ error: 'Admin required' })
    } catch {
      return reply.status(401).send({ error: 'Invalid token' })
    }

    const parsed = parseLogExportRequest(request.query, now())
    if (!parsed.ok) return reply.status(400).send({ error: parsed.error })
    const exportRequest = parsed.request
    const sourceId = exportSourceOf(request.query) ?? DEFAULT_LOG_SOURCE
    const provider =
      sourceId === RING_LOG_SOURCE
        ? null
        : (hubLocalDestinations(registry).find(([id]) => id === sourceId)?.[1] ?? null)

    const aborter = new AbortController()
    const requestIds: string[] = []
    const read = (query: LogReadQuery) => {
      const requestId = `log-export-${String(requestIds.length)}-${String(now())}`
      requestIds.push(requestId)
      return readLogHistory({
        query: { ...query, requestId },
        source: sourceId,
        tail: tail.query({}),
        provider,
      })
    }
    const onClose = (): void => {
      if (reply.raw.writableFinished) return
      aborter.abort()
      const last = requestIds.at(-1)
      if (last !== undefined)
        void provider?.cancelRead?.({ requestId: last }).catch(() => undefined)
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${attachmentName(exportRequest)}"`,
      'cache-control': 'no-store',
    })
    reply.raw.on('close', onClose)
    const startedAt = now()
    const result = await collectLogExport({
      entries: exportLogEntries({ request: exportRequest, read, signal: aborter.signal }),
      sink: reply.raw,
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    })
    reply.raw.off('close', onClose)
    const meta = {
      ...result,
      source: sourceId,
      components: exportRequest.components,
      deviceIds: exportRequest.deviceIds,
      since: exportRequest.since,
      until: exportRequest.until,
      durationMs: now() - startedAt,
      ip: extractClientIp(request.raw) ?? '(unidentified)',
    }
    if (result.status === 'completed') logger.info('log export completed', { meta })
    else if (result.status === 'peer-gone')
      logger.info('log export abandoned — the client closed the connection', { meta })
    else logger.warn(`log export ended early: ${result.status}`, { meta })
  })
}
