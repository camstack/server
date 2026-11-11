import type { AddonHttpRequest } from '@camstack/types'
import type { AddonRouteCaller } from '../../auth/addon-route-auth.js'

/** What the hub's addon catch-all knows when it hands a request to a route handler. */
export interface AddonRouteRequestInput {
  readonly params: Record<string, string>
  readonly query: Record<string, string>
  readonly body: unknown
  readonly headers: Record<string, string>
  /** The instance the route registry resolved; set only for a per-instance route. */
  readonly instanceId: string | undefined
  /** The verified caller; absent on a public route. */
  readonly caller?: AddonRouteCaller
}

/**
 * The request an addon route handler receives. One builder for the public and
 * the authenticated branch of the catch-all, so the instance the registry
 * resolved reaches the handler on both.
 */
export function buildAddonRouteRequest(input: AddonRouteRequestInput): AddonHttpRequest {
  return {
    params: input.params,
    query: input.query,
    body: input.body,
    headers: input.headers,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    ...input.caller,
  }
}
