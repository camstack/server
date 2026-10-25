/**
 * GET /api/backup/download/:locationId/:archiveId — auth, lookup, headers,
 * the streamed bytes, and the one line per download.
 *
 * The backpressure policy is `backup-download-pump.spec.ts`; this proves the
 * route wires the pump to the storage cap, closes the download handle on
 * every exit, and SAYS what happened.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  registerBackupDownloadRoute,
  type BackupArchiveSummary,
  type BackupDownloadLogger,
} from '../backup-download.js'

const ADMIN = 'admin-jwt'
const VIEWER = 'viewer-jwt'

interface LoggedLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly meta: Record<string, unknown>
}

function recorder(): { readonly logger: BackupDownloadLogger; readonly lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  return {
    lines,
    logger: {
      info: (message, context) => lines.push({ level: 'info', message, meta: context?.meta ?? {} }),
      warn: (message, context) => lines.push({ level: 'warn', message, meta: context?.meta ?? {} }),
    },
  }
}

const ARCHIVE: BackupArchiveSummary = {
  id: 'arch-1',
  filename: 'backups/arch-1.tar.gz',
  sizeBytes: 20,
  label: 'nightly "friday"',
}

interface StorageCalls {
  begun: number
  ended: number
  reads: { offset: number; length: number }[]
}

function storageOf(
  payload: Uint8Array,
  calls: StorageCalls,
  failAt?: number,
): Record<string, unknown> {
  return {
    beginDownload: async () => {
      calls.begun += 1
      return { downloadId: 'dl-1', sizeBytes: payload.byteLength }
    },
    readChunk: async ({ offset, length }: { offset: number; length: number }) => {
      calls.reads.push({ offset, length })
      if (failAt !== undefined && offset >= failAt) throw new Error('volume unmounted')
      return payload.subarray(offset, Math.min(payload.byteLength, offset + length))
    },
    endDownload: async () => {
      calls.ended += 1
    },
  }
}

describe('GET /api/backup/download', () => {
  let app: FastifyInstance
  let log: ReturnType<typeof recorder>
  let calls: StorageCalls
  let payload: Uint8Array
  let storage: Record<string, unknown> | null
  let backup: Record<string, unknown> | null

  beforeEach(async () => {
    app = Fastify()
    log = recorder()
    calls = { begun: 0, ended: 0, reads: [] }
    payload = new Uint8Array(20).map((_, i) => i)
    storage = storageOf(payload, calls)
    backup = { listArchives: async () => [ARCHIVE] }
    registerBackupDownloadRoute(app, {
      verifier: {
        verifyToken: (token) => {
          if (token === ADMIN) return { isAdmin: true }
          if (token === VIEWER) return { isAdmin: false }
          throw new Error('bad token')
        },
      },
      capabilities: {
        getSingleton: <T>(name: string): T | null =>
          (name === 'backup' ? backup : name === 'storage' ? storage : null) as T | null,
      },
      logger: log.logger,
      chunkBytes: 8,
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const url = `/api/backup/download/loc-1/${ARCHIVE.id}`

  it('refuses without a token, with a bad token, and to a non-admin', async () => {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${VIEWER}` } }))
        .statusCode,
    ).toBe(403)
    expect(calls.begun).toBe(0)
  })

  it('404s an archive the orchestrator does not list, 503s a missing cap', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/backup/download/loc-1/other',
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(missing.statusCode).toBe(404)
    backup = null
    const noBackup = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(noBackup.statusCode).toBe(503)
    expect(calls.begun).toBe(0)
  })

  it('streams the archive chunk by chunk, closes the handle, and logs one line with the numbers', async () => {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/gzip')
    expect(res.headers['content-length']).toBe('20')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="nightly _friday_.tar.gz"',
    )
    expect(new Uint8Array(res.rawPayload)).toEqual(payload)
    expect(calls.reads).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: 16, length: 4 },
    ])
    expect(calls.begun).toBe(1)
    expect(calls.ended).toBe(1)

    expect(log.lines).toHaveLength(1)
    const line = log.lines[0]!
    expect(line.level).toBe('info')
    expect(line.message).toBe('backup archive download completed')
    expect(line.meta).toMatchObject({
      status: 'completed',
      archiveId: ARCHIVE.id,
      locationId: 'loc-1',
      sizeBytes: 20,
      bytesWritten: 20,
      drainWaits: 0,
    })
  })

  it('a source that fails mid-stream still closes the handle and is a warn line, not a console line', async () => {
    storage = storageOf(payload, calls, 8)
    // Headers were already sent; the response is destroyed with the error,
    // not re-statused. How `inject` surfaces a destroyed response is its
    // business — what this proves is on the handle and in the log.
    await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${ADMIN}` } }).then(
      () => undefined,
      () => undefined,
    )
    expect(calls.ended).toBe(1)
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]!.level).toBe('warn')
    expect(log.lines[0]!.meta).toMatchObject({
      status: 'source-failed',
      error: 'volume unmounted',
      bytesWritten: 8,
    })
  })
})
