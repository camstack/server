/**
 * The base URL an AGENT pulls staged bytes from (addon bundles, models) — and
 * the hub's other self-addressed URLs — derived from the `local-network`
 * capability, never from an environment variable.
 *
 * This used to be `process.env.CAMSTACK_HUB_PUBLIC_URL ?? 'https://127.0.0.1:4443'`.
 * The desktop app has no field for that variable and the container template
 * marked it optional, so a Mac hub and any container started without it handed
 * every agent its OWN loopback: each addon deploy and model distribution to an
 * agent failed with "connection refused" on the agent, which read as a network
 * fault. The hub already knows the answer — its interfaces, its listen port,
 * the operator's allowlist (Network page) — so the variable is gone and the
 * answer comes from the one place that owns it (`local-network.getAddresses`:
 * the address flagged for the role on the Network page, else the automatic
 * pick — `resolveInternalAddress` / `resolvePublicEndpoint`).
 *
 * Loopback is never handed out. When the palette has nothing an agent can
 * reach, the delivery fails with a reason that names the Network page, instead
 * of shipping an address that names the agent itself.
 */
import type { HubAddressBook } from '@camstack/types'

/** The roles this module resolves. */
export type HubSelfAddressRole = 'internal' | 'publicEndpoint'

/**
 * The slice of the `local-network` provider this needs. `getAddresses`
 * already applies the operator's Network-page role flag before the automatic
 * pick — this module never re-ranks.
 */
export interface LocalNetworkEndpointsSource {
  getAddresses(input?: { readonly scheme?: 'http' | 'https' }): Promise<HubAddressBook>
}

/** Thrown when the hub cannot name an address `audience` can reach. */
export class HubAddressUnavailableError extends Error {
  constructor(
    readonly audience: HubSelfAddressRole,
    readonly reason: 'local-network-unavailable' | 'no-reachable-endpoint',
  ) {
    super(
      reason === 'local-network-unavailable'
        ? `cannot name this hub's ${audience} address: the local-network capability is not available yet`
        : `cannot name this hub's ${audience} address: Network lists no reachable LAN address ` +
            '(flag an address for this in Settings → Network, or check the allowed addresses)',
    )
    this.name = 'HubAddressUnavailableError'
  }
}

/**
 * Resolve the hub's base URL for `audience` from the live provider. Called per
 * delivery — interfaces and the allowlist move, and a deploy is rare enough
 * that a cache would only add a way to be stale.
 */
export async function resolveHubBaseUrl(
  getSource: () => LocalNetworkEndpointsSource | null,
  audience: HubSelfAddressRole,
): Promise<string> {
  const source = getSource()
  if (source === null) throw new HubAddressUnavailableError(audience, 'local-network-unavailable')
  const baseUrl = (await source.getAddresses({})).roles[audience].resolved
  if (baseUrl === null) throw new HubAddressUnavailableError(audience, 'no-reachable-endpoint')
  return baseUrl
}

/** The `() => Promise<string>` every agent-delivery path takes. */
export type ClusterBaseUrlResolver = () => Promise<string>

export function clusterBaseUrlResolver(
  getSource: () => LocalNetworkEndpointsSource | null,
): ClusterBaseUrlResolver {
  return () => resolveHubBaseUrl(getSource, 'internal')
}
