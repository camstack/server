/**
 * D3 — resilient cross-process capability call.
 *
 * The `$hub.registerNode` handshake registers a cap proxy the moment the
 * RPC lands — decoupled from Moleculer's service-discovery INFO packet,
 * which propagates separately. A call through the proxy in that window
 * fails with `ServiceNotFoundError`. This wraps a `broker.call` so that,
 * on a discovery error, it waits for Moleculer to discover the service
 * (the framework-native `waitForServices` primitive) and retries ONCE.
 * Happy path (service already discovered) pays nothing. If the service
 * genuinely never appears, `waitForServices` rejects → fail-fast.
 */

/** Minimal broker surface this helper needs. */
export interface ServiceDiscoveryBroker {
  call(
    action: string,
    params: unknown,
    opts: { nodeID?: string; timeout?: number },
  ): Promise<unknown>
  waitForServices(services: string[], timeout?: number): Promise<unknown>
}

/** Moleculer error `type` values meaning "the service is not (yet) routable". */
const DISCOVERY_ERROR_TYPES = new Set(['SERVICE_NOT_FOUND', 'SERVICE_NOT_AVAILABLE'])

/** Default ceiling for the discovery wait — fail-fast past this. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000

function isDiscoveryError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const type = (err as { type?: unknown }).type
  return typeof type === 'string' && DISCOVERY_ERROR_TYPES.has(type)
}

/**
 * Call a Moleculer action; on a service-discovery error, wait for the
 * named service to be discovered and retry the call exactly once.
 */
export async function callWithServiceDiscovery(
  broker: ServiceDiscoveryBroker,
  serviceName: string,
  action: string,
  params: unknown,
  opts: { nodeID?: string; timeout?: number },
  discoveryTimeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS,
): Promise<unknown> {
  try {
    return await broker.call(action, params, opts)
  } catch (err) {
    if (!isDiscoveryError(err)) throw err
    await broker.waitForServices([serviceName], discoveryTimeoutMs)
    return await broker.call(action, params, opts)
  }
}
