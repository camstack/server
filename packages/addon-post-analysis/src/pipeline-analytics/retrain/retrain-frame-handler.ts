/**
 * Data-plane handler for ONE retrain frame's pixels.
 *
 * `/addon/<addonId>/retrain-frame/<frameId>?size=thumb|full`
 *
 * Replaces `getRetrainFrameImage` (base64 inside a tRPC answer) as the way the
 * admin UI gets a frame: a grid of N tiles used to pay N full-resolution
 * base64 envelopes, each held whole in the hub and again in the browser (D613).
 * Here the handler owns the real `ServerResponse`, the browser caches the JPEG
 * and the `<img>` costs bytes, not an RPC.
 *
 * - `size=full` (default) — the stored copy, byte for byte.
 * - `size=thumb` — the same frame re-encoded to {@link RETRAIN_THUMB_MAX_SIDE}
 *   on its longest side, for grids.
 *
 * A frame copy is immutable (its id names the bytes forever), so the response
 * carries an ETag and a long private max-age. Admin-only (level declared in
 * `../data-plane-access.ts`): a retrain frame is a camera frame the operator
 * curated, and the cap that used to serve it is `auth: 'admin'`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'

export const RETRAIN_FRAME_PREFIX = 'retrain-frame'

/** Longest side of a `size=thumb` response. */
export const RETRAIN_THUMB_MAX_SIDE = 480

export type RetrainFrameSize = 'thumb' | 'full'

const CACHE_CONTROL = 'private, max-age=31536000, immutable'

export interface RetrainFrameHandlerDeps {
  /** The copy's bytes, or `null` when the frame (or its blob) is gone. */
  readonly readFrame: (frameId: string) => Promise<Buffer | null>
  /** Re-encode to a JPEG whose longest side is at most `maxSide`. */
  readonly resize: (bytes: Buffer, maxSide: number) => Promise<Buffer>
  readonly logger: IScopedLogger
}

/** The path `getRetrainFrameUrl`-style callers compose for a frame. */
export function retrainFramePath(addonId: string, frameId: string, size: RetrainFrameSize): string {
  return `/addon/${addonId}/${RETRAIN_FRAME_PREFIX}/${encodeURIComponent(frameId)}?size=${size}`
}

/** `{ frameId, size }` from the request URL (path after the prefix), or `null`. */
export function parseRetrainFrameRequest(
  url: string,
): { readonly frameId: string; readonly size: RetrainFrameSize } | null {
  const queryAt = url.indexOf('?')
  const rawPath = queryAt === -1 ? url : url.slice(0, queryAt)
  const query = queryAt === -1 ? '' : url.slice(queryAt + 1)
  const segment = rawPath.replace(/^\/+/, '')
  if (segment === '' || segment.includes('/')) return null
  let frameId: string
  try {
    frameId = decodeURIComponent(segment)
  } catch {
    return null
  }
  if (frameId === '') return null
  const size = new URLSearchParams(query).get('size')
  if (size !== null && size !== 'thumb' && size !== 'full') return null
  return { frameId, size: size ?? 'full' }
}

export function createRetrainFrameHandler(deps: RetrainFrameHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const request = parseRetrainFrameRequest(req.url ?? '')
    if (request === null) {
      res.writeHead(404)
      res.end()
      return
    }
    const etag = `"${request.frameId}:${request.size}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': CACHE_CONTROL })
      res.end()
      return
    }
    try {
      const stored = await deps.readFrame(request.frameId)
      if (stored === null) {
        res.writeHead(404)
        res.end()
        return
      }
      const body =
        request.size === 'thumb' ? await deps.resize(stored, RETRAIN_THUMB_MAX_SIDE) : stored
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(body.byteLength),
        'cache-control': CACHE_CONTROL,
        etag,
      })
      if (method === 'HEAD') res.end()
      else res.end(body)
    } catch (err) {
      deps.logger.warn('retrain frame read failed', {
        meta: { frameId: request.frameId, size: request.size, error: String(err) },
      })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('retrain frame read failed')
    }
  }
}
