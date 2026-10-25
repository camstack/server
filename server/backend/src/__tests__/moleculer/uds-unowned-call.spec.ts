/**
 * F0 (slice-5 outbound) — hub-side `onUnownedCall` wiring.
 *
 * When a forked hub child issues `ctx.api.<cap>.<method>` for a cap NO local
 * sibling owns, the hub's `LocalChildRegistry` must route it via the parent's
 * `onUnownedCall` handler and return the result over UDS — instead of falling
 * through `UDS_NO_ROUTE` to the child's own broker (which F1+F2 removes).
 *
 * The hub wires the handler in `onModuleInit` as:
 *   createParentUnownedCallHandler({ getResolver: () => this.resolver, broker: this.broker, logger })
 *
 * This test stands up the REAL production handler against:
 *   - a REAL `CapRouteResolver` configured with a hub-in-process provider, to
 *     prove the resolver-first branch resolves a hub cap, AND
 *   - a broker fake exposing a `$`-infra core service (`$core-caps`), to prove
 *     the broker-fallback branch reaches a core service the resolver can't see.
 *
 * We do NOT boot the full MoleculerService (it requires a real broker + DI
 * graph); instead we exercise the exact handler the hub constructs, with the
 * same resolver shape the hub injects, so both branches are covered.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createParentUnownedCallHandler,
  CapRouteResolver,
  CapRouteError,
  HubNodeRegistry,
} from '@camstack/system'
import type {
  NodeCapAuthority,
  InProcessProviderLookup,
  CapRouteResolverDeps,
  NodeNativeCapEntry,
  HubLocalChildDispatcher,
  CapCallInput,
} from '@camstack/system'
import type { ServiceBroker } from 'moleculer'

// A node authority that knows nothing — the only routable thing is the
// hub-in-process provider injected via inProcessProviders.
const emptyNodeAuthority: NodeCapAuthority = {
  nodeKnowsCap: () => false,
  nodeIsAgent: () => false,
  nodeOnline: () => false,
  listNodeIds: () => [],
  getAddonId: () => null,
  getAgentChildId: () => null,
  isNativeCap: () => false,
}

/**
 * Broker fake exposing the hub's `$core-caps` core service (the bridge for
 * `system`/`addons`/`capabilities`/`nodes` routers) so the broker-fallback
 * branch resolves it. `$core-caps` is NOT a CapabilityRegistry provider, so
 * the resolver returns `no-provider` for it and the fallback runs.
 */
function hubBrokerFake(): ServiceBroker {
  const services = [
    {
      name: '$core-caps',
      nodeID: 'hub',
      actions: { 'system.info': {}, 'integrations.getSettings': {} },
    },
  ]
  const broker = {
    nodeID: 'hub',
    call: vi.fn(async (action: string, params: unknown) => {
      if (action === '$core-caps.system.info') return { uptimeSec: 99, params }
      if (action === '$core-caps.integrations.getSettings') return { settings: true, params }
      throw Object.assign(new Error(`Service not found: ${action}`), { type: 'SERVICE_NOT_FOUND' })
    }),
    waitForServices: vi.fn(async () => undefined),
    registry: { getServiceList: () => services },
  }
  return broker as unknown as ServiceBroker
}

/**
 * Minimal `HubNodeRegistry`-shaped fake exposing only the lookup the unowned
 * handler uses: `listNativeCapEntriesForDevice`. The handler depends solely on
 * this method, so we don't need the full registry to exercise its routing.
 */
function nodeRegistryFake(
  byDevice: Record<number, readonly NodeNativeCapEntry[]> = {},
): HubNodeRegistry {
  const fake = {
    listNativeCapEntriesForDevice: (deviceId: number): readonly NodeNativeCapEntry[] =>
      byDevice[deviceId] ?? [],
  }
  return fake as unknown as HubNodeRegistry
}

/**
 * Hub-local UDS dispatcher fake (LocalChildRegistry surface). `resolveChildId`
 * returns the configured childId on a (capName, deviceId) match else null;
 * `callCapOnChild` records the call and echoes a sentinel result.
 */
function localDispatcherFake(owner?: { capName: string; deviceId: number; childId: string }): {
  dispatcher: HubLocalChildDispatcher
  resolveChildId: ReturnType<typeof vi.fn>
  callCapOnChild: ReturnType<typeof vi.fn>
} {
  const resolveChildId = vi.fn((capName: string, deviceId?: number): string | null =>
    owner !== undefined && capName === owner.capName && deviceId === owner.deviceId
      ? owner.childId
      : null,
  )
  const callCapOnChild = vi.fn(async (childId: string, input: CapCallInput) => ({
    routedOverUds: childId,
    capName: input.capName,
  }))
  const dispatcher: HubLocalChildDispatcher = { resolveChildId, callCapOnChild }
  return { dispatcher, resolveChildId, callCapOnChild }
}

describe('hub onUnownedCall wiring (F0)', () => {
  it('resolver-first: resolves a hub-in-process cap through the real CapRouteResolver', async () => {
    const broker = hubBrokerFake()

    // Hub-in-process provider for `settings-store`.
    const settingsStore = { get: async (params: unknown) => ({ value: 'hub-resolved', params }) }
    const inProcessProviders: InProcessProviderLookup = (capName) =>
      capName === 'settings-store'
        ? {
            invoke: (method, args) => {
              const fn: unknown = Reflect.get(settingsStore, method)
              if (typeof fn !== 'function') return Promise.reject(new Error(`no ${method}`))
              return Promise.resolve(fn(args))
            },
          }
        : null

    const resolverDeps: CapRouteResolverDeps = {
      hubNodeId: 'hub',
      broker,
      hubLocalRegistry: null,
      nodeAuthority: emptyNodeAuthority,
      inProcessProviders,
    }
    const resolver = new CapRouteResolver(resolverDeps)

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({ capName: 'settings-store', method: 'get', args: { key: 'k' } })
    expect(result).toEqual({ value: 'hub-resolved', params: { key: 'k' } })
    // Resolver served it — broker untouched.
    expect(broker.call as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('broker-fallback: a `$`-infra core service (`$core-caps.system.info`) routes via the broker', async () => {
    const broker = hubBrokerFake()

    // No in-process providers and no known nodes → the resolver returns
    // no-provider for `system`, exactly as it does live for the core routers.
    const resolver = new CapRouteResolver({
      hubNodeId: 'hub',
      broker,
      hubLocalRegistry: null,
      nodeAuthority: emptyNodeAuthority,
      inProcessProviders: () => null,
    })

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptimeSec: 99, params: undefined })
    expect(broker.call).toHaveBeenCalledWith('$core-caps.system.info', undefined, undefined)
  })

  it('broker-fallback: stamps callerAddonId into args for $core-caps (integrations.getSettings)', async () => {
    // D787 forOwner on integrations.getSettings reads Reflect.get(input, 'callerAddonId').
    // server-provided caps miss the hub-in-process stamp path and used to forward
    // only { id } — every account-mode provider then saw opaque secret views.
    const broker = hubBrokerFake()
    const resolver = new CapRouteResolver({
      hubNodeId: 'hub',
      broker,
      hubLocalRegistry: null,
      nodeAuthority: emptyNodeAuthority,
      inProcessProviders: () => null,
    })
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({
      capName: 'integrations',
      method: 'getSettings',
      args: { id: 'int_0009' },
      callerAddonId: 'provider-dreame',
    })
    expect(result).toEqual({
      settings: true,
      params: { id: 'int_0009', callerAddonId: 'provider-dreame' },
    })
    expect(broker.call).toHaveBeenCalledWith(
      '$core-caps.integrations.getSettings',
      { id: 'int_0009', callerAddonId: 'provider-dreame' },
      undefined,
    )
  })

  it('pre-init safety: getResolver returns null before onModuleInit → broker fallback still works', async () => {
    const broker = hubBrokerFake()
    // Mirrors the window before `this.resolver` is constructed: getResolver
    // returns null, so the handler goes straight to the broker fallback.
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptimeSec: 99, params: undefined })
  })

  it('deviceId-aware resolver: derives deviceId from args and routes via the resolver (no broker fallback)', async () => {
    const broker = hubBrokerFake()

    // A resolver-shaped fake that resolves a route ONLY when invoked with a
    // deviceId — mirroring the real resolver routing a device-scoped native cap
    // to its owning provider. Without a deviceId it returns no-provider.
    let resolvedWithDeviceId: number | undefined
    const resolver = {
      resolveCapRoute: (capName: string, opts: { deviceId?: number }) => {
        if (opts.deviceId === undefined) {
          throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
        }
        resolvedWithDeviceId = opts.deviceId
        return { kind: 'hub-in-process', capName, deviceId: opts.deviceId }
      },
      dispatch: async () => ({ catalog: ['stream-a'] }),
    }

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    // deviceId lives ONLY in args, NOT top-level — the handler must derive it.
    const result = await handler({
      capName: 'stream-catalog',
      method: 'getCatalog',
      args: { deviceId: 7 },
    })
    expect(result).toEqual({ catalog: ['stream-a'] })
    expect(resolvedWithDeviceId).toBe(7)
    // Resolver served it via the derived deviceId — broker untouched.
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('pinned broker fallback: resolver finds nothing → call is pinned to the owning node', async () => {
    const broker = hubBrokerFake()

    // Resolver always returns no-provider for this device-scoped cap.
    const resolver = {
      resolveCapRoute: (capName: string) => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      },
      dispatch: async () => {
        throw new Error('dispatch should not be reached')
      },
    }

    const owner: NodeNativeCapEntry = {
      nodeId: 'agent',
      addonId: 'reolink',
      capName: 'stream-catalog',
      deviceId: 7,
    }
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake({ 7: [owner] }),
    })

    await handler({ capName: 'stream-catalog', method: 'getCatalog', args: { deviceId: 7 } }).catch(
      () => undefined,
    )

    // The broker call is pinned to the owning node via call-opts `{ nodeID }`.
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    // The call must have happened, or the opts assertion below proves nothing.
    expect(callArgs).toBeDefined()
    expect(callArgs?.[2]).toEqual({ nodeID: 'agent' })
  })

  it('back-compat: no resolvable device-owner → broker call stays UNPINNED (load-balanced)', async () => {
    const broker = hubBrokerFake()

    const resolver = {
      resolveCapRoute: (capName: string) => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      },
      dispatch: async () => {
        throw new Error('dispatch should not be reached')
      },
    }

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake(), // no owners for any device
    })

    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptimeSec: 99, params: undefined })
    // Unpinned: third arg (call-opts) is undefined — today's behavior preserved.
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    // The call must have happened, or the opts assertion below proves nothing.
    expect(callArgs).toBeDefined()
    expect(callArgs?.[2]).toBeUndefined()
  })

  it('hub-local owner: device-native cap owned by a hub-local UDS child routes over UDS (broker untouched)', async () => {
    const broker = hubBrokerFake()
    // Resolver misses the device-scoped native cap (mirrors live behavior).
    const resolver = {
      resolveCapRoute: (capName: string) => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      },
      dispatch: async () => {
        throw new Error('dispatch should not be reached')
      },
    }
    const { dispatcher, resolveChildId, callCapOnChild } = localDispatcherFake({
      capName: 'stream-catalog',
      deviceId: 7,
      childId: 'child-reolink',
    })

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake(), // empty — hub-local child is NOT in HubNodeRegistry
      getLocalDispatcher: () => dispatcher,
    })

    const result = await handler({
      capName: 'stream-catalog',
      method: 'getCatalog',
      args: { deviceId: 7 },
    })
    expect(result).toEqual({ routedOverUds: 'child-reolink', capName: 'stream-catalog' })
    expect(resolveChildId).toHaveBeenCalledWith('stream-catalog', 7)
    expect(callCapOnChild).toHaveBeenCalledWith('child-reolink', {
      capName: 'stream-catalog',
      method: 'getCatalog',
      args: { deviceId: 7 },
      deviceId: 7,
    })
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('remote owner: hub-local dispatcher misses → pinned broker call', async () => {
    const broker = hubBrokerFake()
    const resolver = {
      resolveCapRoute: (capName: string) => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      },
      dispatch: async () => {
        throw new Error('dispatch should not be reached')
      },
    }
    const { dispatcher, callCapOnChild } = localDispatcherFake() // no local owner
    const owner: NodeNativeCapEntry = {
      nodeId: 'agent',
      addonId: 'reolink',
      capName: 'stream-catalog',
      deviceId: 7,
    }

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake({ 7: [owner] }),
      getLocalDispatcher: () => dispatcher,
    })

    await handler({ capName: 'stream-catalog', method: 'getCatalog', args: { deviceId: 7 } }).catch(
      () => undefined,
    )

    expect(callCapOnChild).not.toHaveBeenCalled()
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    // The call must have happened, or the opts assertion below proves nothing.
    expect(callArgs).toBeDefined()
    expect(callArgs?.[2]).toEqual({ nodeID: 'agent' })
  })

  it('no local dispatcher (getter returns null): behaves as before — HubNodeRegistry → broker', async () => {
    const broker = hubBrokerFake()
    const resolver = {
      resolveCapRoute: (capName: string) => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      },
      dispatch: async () => {
        throw new Error('dispatch should not be reached')
      },
    }
    const owner: NodeNativeCapEntry = {
      nodeId: 'agent',
      addonId: 'reolink',
      capName: 'stream-catalog',
      deviceId: 7,
    }

    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver as unknown as CapRouteResolver,
      broker,
      nodeRegistry: nodeRegistryFake({ 7: [owner] }),
      getLocalDispatcher: () => null,
    })

    await handler({ capName: 'stream-catalog', method: 'getCatalog', args: { deviceId: 7 } }).catch(
      () => undefined,
    )
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    // The call must have happened, or the opts assertion below proves nothing.
    expect(callArgs).toBeDefined()
    expect(callArgs?.[2]).toEqual({ nodeID: 'agent' })
  })
})
