/**
 * Signed, externally-reachable URLs for notification artifacts.
 *
 * WHY this exists: the dispatcher only ever produced attachment BYTES, and the
 * degrade engine drops a bytes-only attachment for a `mode:'url'` target
 * (`attachment:noUrl`) — so WhatsApp and gotify received no media at all,
 * silently. A URL also lets an oversized attachment degrade to a link instead
 * of being dropped on `maxBytes`.
 *
 * Two decisions the shape depends on:
 *
 *  - **Signed, not authenticated.** The fetcher is a notifier BACKEND (or the
 *    recipient's phone) — it holds no session and no admin token. The route is
 *    therefore `access:'public'` and the authority is the signature: an
 *    unguessable HMAC over `(id, exp)` with a per-install secret, expiring on
 *    its own. Nothing else about the install is reachable through it. The HMAC
 *    is the shared one in `@camstack/types/node` — this module used to restate
 *    it, as did the Home Assistant media plane, and two copies of a signing
 *    scheme is how one of them quietly loses its expiry check.
 *  - **The base URL is CHOSEN, never assumed.** A notification carrying
 *    `http://127.0.0.1:...` is useless (the Alexa `hubUrl` bug, again). The
 *    ranked endpoint list the `local-network` cap already computes — public
 *    tunnel > mesh > LAN, loopback last — is the authority, and loopback is
 *    refused outright rather than shipped as a broken link.
 */
import { signExpiringUrl, verifyExpiringUrl } from '@camstack/types/node'

/** One candidate base URL, as `local-network.getConnectionEndpoints` returns it. */
export interface ArtifactEndpoint {
  readonly baseUrl: string
  readonly kind: 'lan-ipv4' | 'lan-ipv6' | 'public' | 'loopback'
  readonly priority: number
}

/**
 * Pick the base URL an artifact link should use: the LOWEST-priority-number
 * endpoint that is not loopback (the list is already ranked public > mesh >
 * LAN > loopback). `null` when only loopback is available — a link nobody
 * outside the host could open is worse than no link, because the notification
 * would arrive advertising media that 404s.
 */
export function pickArtifactBaseUrl(endpoints: readonly ArtifactEndpoint[]): string | null {
  const usable = endpoints
    .filter((e) => e.kind !== 'loopback')
    .toSorted((a, b) => a.priority - b.priority)
  return usable[0]?.baseUrl ?? null
}

/** The query params a signed artifact URL carries. */
export interface ArtifactSignature {
  readonly exp: number
  readonly sig: string
}

/**
 * Sign `(id, exp)` — the exact string the verifier recomputes.
 *
 * Delegates to the one derivation in `@camstack/types/node`. This used to
 * restate the HMAC locally, and so did the Home Assistant media plane, on the
 * correct reasoning that addons never import each other — but two copies of a
 * signing scheme is how one of them ends up with a different expiry check that
 * nothing catches.
 */
export function signArtifact(secret: string, id: string, expMs: number): string {
  return signExpiringUrl(secret, id, expMs)
}

/**
 * Build the fully-qualified, signed URL for an artifact.
 * `baseUrl` comes from {@link pickArtifactBaseUrl}, `routePrefix` from the
 * data-plane handle (`/addon/<addonId>/nc-artifact`).
 */
export function buildArtifactUrl(input: {
  readonly baseUrl: string
  readonly routePrefix: string
  readonly id: string
  readonly secret: string
  readonly expMs: number
}): string {
  const sig = signArtifact(input.secret, input.id, input.expMs)
  const base = input.baseUrl.endsWith('/') ? input.baseUrl.slice(0, -1) : input.baseUrl
  const prefix = input.routePrefix.startsWith('/') ? input.routePrefix : `/${input.routePrefix}`
  return `${base}${prefix}/${encodeURIComponent(input.id)}?exp=${input.expMs}&sig=${sig}`
}

/**
 * Verify a request's `(id, exp, sig)`. Constant-time on the signature so a
 * public route cannot be probed for it byte by byte, and expiry-checked before
 * the compare so an expired link is rejected even with a valid signature.
 */
export function verifyArtifactSignature(input: {
  readonly secret: string
  readonly id: string
  readonly exp: number
  readonly sig: string
  readonly nowMs: number
}): boolean {
  return verifyExpiringUrl(input)
}
