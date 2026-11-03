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
import { CALLER_USERNAME_HEADER } from '@camstack/types'
import { z } from 'zod'

const MAX_BODY_BYTES = 512 * 1024

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ClientLogEntry {
  readonly ts: number
  readonly level: ClientLogLevel
  readonly scope: string
  readonly msg: string
  readonly data?: unknown
}

/** One short token: what a client may say about itself. Anything else is dropped, not trimmed into shape. */
const ClientToken = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.+:@/-]+$/)

/**
 * What the batch says about the app that shipped it, all optional so an old
 * viewer (which sends none of it) is still accepted. The USER is deliberately
 * not here: it comes from the hub's auth (`x-camstack-user`), never the body.
 */
export const ClientLogContextSchema = z.object({
  platform: ClientToken.optional(),
  appVersion: ClientToken.optional(),
  /** A per-launch id the viewer mints once. */
  sessionId: ClientToken.optional(),
})

/** Who shipped a batch: the authenticated user (header) and the client's own account of itself. */
export interface ClientLogIdentity {
  readonly user: string | null
  readonly platform: string | null
  readonly appVersion: string | null
  readonly sessionId: string | null
}

/** The typed tags every viewer line carries; an unknown part is omitted, never a placeholder. */
export function clientLogTags(identity: ClientLogIdentity): {
  readonly source: 'viewer'
  readonly user?: string
  readonly platform?: string
  readonly appVersion?: string
  readonly clientSessionId?: string
} {
  return {
    source: 'viewer',
    ...(identity.user !== null ? { user: identity.user } : {}),
    ...(identity.platform !== null ? { platform: identity.platform } : {}),
    ...(identity.appVersion !== null ? { appVersion: identity.appVersion } : {}),
    ...(identity.sessionId !== null ? { clientSessionId: identity.sessionId } : {}),
  }
}

function headerUser(req: IncomingMessage): string | null {
  const raw = req.headers[CALLER_USERNAME_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = z.string().min(1).max(384).safeParse(value)
  if (!parsed.success) return null
  // The hub percent-encodes it (a header carries no raw non-ASCII).
  try {
    return decodeURIComponent(parsed.data).slice(0, 128)
  } catch {
    return null
  }
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

/** Build a POST handler that parses `{ source?, client?, entries: ClientLogEntry[] }`
 *  (or a bare entries array) and forwards the validated entries, with who shipped
 *  them, to `onEntries`. */
export function createClientLogIngest(
  onEntries: (
    entries: readonly ClientLogEntry[],
    source: string,
    identity: ClientLogIdentity,
  ) => void,
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
        const context = ClientLogContextSchema.safeParse(obj?.client)
        const identity: ClientLogIdentity = {
          user: headerUser(req),
          platform: (context.success ? context.data.platform : undefined) ?? null,
          appVersion: (context.success ? context.data.appVersion : undefined) ?? null,
          sessionId: (context.success ? context.data.sessionId : undefined) ?? null,
        }
        if (entries.length) onEntries(entries, source, identity)
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
