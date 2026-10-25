/**
 * The ONE derivation of "a signed, expiring URL".
 *
 * This repo mints unguessable, self-expiring links in three places now — the
 * notification artifact plane, the Home Assistant media plane, and the snapshot
 * link plane. The first two grew independently and are byte-identical logic
 * (`hmac(secret, "<id>:<exp>")`, expiry checked before a constant-time compare),
 * each restating the crypto locally because **addons never import each other**.
 *
 * That reason is real, and the conclusion drawn from it was wrong. Two copies of
 * a signing scheme is how one of them quietly ends up with a different TTL, a
 * different compare, or a missing expiry check, and nothing fails until a link
 * that should have died keeps working. The fix is the same one D52 applies to
 * crop geometry: one derivation, in a place every addon may depend on. A
 * framework package is exactly that place — `@camstack/types/node`, off the root
 * entry because `node:crypto` must never be traversed by a browser bundler.
 *
 * What this module deliberately does NOT decide: the TTL, the base URL, the
 * shape of `id`, and the access level of the route. Those are per-plane policy
 * and each caller states them where a reader can see them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The signature over `(id, expMs)`.
 *
 * `id` is whatever the plane uses to name the thing being served — an artifact
 * id, a track id, a `<deviceId>:<width>` pair. It is joined with `:` so a caller
 * must not put a `:` inside a field whose boundary matters; where a plane has
 * more than one field, it composes them itself and owns that ambiguity.
 */
export function signExpiringUrl(secret: string, id: string, expMs: number): string {
  return createHmac('sha256', secret)
    .update(`${id}:${String(expMs)}`)
    .digest('hex')
}

export interface VerifyExpiringUrlInput {
  readonly secret: string
  readonly id: string
  /** Raw query value — a string off the wire, or already a number. */
  readonly exp: string | number | undefined
  readonly sig: string | undefined
  readonly nowMs: number
}

/**
 * Verify a request's `(id, exp, sig)`.
 *
 * **Expiry is checked BEFORE the compare**, so an expired link is refused
 * whether or not its signature is valid — a leaked URL stops working on its own
 * and cannot be kept alive by holding a correct signature. The compare itself is
 * constant-time so a public route cannot be probed for the signature byte by
 * byte.
 */
export function verifyExpiringUrl(input: VerifyExpiringUrlInput): boolean {
  const { secret, id, exp, sig, nowMs } = input
  if (exp === undefined || sig === undefined) return false
  const expMs = typeof exp === 'number' ? exp : Number(exp)
  if (!Number.isFinite(expMs)) return false
  if (expMs <= nowMs) return false
  const expected = signExpiringUrl(secret, id, expMs)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(sig, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
