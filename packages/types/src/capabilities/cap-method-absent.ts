/**
 * Whether a failed cap call means the provider does not HAVE the method — an
 * optional method it never wrote, or a hub that predates it — rather than a
 * read that failed. A missing method is an answer ("not supported"); a failed
 * read is not, and only the second deserves a warning.
 */

/**
 * Prefix the hub matches to turn a child-side "declared optional, not served"
 * into a `NOT_IMPLEMENTED`. A prefix rather than an error subclass because the
 * error crosses a UDS boundary as a plain message.
 */
export const CAP_METHOD_NOT_IMPLEMENTED = 'CAP_METHOD_NOT_IMPLEMENTED'

/** tRPC's own answer for a path the hub does not mount (a hub that predates the method). */
const UNKNOWN_PROCEDURE = 'No procedure found on path'
/** `device-call-redirect` / `device-collection-dispatch`: a provider that lacks the method. */
const PROVIDER_LACKS_METHOD = 'does not implement'

/**
 * The typed code first: the hub cap router's `NOT_IMPLEMENTED` on `data.code`.
 * A forked provider's refusal crosses the UDS hop as a plain message, so it is
 * matched by the dispatcher's prefix (`CAP_METHOD_NOT_IMPLEMENTED`); the last
 * two are the routing layer's own wording.
 */
export function isCapMethodAbsent(err: unknown): boolean {
  const data: unknown =
    typeof err === 'object' && err !== null ? Reflect.get(err, 'data') : undefined
  const code: unknown =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined
  if (code === 'NOT_IMPLEMENTED') return true
  const message = err instanceof Error ? err.message : String(err)
  return [CAP_METHOD_NOT_IMPLEMENTED, UNKNOWN_PROCEDURE, PROVIDER_LACKS_METHOD].some((marker) =>
    message.includes(marker),
  )
}
