/**
 * The hub address a BROWSER comes back to — an OIDC callback, the WebAuthn relying party — when the operator left the addon's own
 * field empty.
 *
 * It used to be the `CAMSTACK_HUB_PUBLIC_URL` environment variable. The hub's
 * address is not an environment fact: the `local-network` capability owns it
 * (interfaces, listen port, allowlist, tunnel, mesh — the admin Network page),
 * and `getAddresses().roles.publicEndpoint` is the one reading: the address
 * flagged "Public endpoint" on the Network page when there is one, else the
 * public tunnel, then the mesh, then the LAN. `null` when the cap is
 * unreachable or names nothing a browser can open; the caller keeps its
 * `localhost` development default for that case.
 */
import type { HubAddressBook, IScopedLogger } from '@camstack/types'

/** The slice of `ctx.api.localNetwork` this reads. */
export interface LocalNetworkEndpointsQuery {
  readonly getAddresses: {
    query(): Promise<HubAddressBook>
  }
}

export async function hubBrowserOrigin(
  localNetwork: LocalNetworkEndpointsQuery,
  logger: IScopedLogger,
): Promise<string | null> {
  try {
    return (await localNetwork.getAddresses.query()).roles.publicEndpoint.resolved
  } catch (err: unknown) {
    logger.warn('hub address unavailable from local-network — using the localhost default', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return null
  }
}
