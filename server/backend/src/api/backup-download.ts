/**
 * GET /api/backup/download/:locationId/:archiveId — stream one backup archive
 * to an admin, at the pace the client reads it.
 *
 * Streams an archive at `<locationId>/<archiveId>` through the storage cap's
 * chunked-download protocol straight to the HTTP response. The admin UI uses
 * an authenticated `fetch` + Blob to fetch and trigger a save dialog (no cookie
 * auth on this server, so it cannot rely on `window.location.assign`).
 *
 * The transfer itself is `backup-download-pump.ts` — that module's doc says
 * why the loop waits for `drain` and cuts a client that stops reading. This
 * one owns auth, the archive lookup, the headers, and the ONE line per
 * download that did not exist before D447 (success was silent, failure was a
 * `console.error`).
 */
import type { FastifyInstance } from 'fastify'
import {
  BACKUP_DOWNLOAD_CHUNK_BYTES,
  BACKUP_DOWNLOAD_DRAIN_GRACE_MS,
  pumpDownload,
  type PumpResult,
} from './backup-download-pump.js'
import { extractClientIp } from './trpc/client-ip.js'

/** The two methods this route needs off `IScopedLogger`. */
export interface BackupDownloadLogger {
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

/** `AuthService.verifyToken` — throws on an invalid token. */
export interface BackupDownloadTokenVerifier {
  verifyToken(token: string): { readonly isAdmin: boolean }
}

/** `CapabilityRegistry.getSingleton`, narrowed to what this route asks for. */
export interface BackupDownloadCapabilities {
  getSingleton<T>(capability: string): T | null
}

export interface BackupArchiveSummary {
  readonly id: string
  readonly filename: string
  readonly sizeBytes: number
  readonly label?: string
}

interface BackupCapability {
  listArchives(input: { destinationId: string }): Promise<readonly BackupArchiveSummary[]>
}

interface StorageDownloadCapability {
  beginDownload(input: {
    location: string
    relativePath: string
  }): Promise<{ downloadId: string; sizeBytes: number }>
  readChunk(input: { downloadId: string; offset: number; length: number }): Promise<Uint8Array>
  endDownload(input: { downloadId: string }): Promise<void>
}

export interface BackupDownloadRouteOptions {
  readonly verifier: BackupDownloadTokenVerifier
  readonly capabilities: BackupDownloadCapabilities
  readonly logger: BackupDownloadLogger
  /** Spec overrides; production takes the pump's defaults. */
  readonly chunkBytes?: number
  readonly graceMs?: number
}

interface DownloadParams {
  readonly locationId: string
  readonly archiveId: string
}

/** Strip what would break the `Content-Disposition` header. Whitespace is fine. */
function safeAttachmentName(name: string): string {
  return name.replace(/[\r\n"]/g, '_')
}

export function registerBackupDownloadRoute(
  fastify: FastifyInstance,
  options: BackupDownloadRouteOptions,
): void {
  const { verifier, capabilities, logger } = options
  const chunkBytes = options.chunkBytes ?? BACKUP_DOWNLOAD_CHUNK_BYTES
  const graceMs = options.graceMs ?? BACKUP_DOWNLOAD_DRAIN_GRACE_MS

  fastify.get<{ Params: DownloadParams }>(
    '/api/backup/download/:locationId/:archiveId',
    async (request, reply) => {
      const authHeader = request.headers.authorization
      if (!authHeader) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
      try {
        const payload = verifier.verifyToken(authHeader.replace('Bearer ', ''))
        if (!payload.isAdmin) {
          return reply.status(403).send({ error: 'Admin required' })
        }
      } catch {
        return reply.status(401).send({ error: 'Invalid token' })
      }

      const { locationId, archiveId } = request.params
      const backup = capabilities.getSingleton<BackupCapability>('backup')
      if (!backup?.listArchives) {
        return reply.status(503).send({ error: 'Backup orchestrator unavailable' })
      }
      const archives = await backup.listArchives({ destinationId: locationId })
      const archive = archives.find((a) => a.id === archiveId)
      if (!archive) {
        return reply.status(404).send({ error: 'Archive not found' })
      }

      const storage = capabilities.getSingleton<StorageDownloadCapability>('storage')
      if (!storage?.beginDownload) {
        return reply.status(503).send({ error: 'Storage cap unavailable' })
      }

      const { downloadId, sizeBytes } = await storage.beginDownload({
        location: locationId,
        relativePath: archive.filename,
      })
      // The response is written on the raw socket, so it is taken out of
      // Fastify's hands and the headers go on the raw response. The previous
      // route set them through `reply.header(…)` — which Fastify applies only
      // on `reply.send()`, never reached here — so no download ever carried a
      // `content-length` or a `content-disposition`. `sizeBytes` is the storage
      // cap's figure for the file it is about to serve, not the catalogue's.
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(sizeBytes),
        'content-disposition': `attachment; filename="${safeAttachmentName(`${archive.label ?? archive.id}.tar.gz`)}"`,
      })
      const facts = {
        locationId,
        archiveId,
        filename: archive.filename,
        sizeBytes,
        ip: extractClientIp(request.raw) ?? '(unidentified)',
        chunkBytes,
        graceMs,
      }
      let result: PumpResult
      try {
        result = await pumpDownload({
          sizeBytes,
          chunkBytes,
          graceMs,
          sink: reply.raw,
          read: (offset, length) => storage.readChunk({ downloadId, offset, length }),
        })
      } finally {
        try {
          await storage.endDownload({ downloadId })
        } catch (err: unknown) {
          logger.warn('backup archive download: the storage cap refused to close the handle', {
            meta: { ...facts, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      logOutcome(logger, facts, result)
    },
  )
}

function logOutcome(
  logger: BackupDownloadLogger,
  facts: Record<string, unknown>,
  result: PumpResult,
): void {
  const meta = { ...facts, ...result }
  switch (result.status) {
    case 'completed':
      logger.info('backup archive download completed', { meta })
      return
    case 'peer-gone':
      logger.info('backup archive download abandoned — the client closed the connection', { meta })
      return
    case 'drain-timeout':
      logger.warn(
        'backup archive download cut — the client stopped reading and the response queue ' +
          'stayed unsent for the whole grace period (nothing more is read; the queue is released)',
        { meta },
      )
      return
    case 'source-failed':
      logger.warn('backup archive download failed — the storage cap could not serve the archive', {
        meta,
      })
      return
  }
}
