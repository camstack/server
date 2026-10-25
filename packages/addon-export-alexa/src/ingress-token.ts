/**
 * Ingress token — a rotatable shared secret that the user-owned Alexa Lambda
 * presents (header `X-CamStack-Ingress`) on its server-to-server calls to this
 * hub (`/directive`, `/oauth/lwa-tokens`). It is an ADDITIONAL defense-in-depth
 * layer on top of the per-user OAuth bearer token — not a replacement: a leaked
 * OAuth token alone won't pass when enforcement is on, and unauthenticated
 * scanners hitting the public endpoint are rejected before any OAuth work.
 *
 * Mirrors the stream-broker frame-transport auth primitives
 * (`packages/addon-pipeline/src/stream-broker/frame-transport/auth.ts`):
 * `crypto.randomBytes(32)` entropy + `crypto.timingSafeEqual` constant-time
 * comparison. Here the secret is an opaque value persisted in addon config and
 * rotated by regeneration (no HMAC/expiry — the operator pastes it into the
 * Lambda once, regenerating invalidates the old value).
 *
 * Could be unified with the stream-broker primitives into a shared
 * `@camstack/system` util — kept local for now to avoid a system-package rebuild
 * during this batch (see the completion spec).
 */
import * as crypto from 'node:crypto'

/** Generate a fresh high-entropy opaque ingress token (256-bit, base64url). */
export function generateIngressToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Constant-time string equality (length-safe). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Compare against self so the work is independent of which input is longer,
    // then fail — avoids leaking length via timing on the fast path.
    crypto.timingSafeEqual(ab, ab)
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Validate a provided ingress token against the expected secret.
 * - `expected` empty ⇒ no token configured, nothing to check ⇒ `true`.
 * - `provided` missing while `expected` is set ⇒ `false`.
 */
export function verifyIngressToken(expected: string, provided: string | undefined): boolean {
  if (expected.length === 0) return true
  if (!provided) return false
  return timingSafeEqualStr(expected, provided)
}

/** Header the Lambda sends the ingress token on. Lower-cased for Node/Fastify. */
export const INGRESS_HEADER = 'x-camstack-ingress'

/** Read the ingress header from an addon request's headers, case-insensitively. */
export function readIngressHeader(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === INGRESS_HEADER) return value
  }
  return undefined
}

/** Characters of a secret a mask may keep, so an operator can tell two apart. */
const MASK_TAIL = 4

/**
 * A secret as a READ surface may show it: a fixed run of dots and, for a value
 * long enough that four characters do not meaningfully shorten a guess, its
 * last four. Every read of this addon's status goes through this (S2) — the
 * value itself is handed out only by the admin-only `revealIngressToken`.
 */
export function maskSecretTail(secret: string): string {
  if (secret.length === 0) return ''
  if (secret.length <= MASK_TAIL * 4) return '••••'
  return `••••••••${secret.slice(-MASK_TAIL)}`
}
