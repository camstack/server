/**
 * Signed, expiring media links.
 *
 * Images never cross the push transport. Home Assistant is handed a URL
 * and fetches the bytes itself, on demand, which is what keeps a camera
 * with a `last_image` entity from turning every detection into a
 * multi-megabyte POST.
 *
 * The link is signed rather than protected by a session, because the
 * fetcher is HA's own frontend or a phone — neither of which holds a
 * camstack token.
 *
 * The HMAC itself is NOT restated here. It used to be — this module and the
 * notification artifact plane each carried their own copy, because addons never
 * import each other and neither could reach the other's. That reasoning was
 * right and the conclusion was wrong: both now delegate to the single
 * derivation in `@camstack/types/node`, which every addon may depend on. What
 * stays local is policy — the TTL below, and the id this plane signs.
 *
 * Expiry is checked BEFORE the constant-time compare (in the shared verifier):
 * an expired link is refused whether or not its signature is valid, so a leaked
 * URL stops working on its own.
 */
import { signExpiringUrl, verifyExpiringUrl } from '@camstack/types/node'

/** The `internal` slice of `local-network.getAddresses()` the media base reads. */
export interface InternalAddressAnswer {
  readonly roles: { readonly internal: { readonly resolved: string | null } }
}

/**
 * The base a media link is minted on when the operator left the addon's own
 * field empty: the hub's `internal` role (D734) — the address flagged
 * "Internal" on the Network page, else the detected LAN address. Home
 * Assistant is a LAN device pulling from the hub, so never the public
 * endpoint, and never loopback (`null` when nothing qualifies).
 */
export function haMediaBaseUrl(book: InternalAddressAnswer): string | null {
  return book.roles.internal.resolved
}

/** How long a minted link stays valid. Long enough for HA to render it. */
export const MEDIA_URL_TTL_MS = 6 * 60 * 60 * 1000

export function signMedia(secret: string, id: string, expMs: number): string {
  return signExpiringUrl(secret, id, expMs)
}

export interface BuildMediaUrlInput {
  readonly baseUrl: string
  readonly routePrefix: string
  readonly id: string
  readonly secret: string
  readonly expMs: number
}

export function buildMediaUrl(input: BuildMediaUrlInput): string {
  const base = input.baseUrl.replace(/\/+$/, '')
  const sig = signMedia(input.secret, input.id, input.expMs)
  return `${base}${input.routePrefix}/${encodeURIComponent(input.id)}?exp=${input.expMs}&sig=${sig}`
}

export interface VerifyMediaInput {
  readonly secret: string
  readonly id: string
  readonly exp: string | undefined
  readonly sig: string | undefined
  readonly nowMs: number
}

export function verifyMediaSignature(input: VerifyMediaInput): boolean {
  return verifyExpiringUrl(input)
}
