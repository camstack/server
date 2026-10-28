/**
 * A urlencoded form body, kept as the bytes the client sent.
 *
 * The hub parses `application/x-www-form-urlencoded` into an object for its own
 * routes (OAuth2 consent / token). An addon data plane must instead receive the
 * EXACT bytes: re-serialising the parsed object (duplicate keys collapsed,
 * encoding normalised, or worse, JSON under a form content-type) breaks a
 * vendor sign-in page proxied through the data plane. The parser records the
 * raw bytes per request; the data-plane branch replays them.
 */
import type { IncomingMessage } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import type { FastifyInstance } from 'fastify'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

const rawFormBodies = new WeakMap<IncomingMessage, Buffer>()

/** Parse a urlencoded body string into a plain object (duplicate keys collapse). */
export function parseFormBody(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(raw).entries()) {
    result[key] = value
  }
  return result
}

/** Register the urlencoded parser: the parsed object for hub routes, the raw bytes on the side. */
export function registerFormBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(FORM_CONTENT_TYPE, { parseAs: 'buffer' }, (req, body, done) => {
    try {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
      rawFormBodies.set(req.raw, bytes)
      done(null, parseFormBody(bytes.toString('utf8')))
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)), undefined)
    }
  })
}

/**
 * The bytes a data-plane upstream receives. Never a re-serialised object: a
 * parsed body with no recorded raw bytes is a bug path, logged (no values) and
 * refused with `null`.
 */
export function dataPlaneReplayBody(
  raw: IncomingMessage,
  body: unknown,
  logger: IScopedLogger,
): Buffer | undefined | null {
  if (body === undefined) return undefined
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  const recorded = rawFormBodies.get(raw)
  if (recorded !== undefined) return recorded
  // A JSON body is re-serialised from its parsed object (Fastify's JSON parser
  // keeps no bytes); every other parsed object has lost its original encoding.
  const contentType = String(raw.headers['content-type'] ?? '')
  if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    return Buffer.from(JSON.stringify(body))
  }
  logger.error('data-plane request body was parsed but its raw bytes were not recorded', {
    tags: { contentType: String(raw.headers['content-type'] ?? ''), url: raw.url ?? '' },
  })
  return null
}
