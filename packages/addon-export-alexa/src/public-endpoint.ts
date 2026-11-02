/**
 * The hub's public HTTPS origin: the `publicEndpoint` role of the hub's `local-network`
 * palette (D729/D732/D734), and nothing else.
 *
 * No setting holds it and nothing caches it: every use reads the role again, so changing the
 * role on the Network page changes the URLs minted here on the next read. When the role
 * resolves to nothing, or cannot be read, the caller gets a typed refusal that names the
 * Network page. There is no loopback or LAN fallback: Alexa reaches this hub from its own
 * cloud, and a URL it cannot open is worse than an honest refusal.
 */

/** The `publicEndpoint` slice of `local-network.getAddresses()` this addon reads. */
export interface PublicEndpointAnswer {
  readonly roles: {
    readonly publicEndpoint: { readonly resolved: string | null }
  }
}

/** The role resolves to no address. */
export const NO_PUBLIC_ENDPOINT_REASON = {
  code: 'no-public-endpoint',
  message:
    'The hub has no public endpoint. Set up remote access (a tunnel) and flag an address as "Public endpoint" on the Network page; Alexa reaches this hub from its own cloud.',
} as const

/** The palette could not be read at all. */
export const PUBLIC_ENDPOINT_UNREADABLE_REASON = {
  code: 'public-endpoint-unreadable',
  message:
    'The hub could not read its "Public endpoint" address from the Network page; try again once the network service is up.',
} as const

export type PublicEndpointRefusal =
  | typeof NO_PUBLIC_ENDPOINT_REASON
  | typeof PUBLIC_ENDPOINT_UNREADABLE_REASON

export type PublicEndpointResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: PublicEndpointRefusal }

/** Reads the role NOW; every consumer holds one of these, never a copy of the answer. */
export type PublicEndpointReader = () => Promise<PublicEndpointResult>

/** Trailing slashes off, surrounding space off. Nothing else is rewritten. */
export const normaliseOrigin = (raw: string): string => raw.trim().replace(/\/+$/, '')

export const resolvePublicEndpoint = (book: PublicEndpointAnswer): PublicEndpointResult => {
  const resolved = book.roles.publicEndpoint.resolved
  const origin = resolved === null ? '' : normaliseOrigin(resolved)
  if (origin.length === 0) return { ok: false, reason: NO_PUBLIC_ENDPOINT_REASON }
  return { ok: true, origin }
}

/** A failed read is the unreadable refusal, never a thrown error and never an empty origin. */
export const createPublicEndpointReader =
  (read: () => Promise<PublicEndpointAnswer>): PublicEndpointReader =>
  async () => {
    try {
      return resolvePublicEndpoint(await read())
    } catch {
      return { ok: false, reason: PUBLIC_ENDPOINT_UNREADABLE_REASON }
    }
  }
