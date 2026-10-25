/**
 * Authenticated client-log ingest for the connected viewer app.
 *
 * The mobile/web viewer batches its in-app logs and POSTs them here; each entry
 * is forwarded to the hub logger (with `meta.source`) so it lands in winston and
 * the admin logs query. Hosted on the stream-broker data-plane because it already
 * serves authenticated routes and ships via `camstack deploy` (no core/hub
 * restart). Best-effort: never throws, bounds the body size, ignores malformed
 * entries. Carries diagnostic strings only — no media, token gated by the hub.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 512 * 1024

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ClientLogEntry {
  readonly ts: number
  readonly level: ClientLogLevel
  readonly scope: string
  readonly msg: string
  readonly data?: unknown
}

/** Camera identity carried inside an entry's `data` (the embed stamps it via
 *  `setLogDeviceTag`). Lifted into `tags.deviceId` by the forwarder so client
 *  log lines resolve at CAMERA level in winston/the admin logs query. */
export function entryDeviceId(e: ClientLogEntry): number | undefined {
  if (e.data === null || typeof e.data !== 'object') return undefined
  const id = (e.data as Record<string, unknown>).deviceId
  return typeof id === 'number' && Number.isFinite(id) ? id : undefined
}

function coerceEntry(v: unknown): ClientLogEntry | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const level = o.level
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return null
  return {
    ts: typeof o.ts === 'number' ? o.ts : 0,
    level,
    scope: typeof o.scope === 'string' ? o.scope : '?',
    msg: typeof o.msg === 'string' ? o.msg : '',
    data: o.data,
  }
}

/** Build a POST handler that parses `{ source?, entries: ClientLogEntry[] }`
 *  (or a bare entries array) and forwards the validated entries to `onEntries`. */
export function createClientLogIngest(
  onEntries: (entries: readonly ClientLogEntry[], source: string) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      let ingested = 0
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const obj =
          parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        const rawEntries: unknown[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(obj?.entries)
            ? (obj.entries as unknown[])
            : []
        const source = obj && typeof obj.source === 'string' ? obj.source : 'app'
        const entries: ClientLogEntry[] = []
        for (const r of rawEntries) {
          const e = coerceEntry(r)
          if (e) entries.push(e)
        }
        ingested = entries.length
        if (entries.length) onEntries(entries, source)
      } catch {
        /* malformed — ignore */
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, ingested }))
    })
    req.on('error', () => {
      try {
        res.statusCode = 400
        res.end()
      } catch {
        /* noop */
      }
    })
  }
}
