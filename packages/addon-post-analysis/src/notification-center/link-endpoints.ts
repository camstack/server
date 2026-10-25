/**
 * link-endpoints — which hub address every link a notification carries is
 * built on, EXCEPT the tap: action buttons, attachment / media links, and the
 * admin page a system event taps into.
 *
 * D734: those links must work from outside the home network, so they follow
 * the hub's **Public endpoint** role (`local-network.getAddresses().roles
 * .publicEndpoint`). The **Notification taps** role
 * (`getNotificationEndpoint`) is deliberately not read here: it decides only
 * where a tap opens, and its default — the CamStack app link — is no hub
 * address a signed link could resolve on. Before D734 these links followed the
 * notifications address first, so flagging a LAN address for taps quietly
 * moved every button and attachment onto the LAN.
 *
 * When `local-network` cannot answer, the ladder falls back to the connected
 * ingress and the LAN (`collectArtifactEndpoints`), and says so.
 */
import type { ConnectionEndpoint, IScopedLogger } from '@camstack/types'
import { collectArtifactEndpoints } from './artifact-plane.js'
import type { ArtifactEndpoint } from './artifact-url.js'

/** The `publicEndpoint` slice of `getAddresses()` this reads. */
export interface NcPublicEndpointAnswer {
  readonly roles: { readonly publicEndpoint: { readonly resolved: string | null } }
}

export interface NcIngressEndpoint {
  readonly url: string
  readonly protocol: string
}

export interface NcIngressStatus {
  readonly connected: boolean
  readonly endpoint: NcIngressEndpoint | null
}

// Type aliases, not interfaces: the generated tRPC inputs carry an index
// signature, which an object type alias satisfies and an interface does not.
export type NcPortInput = { readonly port: number }

export type NcAddressesInput = { readonly scheme?: 'http' | 'https' }

export interface NcConnectionEndpointsAnswer {
  readonly endpoints: readonly ConnectionEndpoint[]
}

/** The slices of `ctx.api` the link ladder reads. */
export interface NcLinkEndpointApi {
  readonly localNetwork: {
    readonly getAddresses: { query(input: NcAddressesInput): Promise<NcPublicEndpointAnswer> }
    readonly getConnectionEndpoints: {
      query(input: NcPortInput): Promise<NcConnectionEndpointsAnswer>
    }
  }
  readonly networkAccess: {
    readonly getStatus: { query(): Promise<NcIngressStatus> }
    readonly listEndpoints: { query(): Promise<readonly NcIngressEndpoint[]> }
  }
}

async function publicEndpointAddress(
  api: NcLinkEndpointApi,
  logger: IScopedLogger,
): Promise<string | undefined> {
  try {
    const { roles } = await api.localNetwork.getAddresses.query({})
    return roles.publicEndpoint.resolved ?? undefined
  } catch (err) {
    logger.warn('nc links: public endpoint unreadable — using the ingress ladder', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
    return undefined
  }
}

/** The ranked base-URL candidates for a notification's non-tap links. */
export async function notificationLinkEndpoints(
  api: NcLinkEndpointApi,
  logger: IScopedLogger,
): Promise<readonly ArtifactEndpoint[]> {
  return collectArtifactEndpoints({
    publicEndpoint: await publicEndpointAddress(api, logger),
    getConnected: async () => {
      const status = await api.networkAccess.getStatus.query()
      logger.debug('artifact base-url: connected ingress', {
        meta: {
          connected: status.connected,
          url: status.endpoint?.url ?? null,
          protocol: status.endpoint?.protocol ?? null,
        },
      })
      return status.connected && status.endpoint !== null
        ? { url: status.endpoint.url, protocol: status.endpoint.protocol }
        : null
    },
    listExternal: async () => {
      const entries = await api.networkAccess.listEndpoints.query()
      return entries.map((e) => ({ url: e.url, protocol: e.protocol }))
    },
    listLan: async (port) => {
      const res = await api.localNetwork.getConnectionEndpoints.query({ port })
      // The app link is no hub address a media link or a button can be
      // minted on, and a custom address (in the palette when flagged for app
      // connections) is not a LAN candidate: a custom public endpoint already
      // leads this ladder.
      return res.endpoints.flatMap((e) =>
        e.kind === 'app-link' || e.kind === 'custom'
          ? []
          : [{ baseUrl: e.baseUrl, kind: e.kind, priority: e.priority }],
      )
    },
    logger,
  })
}
