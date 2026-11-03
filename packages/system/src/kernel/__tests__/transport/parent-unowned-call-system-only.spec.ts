/**
 * A `systemMethod()` is served ONLY by the cap's system/wrapper provider. A
 * forked addon's call to one arrives at the parent-routed entry carrying a
 * `deviceId` in its args (`snapshot.getDebugState({ deviceId })`); handing that
 * id to the route resolver makes it pick the DEVICE-NATIVE owner of the cap
 * (`LocalChildRegistry.resolveChildId` prefers the exact device owner), which
 * does not implement the method. The id must be withheld from the route for a
 * system-only method, exactly as the hub's own cap router resolves it
 * (`methodMountKindFor`).
 */
import { describe, expect, it, vi } from 'vitest'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import type { CapRoute } from '../../transport/cap-route.js'
import type { CapRouteResolver } from '../../transport/cap-route-resolver.js'
import type { HubNodeRegistry } from '../../moleculer/node-registry.js'
import type { ServiceBroker } from 'moleculer'

const DEVICE = 3628
const ROUTE: CapRoute = { kind: 'hub-local-uds', capName: 'snapshot', childId: 'snapshot-wrapper' }

function build(isSystemOnlyMethod: (cap: string, method: string) => boolean) {
  const resolveCapRoute = vi.fn((): CapRoute => ROUTE)
  const dispatch = vi.fn(async () => ({ state: { isBattery: true, reason: null } }))
  const resolver = { resolveCapRoute, dispatch }
  const broker = { nodeID: 'hub', call: vi.fn(), waitForServices: vi.fn() }
  const nodeRegistry = { listNativeCapEntriesForDevice: () => [] }
  const handler = createParentUnownedCallHandler({
    // Documented test boundary: the handler only calls resolveCapRoute + dispatch.
    getResolver: () => resolver as unknown as CapRouteResolver,
    broker: broker as unknown as ServiceBroker,
    nodeRegistry: nodeRegistry as unknown as HubNodeRegistry,
    isSystemOnlyMethod,
  })
  return { handler, resolveCapRoute, dispatch }
}

describe('createParentUnownedCallHandler — a systemOnly method never routes by deviceId', () => {
  it('withholds the deviceId from the route for a systemOnly method, but still passes it as an argument', async () => {
    const { handler, resolveCapRoute, dispatch } = build(
      (cap, method) => cap === 'snapshot' && method === 'getDebugState',
    )
    await handler({
      capName: 'snapshot',
      method: 'getDebugState',
      args: { deviceId: DEVICE },
      deviceId: DEVICE,
    })
    expect(resolveCapRoute).toHaveBeenCalledWith('snapshot', {})
    expect(dispatch).toHaveBeenCalledWith(ROUTE, 'getDebugState', { deviceId: DEVICE })
  })

  it('keeps routing a regular device method by its deviceId', async () => {
    const { handler, resolveCapRoute } = build(
      (cap, method) => cap === 'snapshot' && method === 'getDebugState',
    )
    await handler({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: DEVICE },
      deviceId: DEVICE,
    })
    expect(resolveCapRoute).toHaveBeenCalledWith('snapshot', { deviceId: DEVICE })
  })
})
