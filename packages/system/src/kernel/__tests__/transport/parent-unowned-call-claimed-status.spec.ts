/**
 * The PARENT-ROUTED entry for a child→child `getStatus` (D663, ruling S3):
 * `createParentUnownedCallHandler` — reached when NO co-resident sibling owns
 * the cap for the device (a remote agent's device, a hub-in-process cap, a call
 * forwarded from an agent through `$hub-cap-fwd`). It routes through
 * `resolveCapRoute` STRAIGHT to the owning runner, whose `getStatus` is the
 * NATIVE slice — so before routing it asks the hub's claim authority through
 * the one shared `answerClaimedGetStatus`.
 *
 * The co-resident sibling case (an exporter calling a device owned by another
 * hub-local child) never reaches this handler: `LocalChildRegistry`
 * short-circuits it, and asks the same question there —
 * `local-child-registry-claimed-status.spec.ts` drives that production path.
 */
import { describe, expect, it, vi } from 'vitest'
import type { StatusOverlayAnswer } from '@camstack/types'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import type { CapRoute } from '../../transport/cap-route.js'
import type { CapRouteResolver } from '../../transport/cap-route-resolver.js'
import type { HubNodeRegistry, NodeNativeCapEntry } from '../../moleculer/node-registry.js'
import type { ServiceBroker } from 'moleculer'

const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED_SLICE = { ...NATIVE, percentage: 90 }
const DEVICE = 7
const OTHER_DEVICE = 8

const claimBattery7 = async (cap: string, id: number): Promise<StatusOverlayAnswer> =>
  cap === 'battery' && id === DEVICE
    ? { kind: 'claimed', slice: OWNED_SLICE }
    : { kind: 'unclaimed' }

/** No owners anywhere — the handler's device-owner lookup answers empty. */
function nodeRegistryFake(): HubNodeRegistry {
  const fake = {
    listNativeCapEntriesForDevice: (): readonly NodeNativeCapEntry[] => [],
  }
  // Structural subset the handler reads; documented test boundary as in the sibling spec.
  return fake as unknown as HubNodeRegistry
}

function brokerFake(): ServiceBroker {
  const broker = {
    nodeID: 'hub',
    call: vi.fn(async () => {
      throw new Error('broker must not be consulted')
    }),
    waitForServices: vi.fn(async () => undefined),
    registry: { getServiceList: () => [] },
  }
  return broker as unknown as ServiceBroker
}

interface ResolverFake {
  readonly resolver: CapRouteResolver
  readonly resolveCapRoute: ReturnType<typeof vi.fn>
  readonly invoked: { method: string; args: unknown }[]
}

/** A resolver whose hub-in-process route records what reached the provider. */
function routingResolver(): ResolverFake {
  const invoked: { method: string; args: unknown }[] = []
  const route: CapRoute = {
    kind: 'hub-in-process',
    capName: 'battery',
    ref: { invoke: async () => NATIVE },
  }
  const resolveCapRoute = vi.fn(() => route)
  const resolver = {
    resolveCapRoute,
    dispatch: vi.fn(async (_route: CapRoute, method: string, args: unknown) => {
      invoked.push({ method, args })
      return method === 'getStatus' ? NATIVE : { awoke: true, durationMs: 5 }
    }),
  }
  // The handler only calls resolveCapRoute + dispatch; documented test boundary.
  return { resolver: resolver as unknown as CapRouteResolver, resolveCapRoute, invoked }
}

/** A resolver that must never be reached. */
function forbiddenResolver(): ResolverFake {
  const resolveCapRoute = vi.fn(() => {
    throw new Error('resolver must not be consulted for a claimed getStatus')
  })
  const resolver = { resolveCapRoute, dispatch: vi.fn() }
  return { resolver: resolver as unknown as CapRouteResolver, resolveCapRoute, invoked: [] }
}

describe('createParentUnownedCallHandler — getStatus of a CLAIMED cap on the parent-routed entry (S3)', () => {
  it('a claimed getStatus is answered from the hub mirror; the route resolver is never consulted', async () => {
    const { resolver, resolveCapRoute } = forbiddenResolver()
    const broker = brokerFake()
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker,
      nodeRegistry: nodeRegistryFake(),
      claimedStatus: claimBattery7,
    })

    await expect(
      handler({ capName: 'battery', method: 'getStatus', args: { deviceId: DEVICE } }),
    ).resolves.toEqual(OWNED_SLICE)
    expect(resolveCapRoute).not.toHaveBeenCalled()
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('a HELD claim answers null — a real answer, never a fall-through to the native runner', async () => {
    const { resolver, resolveCapRoute } = forbiddenResolver()
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      claimedStatus: async (cap, id) =>
        cap === 'battery' && id === DEVICE
          ? { kind: 'claimed', slice: null }
          : { kind: 'unclaimed' },
    })
    await expect(
      handler({ capName: 'battery', method: 'getStatus', args: { deviceId: DEVICE } }),
    ).resolves.toBeNull()
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  it('a device whose claims cannot be known is null — never routed to the native runner (D315, D49)', async () => {
    const { resolver, resolveCapRoute } = forbiddenResolver()
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      claimedStatus: async () => ({ kind: 'unknown' }),
    })
    await expect(
      handler({ capName: 'battery', method: 'getStatus', args: { deviceId: DEVICE } }),
    ).resolves.toBeNull()
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  it('a node pin does not bypass the hub claim authority', async () => {
    const { resolver, resolveCapRoute } = forbiddenResolver()
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      claimedStatus: claimBattery7,
    })
    await expect(
      handler({
        capName: 'battery',
        method: 'getStatus',
        args: { deviceId: DEVICE },
        nodeId: 'agent-a',
      }),
    ).resolves.toEqual(OWNED_SLICE)
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  it('every OTHER method of the claimed cap, and getStatus of an unclaimed device, still route', async () => {
    const { resolver, resolveCapRoute, invoked } = routingResolver()
    const claimedStatus = vi.fn(claimBattery7)
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      claimedStatus,
    })

    await expect(
      handler({
        capName: 'battery',
        method: 'wakeForStream',
        args: { deviceId: DEVICE, timeoutMs: 1000 },
      }),
    ).resolves.toEqual({ awoke: true, durationMs: 5 })
    await expect(
      handler({ capName: 'battery', method: 'getStatus', args: { deviceId: OTHER_DEVICE } }),
    ).resolves.toEqual(NATIVE)

    expect(resolveCapRoute).toHaveBeenCalledTimes(2)
    expect(resolveCapRoute).toHaveBeenNthCalledWith(1, 'battery', { deviceId: DEVICE })
    expect(resolveCapRoute).toHaveBeenNthCalledWith(2, 'battery', { deviceId: OTHER_DEVICE })
    expect(invoked).toEqual([
      { method: 'wakeForStream', args: { deviceId: DEVICE, timeoutMs: 1000 } },
      { method: 'getStatus', args: { deviceId: OTHER_DEVICE } },
    ])
    // The unclaimed device's getStatus paid exactly one lookup; the other method paid none.
    expect(claimedStatus).toHaveBeenCalledTimes(1)
    expect(claimedStatus).toHaveBeenCalledWith('battery', OTHER_DEVICE)
  })

  it('a getStatus with NO deviceId (a system cap) never asks the claim authority', async () => {
    const { resolver } = routingResolver()
    const claimedStatus = vi.fn(claimBattery7)
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      claimedStatus,
    })
    await handler({ capName: 'recording-archive', method: 'getStatus', args: {} })
    expect(claimedStatus).not.toHaveBeenCalled()
  })

  it('`claimedStatus` omitted (the agent, no claim authority): legacy routing exactly', async () => {
    const { resolver, resolveCapRoute } = routingResolver()
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
    })
    await expect(
      handler({ capName: 'battery', method: 'getStatus', args: { deviceId: DEVICE } }),
    ).resolves.toEqual(NATIVE)
    expect(resolveCapRoute).toHaveBeenCalledTimes(1)
  })
})
