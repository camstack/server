/**
 * The hub's public HTTPS origin: the `publicEndpoint` role of the hub's
 * `local-network` palette (D729/D732/D734, D986 §5), and nothing else.
 *
 * No setting holds it and nothing caches it: every use reads the role again, so
 * changing the role on the Network page changes the URLs rendered here on the
 * next read. When the role resolves to nothing the flow refuses with a typed
 * reason that names the Network page. There is no loopback or LAN fallback:
 * Google calls from its own cloud, and a URL that cannot be reached is worse
 * than an honest refusal.
 */
import type { ExportSetup } from './types.js'

/** The `publicEndpoint` slice of `local-network.getAddresses()` this addon reads. */
export interface PublicEndpointAnswer {
  readonly roles: {
    readonly publicEndpoint: { readonly resolved: string | null }
  }
}

/** The typed refusal when the role resolves to nothing. */
export const NO_PUBLIC_ENDPOINT_REASON = {
  code: 'no-public-endpoint',
  message:
    'The hub has no public endpoint. Set up remote access (a tunnel) and flag an address as "Public endpoint" on the Network page; Google calls this hub from its own cloud.',
} as const

export type PublicEndpointResult =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: typeof NO_PUBLIC_ENDPOINT_REASON }

/** Trailing slashes off, surrounding space off. Nothing else is rewritten. */
const normaliseOrigin = (raw: string): string => raw.trim().replace(/\/+$/, '')

export const resolvePublicEndpoint = (book: PublicEndpointAnswer): PublicEndpointResult => {
  const resolved = book.roles.publicEndpoint.resolved
  const origin = resolved === null ? '' : normaliseOrigin(resolved)
  if (origin.length === 0) return { ok: false, reason: NO_PUBLIC_ENDPOINT_REASON }
  return { ok: true, origin }
}

export interface ConsoleSetupInput {
  readonly addonId: string
  readonly linkedAccounts: number
  /** Asks the hub for its address book NOW; called on every build, never memoised. */
  readonly read: () => Promise<PublicEndpointAnswer>
}

/**
 * The `device-export` setup block: the three console URLs plus the
 * linked-account count, all off the SAME origin so they cannot disagree.
 * A read that fails is the same refusal as a role that resolves to nothing.
 */
export const buildConsoleSetupFromRole = async (input: ConsoleSetupInput): Promise<ExportSetup> => {
  const linked = String(input.linkedAccounts)
  const result = await input
    .read()
    .then(resolvePublicEndpoint)
    .catch(
      (): PublicEndpointResult => ({
        ok: false,
        reason: NO_PUBLIC_ENDPOINT_REASON,
      }),
    )
  if (!result.ok) {
    return {
      note: `Refused (${result.reason.code}): ${result.reason.message}`,
      fields: [{ label: 'Linked Google accounts', value: linked }],
    }
  }
  const origin = result.origin
  return {
    note: [
      'In the Google Home Developer Console create a cloud-to-cloud integration, then paste these three URLs.',
      'The integration stays in test mode: publishing requires Google certification, which a private hub cannot obtain.',
      'This hub pushes nothing to Google — state is read by polling, so a change made outside the Home app appears on the next query, not instantly.',
      `The URLs follow the "Public endpoint" role on the Network page (${origin}).`,
    ].join('\n'),
    fields: [
      {
        label: 'Fulfillment URL',
        value: `${origin}/addon/${input.addonId}/fulfillment`,
      },
      {
        label: 'Authorization URL',
        value: `${origin}/api/oauth2/authorize?integration=${input.addonId}`,
      },
      { label: 'Token URL', value: `${origin}/api/oauth2/token` },
      { label: 'Linked Google accounts', value: linked },
    ],
  }
}
