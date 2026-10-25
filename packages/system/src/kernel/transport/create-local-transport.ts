import { localEndpointPath } from './local-endpoint-path.js'
import { UdsLocalTransportServer, UdsLocalTransportClient } from './uds-local-transport.js'
import type { LocalTransportFactory } from './local-transport.js'

/**
 * The extension seam. UDS is the only shipped implementation; a future
 * transport implements `LocalTransportFactory` and is selected here (e.g. via
 * a `CAMSTACK_LOCAL_TRANSPORT` env) without touching any consumer.
 */
export function createLocalTransport(): LocalTransportFactory {
  return {
    createServer: (nodeId) => new UdsLocalTransportServer(localEndpointPath(nodeId)),
    createClient: (nodeId) => new UdsLocalTransportClient(localEndpointPath(nodeId)),
  }
}
