/**
 * F0 (slice-5 outbound) — parent-side `onUnownedCall` routing.
 *
 * When a forked child issues a cap-call-out for a cap NO local sibling owns,
 * the parent's `LocalChildRegistry` must invoke `onUnownedCall` and return its
 * result over UDS instead of throwing `UDS_NO_ROUTE`. These tests pin:
 *   1. The registry hands an unowned cap-call-out to `onUnownedCall` and the
 *      result flows back to the child (no UDS_NO_ROUTE).
 *   2. `createParentUnownedCallHandler` tries the resolver first (resolver-hit).
 *   3. On a resolver `no-provider` miss it falls back to the broker.
 *   4. A non-`no-provider` resolver error (transport-failed / node-offline) is
 *      NOT retried via the broker — it propagates.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import { CapRouteError } from '../../transport/cap-route.js'
import type { CapRoute } from '../../transport/cap-route.js'
import type { CapRouteResolver } from '../../transport/cap-route-resolver.js'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import type { NodeNativeCapEntry } from '../../moleculer/node-registry.js'
import type { HubLocalChildDispatcher } from '../../transport/cap-route-resolver.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import type { LocalTransportClient, LocalChannel } from '../../transport/local-transport.js'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import type { ServiceBroker } from 'moleculer'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`

/** A fake child that issues a cap-call-out through its UDS channel. */
async function makeChildWithCapOut(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): Promise<{ client: LocalTransportClient; channel: LocalChannel }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async (body) => {
    const msg = body as CapCallMessage
    if (msg.kind === 'cap-call') return { servedBySibling: msg.method }
    throw new Error(`unexpected ${(msg as { kind: string }).kind}`)
  })
  await channel.request({ kind: 'register', childId, caps })
  return { client, channel }
}

describe('LocalChildRegistry — onUnownedCall fallback (F0)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('routes an unowned cap-call-out through onUnownedCall (not UDS_NO_ROUTE)', async () => {
    const nodeId = nid()
    const seen: CapCallInput[] = []
    const onUnownedCall = async (input: CapCallInput): Promise<unknown> => {
      seen.push(input)
      return { routedByParent: input.capName, method: input.method }
    }
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall,
    })
    await registry.start()

    // Child owns only `ptz`; it calls `system` (a cap no sibling owns).
    const child = await makeChildWithCapOut(nodeId, 'reolink', [
      { capName: 'ptz', mode: 'singleton' },
    ])
    clients.push(child.client)

    const result = await child.channel.request({
      kind: 'cap-call-out',
      capName: 'system',
      method: 'info',
      args: { x: 1 },
    })

    expect(result).toEqual({ routedByParent: 'system', method: 'info' })
    // `callerAddonId` is the registered child's own id — `LocalChildRegistry`
    // knows it from owning the UDS connection the frame arrived on, not from
    // anything the child claimed in the message body.
    expect(seen).toEqual([
      { capName: 'system', method: 'info', args: { x: 1 }, callerAddonId: 'reolink' },
    ])
  })

  it('still routes to a sibling first, only falling to onUnownedCall when no sibling owns it', async () => {
    const nodeId = nid()
    const onUnownedCall = vi.fn(async () => ({ fallback: true }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall,
    })
    await registry.start()

    // sibling owns `osd`; the caller owns `ptz`.
    const sibling = await makeChildWithCapOut(nodeId, 'sibling', [
      { capName: 'osd', mode: 'singleton' },
    ])
    const caller = await makeChildWithCapOut(nodeId, 'caller', [
      { capName: 'ptz', mode: 'singleton' },
    ])
    clients.push(sibling.client, caller.client)

    const result = await caller.channel.request({
      kind: 'cap-call-out',
      capName: 'osd',
      method: 'get',
      args: {},
    })
    expect(result).toEqual({ servedBySibling: 'get' })
    expect(onUnownedCall).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createParentUnownedCallHandler — resolver-first + broker-fallback unit tests
// ---------------------------------------------------------------------------

/**
 * Minimal `HubNodeRegistry`-shaped fake exposing only the device-owner lookup
 * the handler uses for the pinned broker fallback. Defaults to no owners.
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
 * Hub-local UDS dispatcher fake. `resolveChildId` returns the configured
 * childId for a (capName, deviceId) match, else null; `callCapOnChild` records
 * the call and echoes a sentinel result.
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

/** Build a minimal CapRouteResolver fake exposing only resolveCapRoute + dispatch. */
function fakeResolver(opts: {
  resolveCapRoute: (capName: string, o: { deviceId?: number; nodeId?: string }) => CapRoute
  dispatch: (route: CapRoute, method: string, args: unknown) => Promise<unknown>
}): CapRouteResolver {
  const resolver = {
    resolveCapRoute: opts.resolveCapRoute,
    dispatch: opts.dispatch,
  }
  // The handler only ever calls resolveCapRoute + dispatch; the structural
  // subset is sufficient. Cast is a documented test-boundary narrowing.
  return resolver as unknown as CapRouteResolver
}

/** A broker fake whose registry exposes one discoverable `$core-caps`-style service. */
function fakeBrokerWithService(
  serviceName: string,
  actionKey: string,
  handler: (params: unknown) => unknown,
): ServiceBroker {
  const services = [{ name: serviceName, nodeID: 'hub', actions: { [actionKey]: {} } }]
  const broker = {
    nodeID: 'hub',
    call: vi.fn(async (action: string, params: unknown) => {
      if (action === `${serviceName}.${actionKey}`) return handler(params)
      throw Object.assign(new Error(`Service not found: ${action}`), { type: 'SERVICE_NOT_FOUND' })
    }),
    waitForServices: vi.fn(async () => undefined),
    registry: {
      getServiceList: () => services,
    },
  }
  return broker as unknown as ServiceBroker
}

describe('createParentUnownedCallHandler', () => {
  it('resolver-hit: dispatches via the resolver and returns its result', async () => {
    const route: CapRoute = {
      kind: 'remote-moleculer',
      capName: 'pipeline-executor',
      nodeId: 'dev-agent-0',
    }
    const dispatch = vi.fn(async () => ({ ok: 'fromResolver' }))
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: 'fromBroker' }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute: () => route, dispatch }),
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({
      capName: 'pipeline-executor',
      method: 'getSchema',
      args: { nodeId: 'dev-agent-0' },
    })
    expect(result).toEqual({ ok: 'fromResolver' })
    expect(dispatch).toHaveBeenCalledWith(route, 'getSchema', { nodeId: 'dev-agent-0' })
    // Broker untouched on a resolver hit.
    expect(broker.call as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('forwards a per-call node pin (CapCallInput.nodeId) into the resolver opts', async () => {
    // The `onNode(nodeId)` / nodePin path lands here as `input.nodeId`. The
    // handler MUST pass it through to `resolveCapRoute` so the resolver can
    // classify a pinned agent node as `agent-child-forward` (→ that node's
    // in-process provider) instead of defaulting a singleton to the hub.
    const seen: Array<{ deviceId?: number; nodeId?: string }> = []
    const route: CapRoute = {
      kind: 'agent-child-forward',
      capName: 'platform-probe',
      agentNodeId: 'agent-a',
    }
    const dispatch = vi.fn(async () => ({ hardware: { npu: null } }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (_cap, o) => {
            seen.push(o)
            return route
          },
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
    })

    await handler({
      capName: 'platform-probe',
      method: 'getCapabilities',
      args: undefined,
      nodeId: 'agent-a',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.nodeId).toBe('agent-a')
    expect(dispatch).toHaveBeenCalledWith(route, 'getCapabilities', undefined)
  })

  it('nodeIdMode data cap: args.nodeId is NOT lifted into a routing pin — unpinned resolve, data preserved', async () => {
    // `addon-settings.getGlobalSettings({addonId, nodeId})` from a forked addon
    // on an AGENT: `nodeId` is DATA for the hub singleton provider (which
    // dispatches internally), NOT a routing hint. Pinning on it routes the call
    // to a node with NO addon-settings provider → dead broker fallback →
    // ServiceNotFoundError. The injected `isDataNodeIdCap` predicate must
    // suppress the pin (unpinned → singleton resolution, like settings-store)
    // while `args.nodeId` passes through UNTOUCHED as provider data.
    const seen: Array<{ deviceId?: number; nodeId?: string }> = []
    const route: CapRoute = {
      kind: 'hub-in-process',
      capName: 'addon-settings',
      ref: { invoke: async () => undefined },
    }
    const dispatch = vi.fn(async () => ({ settings: { budget: 1 } }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (_cap, o) => {
            seen.push(o)
            return route
          },
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      isDataNodeIdCap: (capName) => capName === 'addon-settings',
    })

    const args = { addonId: 'decoder-ffmpeg', nodeId: 'agent-a' }
    const result = await handler({
      capName: 'addon-settings',
      method: 'getGlobalSettings',
      args,
    })
    expect(result).toEqual({ settings: { budget: 1 } })
    // Unpinned resolve — no nodeId reached the resolver (singleton path).
    expect(seen).toHaveLength(1)
    expect(seen[0]?.nodeId).toBeUndefined()
    // Data preserved — the provider still receives `nodeId` inside args.
    expect(dispatch).toHaveBeenCalledWith(route, 'getGlobalSettings', {
      addonId: 'decoder-ffmpeg',
      nodeId: 'agent-a',
    })
  })

  it('nodeIdMode routing cap (predicate false): args.nodeId STILL pins — node-pinned execution preserved', async () => {
    // Guards against regressing the pinned path (benchmark, platform-probe,
    // pipeline-runner): a cap the predicate does NOT mark as data-mode keeps
    // lifting an inline `args.nodeId` into the routing pin exactly as before.
    const seen: Array<{ deviceId?: number; nodeId?: string }> = []
    const route: CapRoute = {
      kind: 'agent-child-forward',
      capName: 'platform-probe',
      agentNodeId: 'agent-a',
    }
    const dispatch = vi.fn(async () => ({ pinnedRun: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (_cap, o) => {
            seen.push(o)
            return route
          },
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      isDataNodeIdCap: (capName) => capName === 'addon-settings',
    })

    const result = await handler({
      capName: 'platform-probe',
      method: 'getCapabilities',
      args: { nodeId: 'agent-a' },
    })
    expect(result).toEqual({ pinnedRun: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.nodeId).toBe('agent-a')
    expect(dispatch).toHaveBeenCalledWith(route, 'getCapabilities', { nodeId: 'agent-a' })
  })

  it('broker-fallback: a resolver no-provider miss falls back to the broker (`$core-caps`)', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', (params) => ({
      uptime: 42,
      echo: params,
    }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, {
              reason: 'no-provider',
              rejected: [{ kind: 'hub-in-process', why: 'not a registered cap' }],
            })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    // `system.info` is a core router exposed as `$core-caps.system.info` — NOT a
    // registered capability, so the resolver misses and the broker fallback runs.
    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptime: 42, echo: undefined })
    expect(broker.call).toHaveBeenCalledWith('$core-caps.system.info', undefined, undefined)
  })

  it('broker-only (agent, no resolver): always uses the broker fallback', async () => {
    const broker = fakeBrokerWithService('$stream-probe', 'stream-probe.probe', () => ({
      codec: 'h264',
    }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    const result = await handler({
      capName: 'stream-probe',
      method: 'probe',
      args: { url: 'rtsp://x' },
    })
    expect(result).toEqual({ codec: 'h264' })
    expect(broker.call).toHaveBeenCalledWith(
      '$stream-probe.stream-probe.probe',
      { url: 'rtsp://x' },
      undefined,
    )
  })

  it('non-no-provider resolver error (transport-failed) propagates — NOT retried via broker', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: () => ({ kind: 'remote-moleculer', capName: 'x', nodeId: 'agent-1' }),
          dispatch: async () => {
            throw new CapRouteError('x', 'm', {
              reason: 'transport-failed',
              nodeId: 'agent-1',
              rejected: [{ kind: 'remote-moleculer', why: 'boom' }],
            })
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    await expect(handler({ capName: 'x', method: 'm', args: {} })).rejects.toThrow(
      /transport-failed/,
    )
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('node-offline resolver error propagates — NOT retried via broker (broker.call not invoked)', async () => {
    // Locks the invariant: only `no-provider` triggers the broker fallback.
    // `node-offline` means the resolver DID route the call (to a specific offline
    // node) — retrying via the broker would be wrong and must never happen.
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: () => {
            throw new CapRouteError('ptz', 'getOptions', {
              reason: 'node-offline',
              nodeId: 'agent-2',
              rejected: [{ kind: 'remote-moleculer', why: 'node agent-2 is offline' }],
            })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    await expect(
      handler({ capName: 'ptz', method: 'getOptions', args: { deviceId: 7 } }),
    ).rejects.toThrow(/node-offline/)
    // The broker must NOT be called — node-offline is not a broker-fallback trigger.
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('a broker dispatch failure surfaces a diagnostic error wrapping the cause', async () => {
    // The cap IS discoverable (so no infinite load-balanced wait) but the
    // underlying broker.call rejects — the handler wraps it in a clear
    // parent-routing error instead of leaking the raw transport error.
    const broker = {
      nodeID: 'hub',
      call: vi.fn(async () => {
        throw new Error('handler blew up')
      }),
      waitForServices: vi.fn(async () => undefined),
      registry: {
        getServiceList: () => [
          { name: '$core-caps', nodeID: 'hub', actions: { 'system.info': {} } },
        ],
      },
    } as unknown as ServiceBroker
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker,
      nodeRegistry: nodeRegistryFake(),
    })

    await expect(handler({ capName: 'system', method: 'info', args: undefined })).rejects.toThrow(
      /could not route child unowned cap call "system\.info": handler blew up/,
    )
  })

  it('hub-local owner: a device-native cap owned by a hub-local UDS child routes over UDS (broker untouched)', async () => {
    // Reolink camera (device 7) runs as a hub-local UDS child — it registers via
    // LocalChildRegistry, NOT registerNode, so HubNodeRegistry is empty for it.
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: 'fromBroker' }))
    const { dispatcher, resolveChildId, callCapOnChild } = localDispatcherFake({
      capName: 'stream-catalog',
      deviceId: 7,
      childId: 'child-reolink',
    })
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(), // empty — hub-local child is not here
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
    // The broker was never consulted — UDS owned the call.
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('remote owner: hub-local dispatcher misses → pinned broker call to the owning node', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: 'fromBroker' }))
    const { dispatcher, callCapOnChild } = localDispatcherFake() // no local owner
    const owner: NodeNativeCapEntry = {
      nodeId: 'agent',
      addonId: 'reolink',
      capName: 'stream-catalog',
      deviceId: 7,
    }
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake({ 7: [owner] }),
      getLocalDispatcher: () => dispatcher,
    })

    await handler({ capName: 'stream-catalog', method: 'getCatalog', args: { deviceId: 7 } }).catch(
      () => undefined,
    )

    // No local owner → fell through to the pinned broker call.
    expect(callCapOnChild).not.toHaveBeenCalled()
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs?.[2]).toEqual({ nodeID: 'agent' })
  })

  it('no owner anywhere: hub-local miss + no remote owner → load-balanced (unpinned) broker call', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ uptime: 1 }))
    const { dispatcher } = localDispatcherFake() // no local owner
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(), // no remote owners either
      getLocalDispatcher: () => dispatcher,
    })

    const result = await handler({ capName: 'system', method: 'info', args: { deviceId: 99 } })
    expect(result).toEqual({ uptime: 1 })
    // Unpinned: third arg (call-opts) is undefined — back-compat preserved.
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs?.[2]).toBeUndefined()
  })

  it('device-native registration race: resolveChildId null then resolves → handler RETRIES + routes over UDS (no broker)', async () => {
    // export-alexa (forked hub-local child) calls `switch.getStatus({deviceId:133})`
    // immediately after a respawn. The binding's UDS descriptor lands a beat
    // late, so `resolveChildId` returns null on the first call(s) and the real
    // child id once the descriptor arrives. The handler must retry the hub-local
    // route inside the bounded window rather than fall to the unpinned broker
    // (which would build the doubled `switch.switch.getStatus`).
    vi.useFakeTimers()
    try {
      const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({
        ok: 'fromBroker',
      }))
      // resolveChildId: null for the first 2 calls, then 'child-export-target'.
      let calls = 0
      const resolveChildId = vi.fn((_capName: string, _deviceId?: number): string | null => {
        calls += 1
        return calls <= 2 ? null : 'child-export-target'
      })
      const callCapOnChild = vi.fn(async (childId: string, input: CapCallInput) => ({
        routedOverUds: childId,
        capName: input.capName,
      }))
      const dispatcher: HubLocalChildDispatcher = { resolveChildId, callCapOnChild }
      const handler = createParentUnownedCallHandler({
        getResolver: () =>
          fakeResolver({
            resolveCapRoute: (capName) => {
              throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
            },
            dispatch: async () => {
              throw new Error('should not dispatch')
            },
          }),
        broker,
        nodeRegistry: nodeRegistryFake(), // no remote owner
        getLocalDispatcher: () => dispatcher,
        isDeviceNativeCap: (capName) => capName === 'switch',
      })

      const promise = handler({ capName: 'switch', method: 'getStatus', args: { deviceId: 133 } })
      // Drive the bounded retry loop: each retry waits ~200ms.
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await promise

      expect(result).toEqual({ routedOverUds: 'child-export-target', capName: 'switch' })
      // The third resolveChildId hit succeeded → routed over UDS, broker untouched.
      expect(callCapOnChild).toHaveBeenCalledWith('child-export-target', {
        capName: 'switch',
        method: 'getStatus',
        args: { deviceId: 133 },
        deviceId: 133,
      })
      expect(broker.call).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('device-native still unregistered after all retries → precise error (NOT a `${cap}.${cap}.${method}` broker attempt)', async () => {
    vi.useFakeTimers()
    try {
      const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({
        ok: 'fromBroker',
      }))
      const { dispatcher, resolveChildId } = localDispatcherFake() // always null
      const handler = createParentUnownedCallHandler({
        getResolver: () =>
          fakeResolver({
            resolveCapRoute: (capName) => {
              throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
            },
            dispatch: async () => {
              throw new Error('should not dispatch')
            },
          }),
        broker,
        nodeRegistry: nodeRegistryFake(), // no remote owner
        getLocalDispatcher: () => dispatcher,
        isDeviceNativeCap: (capName) => capName === 'switch',
      })

      const promise = handler({ capName: 'switch', method: 'getStatus', args: { deviceId: 133 } })
      const assertion = expect(promise).rejects.toThrow(
        /no provider registered for device-native cap "switch" on device 133 \(binding not yet in LocalChildRegistry\)/,
      )
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion

      // It retried (more than the single initial probe) and never fell to the
      // unpinned broker — no misleading doubled-name Moleculer call.
      expect(resolveChildId.mock.calls.length).toBeGreaterThan(1)
      expect(broker.call).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no local dispatcher (getter omitted): behaves as before — HubNodeRegistry → broker', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: 'fromBroker' }))
    const owner: NodeNativeCapEntry = {
      nodeId: 'agent',
      addonId: 'reolink',
      capName: 'stream-catalog',
      deviceId: 7,
    }
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake({ 7: [owner] }),
      // getLocalDispatcher omitted entirely.
    })

    await handler({ capName: 'stream-catalog', method: 'getCatalog', args: { deviceId: 7 } }).catch(
      () => undefined,
    )
    const callArgs = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs?.[2]).toEqual({ nodeID: 'agent' })
  })

  it('empty-collection fast-path: returns [] without touching the resolver OR broker', async () => {
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ ok: true }))
    const resolveCapRoute = vi.fn(() => {
      throw new Error('resolver should not be consulted for an empty collection')
    })
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute, dispatch: async () => undefined }),
      broker,
      nodeRegistry: nodeRegistryFake(),
      // Simulate a provider-less collection array-method.
      resolveEmptyCollection: (capName, method) =>
        capName === 'turn-provider' && method === 'getTurnServers' ? [] : null,
    })

    const result = await handler({ capName: 'turn-provider', method: 'getTurnServers', args: {} })
    expect(result).toEqual([])
    expect(resolveCapRoute).not.toHaveBeenCalled()
    expect(broker.call).not.toHaveBeenCalled()
  })

  it('empty-collection fast-path: skipped when resolveEmptyCollection returns null (routes normally)', async () => {
    const route: CapRoute = {
      kind: 'hub-in-process',
      capName: 'turn-provider',
      ref: { invoke: async () => undefined },
    }
    const dispatch = vi.fn(async () => [{ urls: 'turn:example' }])
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute: () => route, dispatch }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      // A collection WITH providers → null → route via the resolver aggregate.
      resolveEmptyCollection: () => null,
    })

    const result = await handler({ capName: 'turn-provider', method: 'getTurnServers', args: {} })
    expect(result).toEqual([{ urls: 'turn:example' }])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('empty-collection fast-path: skipped when the call carries an explicit nodePin', async () => {
    const route: CapRoute = {
      kind: 'agent-child-forward',
      capName: 'turn-provider',
      agentNodeId: 'agent-a',
    }
    const dispatch = vi.fn(async () => 'routed-to-pinned-node')
    const resolveEmptyCollection = vi.fn(() => [] as readonly unknown[])
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute: () => route, dispatch }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      resolveEmptyCollection,
    })

    const result = await handler({
      capName: 'turn-provider',
      method: 'getTurnServers',
      args: {},
      nodeId: 'agent-a',
    })
    // Pin honoured — routed via the resolver, fast-path never consulted.
    expect(result).toBe('routed-to-pinned-node')
    expect(resolveEmptyCollection).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // Explicit foreign-node pin vs the device-scoped LOCAL fallback (the Mac
  // mini / agent-a cross-node detection black-hole).
  //
  // On an AGENT (no resolver) a runner's `getStreamWithCodec({deviceId},
  // nodePin('hub'))` must reach the HUB's stream-broker. The broker-fallback's
  // deviceId branch resolves node-LOCALLY (LocalChildRegistry tier-2 matches
  // the agent's own same-named `stream-broker` sibling) — without honouring
  // the pin, the agent's non-owner broker answers "source not dialed" and
  // cross-node detection silently black-holes. Third instance of "an explicit
  // pin must win over a co-located provider" (localProviderLink, the sibling
  // short-circuit, now the parent's device-scoped fallback).
  // -------------------------------------------------------------------------

  it('agent + foreign-node pin: deviceId branch must NOT dispatch to the local sibling — forwards to the hub with the pin', async () => {
    // Agent-shaped deps: no resolver, own nodeID ≠ pin target, a local
    // stream-broker sibling that tier-2 matches the cap name for ANY deviceId
    // (real LocalChildRegistry semantics for singleton caps), and forwardToHub.
    const broker = {
      nodeID: 'agent-mac',
      call: vi.fn(async () => ({ ok: 'fromBroker' })),
      waitForServices: vi.fn(async () => undefined),
      registry: { getServiceList: () => [] },
    } as unknown as ServiceBroker
    const callCapOnChild = vi.fn(async (childId: string) => ({ servedLocallyBy: childId }))
    const dispatcher: HubLocalChildDispatcher = {
      // Tier-2 singleton match: the agent's own stream-broker child owns the
      // cap NAME regardless of deviceId — exactly what mis-served the call.
      resolveChildId: (capName: string) => (capName === 'stream-broker' ? 'child-broker' : null),
      callCapOnChild,
    }
    const forwardToHub = vi.fn(async () => ({ url: 'rtsp://192.168.10.9:8554/x', ok: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker,
      nodeRegistry: nodeRegistryFake(),
      getLocalDispatcher: () => dispatcher,
      forwardToHub,
    })

    const result = await handler({
      capName: 'stream-broker',
      method: 'getStreamWithCodec',
      args: { deviceId: 104, video: 'copy', profile: 'high' },
      nodeId: 'hub',
    })

    expect(result).toEqual({ url: 'rtsp://192.168.10.9:8554/x', ok: true })
    // The local sibling was NEVER consulted — the pin won.
    expect(callCapOnChild).not.toHaveBeenCalled()
    expect(forwardToHub).toHaveBeenCalledWith({
      capName: 'stream-broker',
      method: 'getStreamWithCodec',
      args: { deviceId: 104, video: 'copy', profile: 'high' },
      deviceId: 104,
      nodeId: 'hub',
    })
  })

  it('agent + pin to its OWN node: deviceId branch still dispatches to the local child (unchanged)', async () => {
    // RemoteSourcePlane pins its decoder calls to the runner's OWN node —
    // that self-pin must keep resolving locally, never bounce to the hub.
    const broker = {
      nodeID: 'agent-mac',
      call: vi.fn(async () => ({ ok: 'fromBroker' })),
      waitForServices: vi.fn(async () => undefined),
      registry: { getServiceList: () => [] },
    } as unknown as ServiceBroker
    const callCapOnChild = vi.fn(async (childId: string, input: CapCallInput) => ({
      servedLocallyBy: childId,
      capName: input.capName,
    }))
    const dispatcher: HubLocalChildDispatcher = {
      resolveChildId: (capName: string) => (capName === 'decoder' ? 'child-decoder' : null),
      callCapOnChild,
    }
    const forwardToHub = vi.fn(async () => ({ shouldNotBeUsed: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker,
      nodeRegistry: nodeRegistryFake(),
      getLocalDispatcher: () => dispatcher,
      forwardToHub,
    })

    const result = await handler({
      capName: 'decoder',
      method: 'createSession',
      args: { deviceId: 104, codec: 'h264' },
      nodeId: 'agent-mac',
    })

    expect(result).toEqual({ servedLocallyBy: 'child-decoder', capName: 'decoder' })
    expect(callCapOnChild).toHaveBeenCalledWith('child-decoder', {
      capName: 'decoder',
      method: 'createSession',
      args: { deviceId: 104, codec: 'h264' },
      deviceId: 104,
    })
    expect(forwardToHub).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // General provider-not-yet-registered recovery (`isCoreServiceCap`).
  //
  // The doubled `${cap}.${cap}.${method}` broker-fallback failure is NOT unique
  // to device-native caps — ANY addon-provided cap (system singleton like
  // `pipeline-orchestrator` / `stream-broker`, provided by a broker-less forked
  // child) hits it when the resolver misses during the post-restart boot window.
  // The unpinned `brokerCallForCap` is a STRUCTURALLY DEAD path for such caps
  // (forked runners expose no Moleculer service). `isCoreServiceCap` marks the
  // ONLY legitimate consumers of the unpinned fallback (the hub-core `$core-caps`
  // services). For everything else, a `no-provider` miss ⇒ retry the resolver
  // briefly (the provider registers late), then a PRECISE error — never the
  // 30s doubled-name broker deadline.
  // -------------------------------------------------------------------------

  it('addon cap not yet registered: retries the resolver, routes once the provider appears (broker untouched)', async () => {
    vi.useFakeTimers()
    try {
      const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({
        ok: 'fromBroker',
      }))
      // resolveCapRoute misses (no-provider) for the first 2 calls, then routes.
      let calls = 0
      const route: CapRoute = {
        kind: 'hub-local-uds',
        capName: 'pipeline-orchestrator',
        childId: 'child-orchestrator',
      }
      const dispatch = vi.fn(async () => ({ ownerNodeId: 'hub' }))
      const resolveCapRoute = vi.fn((capName: string): CapRoute => {
        calls += 1
        if (calls <= 2) {
          throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
        }
        return route
      })
      const handler = createParentUnownedCallHandler({
        getResolver: () => fakeResolver({ resolveCapRoute, dispatch }),
        broker,
        nodeRegistry: nodeRegistryFake(),
        // pipeline-orchestrator is NOT a hub-core $-service.
        isCoreServiceCap: (capName) => capName === 'system',
      })

      const promise = handler({
        capName: 'pipeline-orchestrator',
        method: 'getIngestOwner',
        args: undefined,
      })
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await promise

      expect(result).toEqual({ ownerNodeId: 'hub' })
      expect(dispatch).toHaveBeenCalledWith(route, 'getIngestOwner', undefined)
      // The dead unpinned broker fallback was NEVER attempted.
      expect(broker.call).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('addon cap still unregistered after retries: precise error, NOT a `${cap}.${cap}.${method}` broker attempt', async () => {
    vi.useFakeTimers()
    try {
      const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({
        ok: 'fromBroker',
      }))
      const resolveCapRoute = vi.fn((capName: string): CapRoute => {
        throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
      })
      const handler = createParentUnownedCallHandler({
        getResolver: () => fakeResolver({ resolveCapRoute, dispatch: async () => undefined }),
        broker,
        nodeRegistry: nodeRegistryFake(),
        isCoreServiceCap: (capName) => capName === 'system',
      })

      const promise = handler({
        capName: 'pipeline-orchestrator',
        method: 'getIngestOwner',
        args: undefined,
      })
      const assertion = expect(promise).rejects.toThrow(
        /no provider registered for cap "pipeline-orchestrator" \(resolver miss after boot-window retry/,
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion

      // It retried (more than the single initial resolve) and never fell to the
      // unpinned broker — no misleading doubled-name Moleculer call.
      expect(resolveCapRoute.mock.calls.length).toBeGreaterThan(1)
      expect(broker.call).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('core-service cap (isCoreServiceCap true): a no-provider miss STILL uses the broker fallback', async () => {
    // `system` is served by the hub-core `$core-caps` Moleculer service, not a
    // resolver provider — the broker fallback is its correct, legitimate route.
    // The recovery guard must NOT divert it.
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ uptime: 7 }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
      isCoreServiceCap: (capName) => capName === 'system',
    })

    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptime: 7 })
    expect(broker.call).toHaveBeenCalledWith('$core-caps.system.info', undefined, undefined)
  })

  it('core-service cap: the legitimate `$core-caps` route is a DEBUG line naming the caller, never a WARN', async () => {
    // 3,647 WARN lines in 24h on the live hub (2026-09-05), every one of them
    // this branch doing exactly what it is for: `addons.listCapabilityProviders`
    // from addon-pipeline, `nodes.topology` from addon-terminal, ha-export's
    // 5-minute reads. A warning that fires on the designed path is noise that
    // buries the one that is not — and without the caller in it, nobody could
    // even say WHICH addon was polling.
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ uptime: 7 }))
    const logger = { warn: vi.fn(), debug: vi.fn() }
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
      isCoreServiceCap: (capName) => capName === 'system',
      logger,
    })

    await handler({
      capName: 'system',
      method: 'info',
      args: undefined,
      callerAddonId: '@camstack/addon-pipeline',
    })

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledTimes(1)
    expect(logger.debug.mock.calls[0]?.[1]).toEqual({
      capName: 'system',
      method: 'info',
      callerAddonId: '@camstack/addon-pipeline',
      route: '$core-caps',
    })
  })

  it('isCoreServiceCap omitted: legacy behaviour preserved — no-provider miss goes straight to broker', async () => {
    // Back-compat: without the predicate injected, a no-provider miss falls to
    // the broker fallback exactly as before (no retry, no diverted error).
    const broker = fakeBrokerWithService('$core-caps', 'system.info', () => ({ uptime: 1 }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (capName) => {
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          },
          dispatch: async () => {
            throw new Error('should not dispatch')
          },
        }),
      broker,
      nodeRegistry: nodeRegistryFake(),
      // isCoreServiceCap omitted.
    })

    const result = await handler({ capName: 'system', method: 'info', args: undefined })
    expect(result).toEqual({ uptime: 1 })
    expect(broker.call).toHaveBeenCalledWith('$core-caps.system.info', undefined, undefined)
  })
})

// ── Collection fan-out (D1, 2026-07-30) ─────────────────────────────────────
// A `mode:'collection'` cap called from a FORKED child resolved ONE provider
// (`resolveChildId` picks the first-registered child) instead of the union the
// hub's tRPC cap-router returns. `notification-output` has three providers, so
// the Notification Center's `listTargets` landed on an empty one and every
// notification permanently dead-lettered as "target not found".
describe('collection fan-out on the child→parent path', () => {
  it('aggregates an array method across providers instead of routing to one', async () => {
    const resolveCapRoute = vi.fn(() => {
      throw new Error('resolver must not be consulted for an aggregated collection')
    })
    const callCollectionAggregate = vi.fn(async (capName: string, method: string) =>
      capName === 'notification-output' && method === 'listTargets'
        ? [{ id: 'a' }, { id: 'b' }]
        : null,
    )
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute, dispatch: async () => undefined }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callCollectionAggregate,
    })

    const result = await handler({
      capName: 'notification-output',
      method: 'listTargets',
      args: {},
    })
    expect(result).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  it('routes normally when the cap/method is not an aggregated collection', async () => {
    const dispatch = vi.fn(async () => 'single-provider')
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (): CapRoute => ({
            kind: 'hub-in-process',
            capName: 'notification-output',
            ref: { invoke: async () => undefined },
          }),
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callCollectionAggregate: async () => null,
    })

    const result = await handler({ capName: 'notification-output', method: 'send', args: {} })
    expect(result).toBe('single-provider')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('an explicit nodePin wins over the aggregate', async () => {
    const dispatch = vi.fn(async () => 'routed-to-pinned-node')
    const callCollectionAggregate = vi.fn(async () => [{ id: 'a' }])
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (): CapRoute => ({
            kind: 'agent-child-forward',
            capName: 'notification-output',
            agentNodeId: 'agent-a',
          }),
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callCollectionAggregate,
    })

    const result = await handler({
      capName: 'notification-output',
      method: 'listTargets',
      args: {},
      nodeId: 'agent-a',
    })
    expect(result).toBe('routed-to-pinned-node')
    expect(callCollectionAggregate).not.toHaveBeenCalled()
  })
})

// ── `{ addonId }` pin on the child→parent path (2026-08-09) ─────────────────
// The scalar twin of the fan-out above. `resolveCapRoute` takes only
// `nodeId`/`deviceId`, so a forked addon's `{ addonId }` selector — which the
// codegen injects on every method of a system-scoped collection cap, and which
// the hub's tRPC router routes by — was discarded in silence and the call was
// answered by whichever provider registered first. Home Assistant's export read
// Homematic's `null` for `ha_001` and could never open a link.
describe('collection { addonId } pin on the child→parent path', () => {
  it('answers from the pinned provider instead of routing', async () => {
    const resolveCapRoute = vi.fn(() => {
      throw new Error('resolver must not be consulted for a pinned collection call')
    })
    const callPinnedCollection = vi.fn(async (capName: string, method: string) =>
      capName === 'broker' && method === 'getBrokerConfig'
        ? { value: { baseUrl: 'http://ha:8123' } }
        : null,
    )
    const handler = createParentUnownedCallHandler({
      getResolver: () => fakeResolver({ resolveCapRoute, dispatch: async () => undefined }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callPinnedCollection,
    })

    const result = await handler({
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'ha_001', addonId: 'provider-homeassistant' },
    })
    expect(result).toEqual({ baseUrl: 'http://ha:8123' })
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  /**
   * The reason the hook boxes its result. `getBrokerConfig` answers `null` for
   * a broker the pinned provider does not know — a real answer that must NOT
   * fall through to routing, where the first-registered provider would answer
   * instead. An unboxed `null` could not be told from "not handled" and would
   * have reinstated the exact bug.
   */
  it('a pinned provider answering null is the answer, not a fall-through', async () => {
    const dispatch = vi.fn(async () => 'first-registered-provider')
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (): CapRoute => ({
            kind: 'hub-in-process',
            capName: 'broker',
            ref: { invoke: async () => undefined },
          }),
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callPinnedCollection: async () => ({ value: null }),
    })

    const result = await handler({
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'ha_001', addonId: 'provider-homeassistant' },
    })
    expect(result).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('routes normally when the call carries no pin', async () => {
    const dispatch = vi.fn(async () => 'routed')
    const callPinnedCollection = vi.fn(async () => null)
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (): CapRoute => ({
            kind: 'hub-in-process',
            capName: 'broker',
            ref: { invoke: async () => undefined },
          }),
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callPinnedCollection,
    })

    const result = await handler({
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'x' },
    })
    expect(result).toBe('routed')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('an explicit nodePin wins over the addon pin', async () => {
    const dispatch = vi.fn(async () => 'routed-to-pinned-node')
    const callPinnedCollection = vi.fn(async () => ({ value: 'local-provider' }))
    const handler = createParentUnownedCallHandler({
      getResolver: () =>
        fakeResolver({
          resolveCapRoute: (): CapRoute => ({
            kind: 'agent-child-forward',
            capName: 'broker',
            agentNodeId: 'agent-a',
          }),
          dispatch,
        }),
      broker: fakeBrokerWithService('$core-caps', 'system.info', () => ({})),
      nodeRegistry: nodeRegistryFake(),
      callPinnedCollection,
    })

    const result = await handler({
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'ha_001', addonId: 'provider-homeassistant' },
      nodeId: 'agent-a',
    })
    expect(result).toBe('routed-to-pinned-node')
    expect(callPinnedCollection).not.toHaveBeenCalled()
  })
})
