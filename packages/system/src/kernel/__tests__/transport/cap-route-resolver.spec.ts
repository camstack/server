/**
 * CapRouteResolver — unit tests with fakes for all injected deps.
 *
 * Covers:
 *   - hub-in-process dispatch: invokes ref.invoke (no broker calls)
 *   - hub-local-uds dispatch: calls hubLocalRegistry.callCapOnChild with the right input
 *   - remote-moleculer dispatch: calls broker.call with correct action + nodeID option
 *   - agent-child-forward dispatch: calls broker.call targeting the agent nodeId
 *   - resolveCapRoute for unknown cap → CapRouteError{reason:'no-provider'}, NO broker call
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CapRouteResolver,
  AGENT_CAP_FWD_ACTION,
  AGENT_CAP_FWD_SERVICE,
} from '../../transport/cap-route-resolver.js'
import type {
  CapRouteResolverDeps,
  NodeCapAuthority,
  InProcessProviderLookup,
  HubLocalChildDispatcher,
} from '../../transport/cap-route-resolver.js'
import type { ServiceDiscoveryBroker } from '../../moleculer/resilient-cap-call.js'
import { CapRouteError } from '../../transport/cap-route.js'
import { PeerAnsweredError } from '../../transport/peer-answered-error.js'
import type { InProcessProviderRef } from '../../transport/cap-route.js'

// ---------------------------------------------------------------------------
// Fake: ServiceDiscoveryBroker
// ---------------------------------------------------------------------------

function makeFakeBroker(): ServiceDiscoveryBroker & { callSpy: ReturnType<typeof vi.fn> } {
  const callSpy = vi.fn<ServiceDiscoveryBroker['call']>(async (_action, _params, _opts) => ({
    ok: true,
    from: 'broker',
  }))
  return {
    call: callSpy,
    waitForServices: vi.fn(async () => {}),
    callSpy,
  }
}

// ---------------------------------------------------------------------------
// Fake: HubLocalChildDispatcher (only the methods the resolver uses)
// ---------------------------------------------------------------------------

interface FakeHubLocalRegistry extends HubLocalChildDispatcher {
  readonly callCapOnChildSpy: ReturnType<typeof vi.fn>
}

function makeFakeHubLocalRegistry(caps: ReadonlyMap<string, string>): FakeHubLocalRegistry {
  // caps: capName → childId
  const callCapOnChildSpy = vi.fn(async (_childId: string, _input: unknown) => ({
    ok: true,
    from: 'uds',
  }))
  const fake: FakeHubLocalRegistry = {
    resolveChildId: (capName: string) => caps.get(capName) ?? null,
    callCapOnChild: callCapOnChildSpy,
    callCapOnChildSpy,
  }
  return fake
}

// ---------------------------------------------------------------------------
// Fake: NodeCapAuthority
// ---------------------------------------------------------------------------

interface FakeNodeSpec {
  readonly capName: string
  readonly addonId: string
  readonly agentChildId?: string
  readonly isAgent?: boolean
}

function makeFakeNodeAuthority(
  nodeMap: ReadonlyMap<string, FakeNodeSpec>,
  onlineNodes: ReadonlySet<string>,
): NodeCapAuthority {
  return {
    nodeKnowsCap: (nodeId: string, capName: string): boolean => {
      const spec = nodeMap.get(nodeId)
      return spec !== undefined && spec.capName === capName
    },
    nodeIsAgent: (nodeId: string): boolean => {
      const spec = nodeMap.get(nodeId)
      return spec?.isAgent ?? false
    },
    nodeOnline: (nodeId: string): boolean => onlineNodes.has(nodeId),
    listNodeIds: (): readonly string[] => [...nodeMap.keys()],
    getAddonId: (nodeId: string, capName: string): string | null => {
      const spec = nodeMap.get(nodeId)
      if (spec === undefined || spec.capName !== capName) return null
      return spec.addonId
    },
    getAgentChildId: (agentNodeId: string, capName: string): string | null => {
      const spec = nodeMap.get(agentNodeId)
      if (spec === undefined || spec.capName !== capName) return null
      return spec.agentChildId ?? null
    },
    isNativeCap: (): boolean => false,
  }
}

// ---------------------------------------------------------------------------
// Fake: InProcessProviderLookup
// ---------------------------------------------------------------------------

function makeFakeInProcessProviders(
  caps: ReadonlyMap<string, InProcessProviderRef>,
): InProcessProviderLookup {
  return (capName: string) => caps.get(capName) ?? null
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const HUB_NODE_ID = 'hub'

// ---------------------------------------------------------------------------
// hub-in-process
// ---------------------------------------------------------------------------

describe('CapRouteResolver – hub-in-process dispatch', () => {
  it('invokes ref.invoke with the correct method and args (no broker call)', async () => {
    const invokeSpy = vi.fn(async (_method: string, _args: unknown) => ({
      result: 'in-process-ok',
    }))
    const ref: InProcessProviderRef = { invoke: invokeSpy }

    const broker = makeFakeBroker()
    const hubLocalCaps = new Map<string, string>() // no local children
    const nodeCaps = new Map<string, FakeNodeSpec>()
    const onlineNodes = new Set<string>([HUB_NODE_ID])

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(hubLocalCaps),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, onlineNodes),
      inProcessProviders: makeFakeInProcessProviders(new Map([['device-manager', ref]])),
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('device-manager', { nodeId: HUB_NODE_ID })
    expect(route.kind).toBe('hub-in-process')

    const result = await resolver.dispatch(route, 'getStatus', { deviceId: 1 })
    expect(invokeSpy).toHaveBeenCalledOnce()
    expect(invokeSpy).toHaveBeenCalledWith('getStatus', { deviceId: 1 })
    expect(result).toEqual({ result: 'in-process-ok' })
    expect(broker.callSpy).not.toHaveBeenCalled()
  })
})

describe('CapRouteResolver – an in-process provider that refuses', () => {
  it('passes the provider’s own throw through unchanged, never as transport-failed', async () => {
    const refusal = new Error('No home preset configured for this camera')
    const ref: InProcessProviderRef = {
      invoke: vi.fn(async () => {
        throw refusal
      }),
    }
    const resolver = new CapRouteResolver({
      hubNodeId: HUB_NODE_ID,
      broker: makeFakeBroker(),
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set([HUB_NODE_ID])),
      inProcessProviders: makeFakeInProcessProviders(new Map([['ptz', ref]])),
    })
    const route = resolver.resolveCapRoute('ptz', { nodeId: HUB_NODE_ID })
    const thrown = await resolver.dispatch(route, 'goHome', {}).catch((err: unknown) => err)
    expect(thrown).toBe(refusal)
  })
})

// ---------------------------------------------------------------------------
// hub-local-uds
// ---------------------------------------------------------------------------

describe('CapRouteResolver – hub-local-uds dispatch', () => {
  let broker: ReturnType<typeof makeFakeBroker>
  let hubLocalRegistry: ReturnType<typeof makeFakeHubLocalRegistry>
  let resolver: CapRouteResolver

  beforeEach(() => {
    broker = makeFakeBroker()
    // stream-broker is served by child 'addon-stream-broker'
    hubLocalRegistry = makeFakeHubLocalRegistry(new Map([['stream-broker', 'addon-stream-broker']]))
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry,
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    resolver = new CapRouteResolver(deps)
  })

  it('resolves to hub-local-uds with correct childId', () => {
    const route = resolver.resolveCapRoute('stream-broker', { nodeId: HUB_NODE_ID })
    expect(route.kind).toBe('hub-local-uds')
    if (route.kind === 'hub-local-uds') {
      expect(route.childId).toBe('addon-stream-broker')
    }
  })

  it('calls callCapOnChild with the right childId and CapCallInput', async () => {
    const route = resolver.resolveCapRoute('stream-broker', { nodeId: HUB_NODE_ID })
    const result = await resolver.dispatch(route, 'attachCamera', {
      deviceId: 42,
      source: 'rtsp://x',
    })

    expect(hubLocalRegistry.callCapOnChildSpy).toHaveBeenCalledOnce()
    const [calledChildId, calledInput] = hubLocalRegistry.callCapOnChildSpy.mock.calls[0] as [
      string,
      unknown,
    ]
    expect(calledChildId).toBe('addon-stream-broker')
    expect(calledInput).toMatchObject({
      capName: 'stream-broker',
      method: 'attachCamera',
      args: { deviceId: 42, source: 'rtsp://x' },
      deviceId: 42,
    })
    expect(result).toEqual({ ok: true, from: 'uds' })
    expect(broker.callSpy).not.toHaveBeenCalled()
  })

  it('hub-local-uds records: stated caller in args rides CapCallInput.callerAddonId', async () => {
    hubLocalRegistry = makeFakeHubLocalRegistry(new Map([['records', 'sqlite-settings']]))
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry,
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('records', { nodeId: HUB_NODE_ID })
    await resolver.dispatch(
      route,
      'declareKinds',
      {
        kinds: { locations: { database: 'settings', schemaVersion: 1 } },
        callerAddonId: 'storage-orchestrator',
      },
      'sqlite-settings',
    )

    expect(hubLocalRegistry.callCapOnChildSpy).toHaveBeenCalledOnce()
    const [childId, input] = hubLocalRegistry.callCapOnChildSpy.mock.calls[0] as [string, unknown]
    expect(childId).toBe('sqlite-settings')
    expect(input).toMatchObject({
      capName: 'records',
      method: 'declareKinds',
      callerAddonId: 'storage-orchestrator',
    })
  })

  it('propagates transport failures wrapped in CapRouteError{reason:transport-failed} with cause', async () => {
    const underlyingError = new Error('UDS channel closed')
    hubLocalRegistry.callCapOnChildSpy.mockRejectedValue(underlyingError)
    const route = resolver.resolveCapRoute('stream-broker', { nodeId: HUB_NODE_ID })

    let thrown: unknown
    try {
      await resolver.dispatch(route, 'attachCamera', {})
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(CapRouteError)
    expect((thrown as CapRouteError).name).toBe('CapRouteError')
    expect((thrown as CapRouteError).reason).toBe('transport-failed')
    // Original error is preserved as cause
    expect((thrown as CapRouteError).cause).toBe(underlyingError)
  })

  it('passes a PROVIDER refusal through verbatim — the call was routed and answered', async () => {
    const refusal = new PeerAnsweredError(
      'No home preset configured for this camera — set one in the PTZ settings',
    )
    hubLocalRegistry.callCapOnChildSpy.mockRejectedValue(refusal)
    const route = resolver.resolveCapRoute('stream-broker', { nodeId: HUB_NODE_ID })

    const thrown = await resolver.dispatch(route, 'goHome', {}).catch((err: unknown) => err)

    // NOT "not routable to node …: transport-failed" — the node was reached.
    expect(thrown).not.toBeInstanceOf(CapRouteError)
    expect(thrown).toBe(refusal)
    expect((thrown as Error).message).toBe(
      'No home preset configured for this camera — set one in the PTZ settings',
    )
  })

  it('throws CapRouteError{reason:no-provider} and makes NO broker call when hubLocalRegistry is null', async () => {
    const nullBroker = makeFakeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: nullBroker,
      hubLocalRegistry: null,
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    // The snapshot captures null at construction so hubLocalChildProvides returns
    // false and resolveCapRoute would not produce a hub-local-uds route. We craft
    // the route directly to exercise the dispatch-time null guard specifically.
    const fakeRoute = {
      kind: 'hub-local-uds' as const,
      capName: 'stream-broker',
      childId: 'addon-stream-broker',
    }

    let thrown: unknown
    try {
      await new CapRouteResolver(deps).dispatch(fakeRoute, 'attachCamera', {})
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(CapRouteError)
    expect((thrown as CapRouteError).reason).toBe('no-provider')
    expect(nullBroker.callSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// remote-moleculer
// ---------------------------------------------------------------------------

describe('CapRouteResolver – remote-moleculer dispatch', () => {
  it('calls broker.call with action=addonId.cap.method and nodeID option', async () => {
    const broker = makeFakeBroker()
    const nodeCaps = new Map<string, FakeNodeSpec>([
      ['remote-node-1', { capName: 'analytics', addonId: 'addon-analytics-suite' }],
    ])
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, new Set(['remote-node-1'])),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('analytics', { nodeId: 'remote-node-1' })
    expect(route.kind).toBe('remote-moleculer')

    await resolver.dispatch(route, 'getReport', { period: 'day' })

    expect(broker.callSpy).toHaveBeenCalledOnce()
    const [action, params, opts] = broker.callSpy.mock.calls[0] as [
      string,
      unknown,
      { nodeID?: string },
    ]
    expect(action).toBe('addon-analytics-suite.analytics.getReport')
    expect(params).toEqual({ period: 'day' })
    expect(opts).toMatchObject({ nodeID: 'remote-node-1' })
  })

  it('uses singleton resolution (no nodeId) to find a remote provider', async () => {
    const broker = makeFakeBroker()
    const nodeCaps = new Map<string, FakeNodeSpec>([
      ['remote-node-2', { capName: 'metrics', addonId: 'addon-metrics-native' }],
    ])
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, new Set(['remote-node-2'])),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }

    const resolver = new CapRouteResolver(deps)
    // No nodeId → singleton resolution scans known nodes
    const route = resolver.resolveCapRoute('metrics', {})
    expect(route.kind).toBe('remote-moleculer')
    if (route.kind === 'remote-moleculer') {
      expect(route.nodeId).toBe('remote-node-2')
    }

    await resolver.dispatch(route, 'getCpuUsage', {})
    const [action, , opts] = broker.callSpy.mock.calls[0] as [string, unknown, { nodeID?: string }]
    expect(action).toBe('addon-metrics-native.metrics.getCpuUsage')
    expect((opts as { nodeID?: string }).nodeID).toBe('remote-node-2')
  })

  it('throws CapRouteError{reason:no-provider} and makes NO broker call when getAddonId returns null', async () => {
    const broker = makeFakeBroker()
    // Node knows the cap but getAddonId returns null (simulated by a node spec
    // for a DIFFERENT cap so getAddonId misses the lookup).
    const nodeAuthority: NodeCapAuthority = {
      nodeKnowsCap: (_nodeId: string, _cap: string) => true,
      nodeIsAgent: () => false,
      nodeOnline: () => true,
      listNodeIds: () => ['remote-node-x'],
      getAddonId: () => null, // always returns null — the guard under test
      getAgentChildId: () => null,
      isNativeCap: () => false,
    }
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority,
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }

    const fakeRoute = {
      kind: 'remote-moleculer' as const,
      capName: 'analytics',
      nodeId: 'remote-node-x',
    }

    let thrown: unknown
    try {
      await new CapRouteResolver(deps).dispatch(fakeRoute, 'getReport', {})
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(CapRouteError)
    expect((thrown as CapRouteError).reason).toBe('no-provider')
    expect(broker.callSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// agent-child-forward
// ---------------------------------------------------------------------------

describe('CapRouteResolver – agent-child-forward dispatch', () => {
  it('calls broker.call with AGENT_CAP_FWD_ACTION targeting agentNodeId', async () => {
    const broker = makeFakeBroker()
    const nodeCaps = new Map<string, FakeNodeSpec>([
      [
        'dev-agent-0',
        {
          capName: 'pipeline-executor',
          addonId: 'addon-detection-pipeline',
          isAgent: true,
          agentChildId: 'addon-detection-pipeline',
        },
      ],
    ])
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, new Set(['dev-agent-0'])),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('pipeline-executor', { nodeId: 'dev-agent-0' })
    expect(route.kind).toBe('agent-child-forward')
    if (route.kind === 'agent-child-forward') {
      expect(route.agentNodeId).toBe('dev-agent-0')
      expect(route.childId).toBe('addon-detection-pipeline')
    }

    await resolver.dispatch(route, 'getSchema', { version: 2 })

    expect(broker.callSpy).toHaveBeenCalledOnce()
    const [action, params, opts] = broker.callSpy.mock.calls[0] as [
      string,
      unknown,
      { nodeID?: string },
    ]
    expect(action).toBe(AGENT_CAP_FWD_ACTION)
    expect(params).toMatchObject({
      capName: 'pipeline-executor',
      method: 'getSchema',
      args: { version: 2 },
      childId: 'addon-detection-pipeline',
    })
    expect((opts as { nodeID?: string }).nodeID).toBe('dev-agent-0')
  })

  it('threads an explicit addonId (grouped-runner provider selection) into AgentCapForwardParams', async () => {
    // Task 7.5a: a grouped runner (`execution.group`) on an AGENT can host two
    // co-located addons registering the SAME collection cap — exactly like the
    // hub-local-uds case, which already carries this hint via
    // `LocalChildRegistry.toCapCall`'s `addonId`. AgentCapForwardParams had no
    // field for it, so the agent side could never disambiguate. `dispatch`
    // accepts an optional 4th `addonId` argument (mirrors deviceId, which is
    // extracted from args — but addonId is a distinct out-of-band selector the
    // caller already resolved, e.g. `buildCapCallFn`'s `deps.addonId`).
    const broker = makeFakeBroker()
    const nodeCaps = new Map<string, FakeNodeSpec>([
      [
        'dev-agent-0',
        {
          capName: 'network-access',
          addonId: 'tailscale-ingress',
          isAgent: true,
          agentChildId: 'net-access',
        },
      ],
    ])
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, new Set(['dev-agent-0'])),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('network-access', { nodeId: 'dev-agent-0' })
    expect(route.kind).toBe('agent-child-forward')

    await resolver.dispatch(route, 'getStatus', {}, 'tailscale-ingress')

    expect(broker.callSpy).toHaveBeenCalledOnce()
    const [, params] = broker.callSpy.mock.calls[0] as [string, unknown, unknown]
    expect(params).toMatchObject({
      capName: 'network-access',
      method: 'getStatus',
      args: {},
      addonId: 'tailscale-ingress',
    })
  })

  it('propagates the cap method timeoutMs to the forward broker.call timeout (long-op fix)', async () => {
    // A long-running cap method (e.g. server-management.applyServerUpdate, which
    // stages an npm install synchronously before replying) declares a large
    // `timeoutMs`. The forward MUST carry it as broker.call { timeout } so the
    // agent-child-forward does not `Request is timed out` under the default 60s.
    const broker = makeFakeBroker()
    const nodeCaps = new Map<string, FakeNodeSpec>([
      [
        'dev-agent-0',
        {
          capName: 'server-management',
          addonId: 'agent-runtime',
          isAgent: true,
          agentChildId: undefined,
        },
      ],
    ])
    const LONG_TIMEOUT_MS = 16 * 60_000
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(nodeCaps, new Set(['dev-agent-0'])),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
      capTimeoutMs: (capName, method) =>
        capName === 'server-management' && method === 'applyServerUpdate'
          ? LONG_TIMEOUT_MS
          : undefined,
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('server-management', { nodeId: 'dev-agent-0' })
    expect(route.kind).toBe('agent-child-forward')

    await resolver.dispatch(route, 'applyServerUpdate', { version: '1.1.59' })

    expect(broker.callSpy).toHaveBeenCalledOnce()
    const [action, , opts] = broker.callSpy.mock.calls[0] as [
      string,
      unknown,
      { nodeID?: string; timeout?: number },
    ]
    expect(action).toBe(AGENT_CAP_FWD_ACTION)
    expect(opts.timeout).toBe(LONG_TIMEOUT_MS)
  })

  it('constants match expected literal wire values (drift guard for Task 6)', () => {
    expect(AGENT_CAP_FWD_SERVICE).toBe('$agent-cap-fwd')
    expect(AGENT_CAP_FWD_ACTION).toBe('$agent-cap-fwd.forward')
  })
})

// ---------------------------------------------------------------------------
// resolveCapRoute – no-provider error, no broker call
// ---------------------------------------------------------------------------

describe('CapRouteResolver – no-provider error', () => {
  it('throws CapRouteError{reason:no-provider} when nobody provides the cap', () => {
    const broker = makeFakeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    const resolver = new CapRouteResolver(deps)

    expect(() => resolver.resolveCapRoute('ghost-cap', {})).toThrow(CapRouteError)
    expect(() => resolver.resolveCapRoute('ghost-cap', {})).toThrow(/no-provider/)
    expect(broker.callSpy).not.toHaveBeenCalled()
  })

  it('CapRouteError carries the expected reason field', () => {
    const broker = makeFakeBroker()
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    const resolver = new CapRouteResolver(deps)

    let thrown: unknown
    try {
      resolver.resolveCapRoute('ghost-cap', {})
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CapRouteError)
    expect((thrown as CapRouteError).reason).toBe('no-provider')
    expect(broker.callSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// resolveHubLocalUdsRoute — native-fallback helper that ignores in-hub shadows
// ---------------------------------------------------------------------------

describe('CapRouteResolver – resolveHubLocalUdsRoute (ignores in-hub shadow)', () => {
  it('returns the hub-local-uds route even when an in-hub provider shadows the cap name', () => {
    // 'snapshot' has BOTH an in-hub provider (a wrapper) AND a hub-local child.
    const shadowRef: InProcessProviderRef = { invoke: vi.fn() }
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: makeFakeBroker(),
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map([['snapshot', 'provider-reolink']])),
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map([['snapshot', shadowRef]])),
    }
    const resolver = new CapRouteResolver(deps)

    // resolveCapRoute is shadowed by the in-hub provider...
    expect(resolver.resolveCapRoute('snapshot', { nodeId: HUB_NODE_ID }).kind).toBe(
      'hub-in-process',
    )
    // ...but resolveHubLocalUdsRoute reaches the native child.
    const route = resolver.resolveHubLocalUdsRoute('snapshot')
    expect(route).not.toBeNull()
    expect(route?.kind).toBe('hub-local-uds')
    expect(route?.childId).toBe('provider-reolink')
  })

  it('returns null when no hub-local child provides the cap', () => {
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: makeFakeBroker(),
      hubLocalRegistry: makeFakeHubLocalRegistry(new Map()),
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    const resolver = new CapRouteResolver(deps)
    expect(resolver.resolveHubLocalUdsRoute('snapshot', 7)).toBeNull()
  })

  it('returns null when the UDS registry is unavailable (no false hub-local route)', () => {
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: makeFakeBroker(),
      hubLocalRegistry: null,
      nodeAuthority: makeFakeNodeAuthority(new Map(), new Set()),
      inProcessProviders: makeFakeInProcessProviders(new Map()),
    }
    const resolver = new CapRouteResolver(deps)
    expect(resolver.resolveHubLocalUdsRoute('snapshot', 7)).toBeNull()
  })
})
