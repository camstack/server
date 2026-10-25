/**
 * `GET|HEAD /addon/pipeline-analytics/tape-export?tapeId=…` (D681). Admin
 * (level in `../data-plane-access.ts`). Streams the promoted tape's bundle —
 * the bytes leave through the data plane, never a cap or an action envelope
 * (the debug-export precedent). No `Accept-Ranges`: the gt part is built at
 * request time, and a resumed download could splice two versions of it.
 *
 * A tape id resolves to one of three outcomes, and they are NOT the same
 * thing (fix round 1, M1): `unknown` — no such row was ever promoted;
 * `unavailable` — the row exists, but THIS node cannot serve promoted tapes
 * at all (no shelf, no ground-truth store — an architectural absence, not a
 * missing file); `ok` — build and stream it. A node with no shelf answering
 * `404 unknown` for a tape another node's index still lists would be an
 * absence claimed from a read that never happened (D315/D393's spirit). A
 * FOURTH outcome, `read-failed` (M2), is different again: the row is known
 * and this node CAN serve tapes, but the read of THIS ONE failed — most
 * often a release or delete racing the download (ENOENT). That is a 500, not
 * a 404 and not a 503: the node is fine, the tape just isn't there anymore.
 *
 * `HEAD` answers from the index row alone (M3) — no tape read, no
 * ground-truth query — the same "without moving a byte" discipline as
 * debug-export's HEAD.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { type BundleParts, streamBundle } from '../tracking-bench/bundle.js'

export const TAPE_EXPORT_PREFIX = 'tape-export'
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000
const TAPE_ID = /^[a-z0-9][a-z0-9-]{7,63}$/

/** Shared by the cheap (`HEAD`) and full (`GET`) reads: the tape either does
 *  not exist, or exists but this node cannot serve it at all. */
export type TapeExportRefusal =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly deviceId: number | null }

/** `HEAD`'s answer: the index row's own fields, nothing read off disk. */
export type TapeBundlePeek =
  | TapeExportRefusal
  | { readonly kind: 'ok'; readonly deviceId: number; readonly scenario: string }

/** `GET`'s answer. `read-failed` is distinct from `unavailable`: the NODE can
 *  serve tapes, but THIS read did not land (see the module comment). */
export type TapeBundleLoad =
  | TapeExportRefusal
  | { readonly kind: 'read-failed'; readonly reason: string; readonly deviceId: number }
  | { readonly kind: 'ok'; readonly parts: BundleParts }

export interface TapeExportDeps {
  readonly peekTape: (tapeId: string) => Promise<TapeBundlePeek>
  readonly loadBundle: (tapeId: string) => Promise<TapeBundleLoad>
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly drainTimeoutMs?: number
}

function tapeIdOf(url: string): string | null {
  const id = new URL(url, 'http://local').searchParams.get('tapeId')
  return id !== null && TAPE_ID.test(id) ? id : null
}

function writeRefusal(
  res: ServerResponse,
  deps: TapeExportDeps,
  tapeId: string,
  refusal: TapeExportRefusal,
  body: 'empty' | 'text',
): void {
  if (refusal.kind === 'unknown') {
    deps.logger.info('tape export: unknown tape', { meta: { tapeId } })
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(body === 'text' ? 'unknown tape' : undefined)
    return
  }
  // `tags: { deviceId }` only when one is known — a node-wide refusal read
  // before the index row was resolved names no camera.
  deps.logger.warn('tape export: unavailable on this node', {
    ...(refusal.deviceId === null ? {} : { tags: { deviceId: refusal.deviceId } }),
    meta: { tapeId, reason: refusal.reason },
  })
  res.writeHead(503, { 'content-type': 'text/plain' })
  res.end(body === 'text' ? `tapes unavailable: ${refusal.reason}` : undefined)
}

export function createTapeExportHandler(deps: TapeExportDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      deps.logger.info('tape export: method not allowed', { meta: { method } })
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const tapeId = tapeIdOf(req.url ?? '')
    if (tapeId === null) {
      deps.logger.info('tape export: missing or invalid tape id', { meta: { url: req.url ?? '' } })
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('tapeId is required')
      return
    }

    if (method === 'HEAD') {
      let peek: TapeBundlePeek
      try {
        peek = await deps.peekTape(tapeId)
      } catch (err) {
        deps.logger.warn('tape export: peek failed', { meta: { tapeId, error: errMsg(err) } })
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end()
        return
      }
      if (peek.kind !== 'ok') {
        writeRefusal(res, deps, tapeId, peek, 'empty')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${peek.scenario}.tape-bundle.json.gz"`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    let load: TapeBundleLoad
    try {
      load = await deps.loadBundle(tapeId)
    } catch (err) {
      deps.logger.warn('tape export: bundle could not be built', {
        meta: { tapeId, error: errMsg(err) },
      })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('tape export failed')
      return
    }
    if (load.kind === 'unknown' || load.kind === 'unavailable') {
      writeRefusal(res, deps, tapeId, load, 'text')
      return
    }
    if (load.kind === 'read-failed') {
      deps.logger.warn('tape export: bundle could not be built', {
        tags: { deviceId: load.deviceId },
        meta: { tapeId, error: load.reason },
      })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('tape export failed')
      return
    }

    const { parts } = load
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${parts.manifest.scenario}.tape-bundle.json.gz"`,
      'cache-control': 'no-store',
    })
    await streamBundle(res, parts, {
      logger: deps.logger,
      drainTimeoutMs: deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      checkEveryMs: 1_000,
      now: deps.now,
    })
  }
}
