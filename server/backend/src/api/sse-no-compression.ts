/**
 * Keep SSE out of the compressor.
 *
 * `@fastify/compress` already excludes `text/event-stream` from its default
 * compressible types — but the tRPC subscription transport writes its headers
 * on the RAW response, so at `onSend` time the Fastify-level Content-Type is
 * unset and the plugin falls back to `'application/json'`
 * (`@fastify/compress/index.js`: `reply.getHeader('Content-Type') ||
 * 'application/json'`) and gzips the stream. A gzipped SSE stream never
 * errors: events sit in the compressor buffer until it fills, so a LOW-RATE
 * stream — exactly what a well-filtered consumer asks for — starves silently.
 * Measured live 2026-08-08 (Home Assistant integration bring-up): 0 events in
 * 8 s with `Accept-Encoding: gzip` vs 56 with `identity`, on the same
 * subscription.
 *
 * The fix keys on the REQUEST, which is known before any response header
 * exists: an SSE request always declares `Accept: text/event-stream`, and the
 * plugin's own documented escape hatch is the `x-no-compression` request
 * header (checked with `!== undefined` before any content-type logic). This
 * leaves every JSON tRPC response compressed exactly as before.
 */
import type { FastifyRequest } from 'fastify'

/** Mutates the request headers in place; returns whether it marked the request. */
export function markSseRequestNoCompression(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  if (typeof accept === 'string' && accept.includes('text/event-stream')) {
    request.headers['x-no-compression'] = '1'
    return true
  }
  return false
}
