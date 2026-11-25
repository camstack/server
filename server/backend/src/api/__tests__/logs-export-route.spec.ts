/**
 * GET /api/logs/export (#570) — admin only, the default six-hour window,
 * components × devices reaching the source, one NDJSON line per entry with
 * deviceId kept, a cap that says it capped, and one log line per export.
 */

import * as zlib from 'node:zlib'
import type { ILogDestination, LogReadEntry, LogReadQuery } from '@camstack/types'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectLogExport,
  LOGS_EXPORT_PATH,
  type LogExportSink,
  type LogsExportLogger,
  registerLogsExportRoute,
} from '../logs-export-route.js'

const ADMIN = 'admin-jwt'
const VIEWER = 'viewer-jwt'
const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const MIN = 60_000

function line(id: string, minutesAgo: number, tags: Record<string, string | number>): LogReadEntry {
  return { id, timestamp: NOW - minutesAgo * MIN, level: 'info', message: `m ${id}`, tags }
}

const LINES: readonly LogReadEntry[] = [
  line('a-d7', 5, { addonId: 'a', deviceId: 7 }),
  line('b-d7', 15, { addonId: 'b', deviceId: 7 }),
  line('a-d8', 25, { addonId: 'a', deviceId: 8 }),
]

function destination(reads: LogReadQuery[]): ILogDestination {
  return {
    initialize: async () => undefined,
    shutdown: async () => undefined,
    write: () => undefined,
    read: async (q) => {
      reads.push(q)
      const entries = LINES.filter(
        (e) =>
          (q.deviceId === undefined || e.tags?.['deviceId'] === q.deviceId) &&
          (q.fromAddonId === undefined || e.tags?.['addonId'] === q.fromAddonId) &&
          (q.since === undefined || e.timestamp >= q.since),
      )
      return { entries, nextBefore: null, nextAfter: null, scannedBytes: 0, done: true }
    },
  }
}

interface Logged {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly meta: Record<string, unknown>
}

/** Read the one entry of a classic ZIP through its central directory. */
function unzipSingle(zip: Buffer): { name: string; text: string; crc: number } {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThan(-1)
  const dir = zip.readUInt32LE(eocd + 16)
  expect(zip.readUInt32LE(dir)).toBe(0x02014b50)
  const crc = zip.readUInt32LE(dir + 16)
  const compressed = zip.readUInt32LE(dir + 20)
  const nameLength = zip.readUInt16LE(dir + 28)
  const name = zip.subarray(dir + 46, dir + 46 + nameLength).toString('utf8')
  const local = zip.readUInt32LE(dir + 42)
  const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
  const text = zlib.inflateRawSync(zip.subarray(dataStart, dataStart + compressed)).toString('utf8')
  return { name, text, crc }
}

describe('GET /api/logs/export', () => {
  let app: FastifyInstance
  let reads: LogReadQuery[]
  let logged: Logged[]

  beforeEach(async () => {
    app = Fastify()
    reads = []
    logged = []
    const logger: LogsExportLogger = {
      info: (message, c) => logged.push({ level: 'info', message, meta: c?.meta ?? {} }),
      warn: (message, c) => logged.push({ level: 'warn', message, meta: c?.meta ?? {} }),
    }
    const dest = destination(reads)
    registerLogsExportRoute(app, {
      verifier: {
        verifyToken: (token) => {
          if (token === ADMIN) return { isAdmin: true }
          if (token === VIEWER) return { isAdmin: false }
          throw new Error('bad token')
        },
      },
      registry: { getCollectionEntries: () => [['winston-logging', dest]] },
      tail: { query: () => [] },
      logger,
      now: () => NOW,
    })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('refuses a missing token and a non-admin', async () => {
    expect((await app.inject({ url: LOGS_EXPORT_PATH })).statusCode).toBe(401)
    const viewer = await app.inject({
      url: LOGS_EXPORT_PATH,
      headers: { authorization: `Bearer ${VIEWER}` },
    })
    expect(viewer.statusCode).toBe(403)
    expect(reads).toHaveLength(0)
  })

  it('refuses a bad device id before reading anything', async () => {
    const res = await app.inject({
      url: `${LOGS_EXPORT_PATH}?deviceIds=front-door`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(400)
    expect(reads).toHaveLength(0)
  })

  it('defaults to everything over the last six hours, as an NDJSON attachment', async () => {
    const res = await app.inject({
      url: LOGS_EXPORT_PATH,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-ndjson')
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="camstack-logs-.*\.ndjson"/,
    )
    expect(reads[0]).toMatchObject({ since: NOW - 6 * 60 * MIN, until: NOW })
    expect(reads[0]?.deviceId).toBeUndefined()
    expect(reads[0]?.fromAddonId).toBeUndefined()
    const rows = res.body
      .trim()
      .split('\n')
      .map((t) => JSON.parse(t))
    expect(rows.map((r) => r.id)).toEqual(['a-d7', 'b-d7', 'a-d8'])
    expect(logged).toEqual([
      expect.objectContaining({ level: 'info', message: 'log export completed' }),
    ])
    expect(logged[0]?.meta).toMatchObject({ status: 'completed', lines: 3, truncated: false })
  })

  it('exports the whole log with no component and no device selected', async () => {
    const res = await app.inject({
      url: `${LOGS_EXPORT_PATH}?since=${String(NOW - 24 * 60 * MIN)}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.trim().split('\n')).toHaveLength(3)
    expect(reads).toHaveLength(1)
    expect(reads[0]?.fromAddonId).toBeUndefined()
    expect(reads[0]?.deviceId).toBeUndefined()
  })

  it('zip=1 answers one .zip whose entry is the same NDJSON as the plain export', async () => {
    const plain = await app.inject({
      url: `${LOGS_EXPORT_PATH}?components=a`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    const res = await app.inject({
      url: `${LOGS_EXPORT_PATH}?components=a&zip=1`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toMatch(/filename="camstack-logs-.*\.zip"/)
    const entry = unzipSingle(res.rawPayload)
    expect(entry.name).toMatch(/^camstack-logs-.*\.ndjson$/)
    expect(entry.text).toBe(plain.body)
    expect(entry.crc).toBe(zlib.crc32(Buffer.from(plain.body, 'utf8')))
    expect(logged[1]?.meta).toMatchObject({ status: 'completed', zip: true })
  })

  it('zip=1 on the unfiltered export holds every line', async () => {
    const res = await app.inject({
      url: `${LOGS_EXPORT_PATH}?zip=1`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(unzipSingle(res.rawPayload).text.trim().split('\n')).toHaveLength(3)
  })

  it('component and device filters reach the source; every line keeps its deviceId tag', async () => {
    const res = await app.inject({
      url: `${LOGS_EXPORT_PATH}?components=a&deviceIds=7,8`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    const rows = res.body
      .trim()
      .split('\n')
      .map((t) => JSON.parse(t))
    expect(rows.map((r) => r.id)).toEqual(['a-d7', 'a-d8'])
    expect(rows.map((r) => r.tags.deviceId)).toEqual(['7', '8'])
    expect(reads.map((q) => [q.fromAddonId, q.deviceId])).toEqual([
      ['a', 7],
      ['a', 8],
    ])
  })
})

describe('collectLogExport', () => {
  async function* entries(n: number): AsyncGenerator<LogReadEntry> {
    for (let i = 0; i < n; i += 1) yield line(`e${String(i)}`, i, { deviceId: i })
  }

  function sink(accept: boolean): LogExportSink & { readonly written: string[] } {
    const written: string[] = []
    const listeners = new Map<string, () => void>()
    return {
      written,
      destroyed: false,
      writableLength: 0,
      write: (chunk) => {
        written.push(Buffer.from(chunk).toString('utf8'))
        return accept
      },
      end: () => undefined,
      destroy: () => undefined,
      on: (event, listener) => listeners.set(event, listener),
      off: (event) => listeners.delete(event),
    }
  }

  it('stops at the cap and says so in a last line', async () => {
    const out = sink(true)
    const result = await collectLogExport({ entries: entries(5), sink: out, maxEntries: 2 })
    expect(result).toMatchObject({ status: 'completed', lines: 2, truncated: true })
    expect(out.written).toHaveLength(3)
    expect(JSON.parse(out.written[2] ?? '{}')).toMatchObject({ truncated: true, maxEntries: 2 })
  })

  it('cuts a client that stops reading after the grace, without reading on', async () => {
    const out = sink(false)
    const result = await collectLogExport({ entries: entries(5), sink: out, graceMs: 5 })
    expect(result).toMatchObject({ status: 'drain-timeout', lines: 1 })
    expect(out.written).toHaveLength(1)
  })
})
