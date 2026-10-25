/**
 * Task 5 — TDD tests: device-scoped native cap routing through CapRouteResolver.
 *
 * Covers:
 *  1. A device-scoped native cap on a HUB-LOCAL child resolves to hub-local-uds
 *     and dispatches via callCapOnChild with {capName, method, args:{...deviceId}, deviceId}.
 *  2. d9ba709 regression guard: a singleton cap on BOTH a hub-local child AND a remote
 *     node, resolved WITHOUT explicit nodeId, classifies to hub-local (not remote).
 *  3. A remote device-scoped native cap builds the ${addonId}.native-provider.${cap}.${method}
 *     action (NATIVE_PROVIDER_SERVICE_INFIX).
 *  4. nodeKnowsCap returns true for native caps (not just manifest caps).
 */

import { describe, it, expect, vi } from 'vitest'
import { CapRouteResolver, NATIVE_PROVIDER_SERVICE_INFIX } from '@camstack/system'
import type {
  NodeCapAuthority,
  HubLocalChildDispatcher,
  CapRouteResolverDeps,
  InProcessProviderRef,
} from '@camstack/system'
import { CapRouteError } from '@camstack/system'

const HUB_NODE_ID = 'hub'

// ---------------------------------------------------------------------------
// Fake HubLocalChildDispatcher with deviceId-aware resolveChildId
// ---------------------------------------------------------------------------

interface FakeHubLocalRegistry extends HubLocalChildDispatcher {
  readonly callCapOnChildSpy: ReturnType<typeof vi.fn>
}

/**
 * Build a fake registry that supports device-scoped cap resolution.
 * The caps map is {capName → {deviceId? → childId}} or {capName → childId} for singletons.
 */
function makeDeviceAwareHubLocalRegistry(
  caps: ReadonlyMap<string, ReadonlyMap<number | 'singleton', string>>,
): FakeHubLocalRegistry {
  const callCapOnChildSpy = vi.fn(async (_childId: string, _input: unknown) => ({
    ok: true,
    from: 'uds',
  }))
  return {
    resolveChildId: (capName: string, deviceId?: number): string | null => {
      const capMap = caps.get(capName)
      if (capMap === undefined) return null
      if (deviceId !== undefined) {
        const deviceSpecific = capMap.get(deviceId)
        if (deviceSpecific !== undefined) return deviceSpecific
      }
      return capMap.get('singleton') ?? null
    },
    callCapOnChild: callCapOnChildSpy,
    callCapOnChildSpy,
  }
}

// ---------------------------------------------------------------------------
// Fake NodeCapAuthority with native-cap awareness
// ---------------------------------------------------------------------------

interface NativeCapSpec {
  readonly nodeId: string
  readonly addonId: string
  readonly capName: string
  readonly deviceId: number
}

function makeNativeAwareNodeAuthority(
  systemCaps: ReadonlyMap<string, { addonId: string; nodeId: string }>,
  onlineNodes: ReadonlySet<string>,
  nativeCaps: readonly NativeCapSpec[],
): NodeCapAuthority {
  return {
    nodeKnowsCap: (nodeId: string, capName: string): boolean => {
      // Check system (manifest) caps
      const sys = systemCaps.get(capName)
      if (sys !== undefined && sys.nodeId === nodeId) return true
      // Check native caps (any deviceId for this node+capName)
      return nativeCaps.some((n) => n.nodeId === nodeId && n.capName === capName)
    },

    nodeIsAgent: (nodeId: string): boolean => nodeId !== HUB_NODE_ID && !nodeId.includes('/'),

    nodeOnline: (nodeId: string): boolean => onlineNodes.has(nodeId),

    listNodeIds: (): readonly string[] => {
      const ids = new Set<string>()
      for (const spec of systemCaps.values()) ids.add(spec.nodeId)
      for (const n of nativeCaps) ids.add(n.nodeId)
      return [...ids]
    },

    getAddonId: (nodeId: string, capName: string): string | null => {
      // Check system (manifest) caps
      const sys = systemCaps.get(capName)
      if (sys !== undefined && sys.nodeId === nodeId) return sys.addonId
      // Check native caps
      const nat = nativeCaps.find((n) => n.nodeId === nodeId && n.capName === capName)
      return nat?.addonId ?? null
    },

    getAgentChildId: (_agentNodeId: string, _capName: string): string | null => null,

    isNativeCap: (nodeId: string, capName: string, deviceId?: number): boolean => {
      if (deviceId !== undefined) {
        return nativeCaps.some(
          (n) => n.nodeId === nodeId && n.capName === capName && n.deviceId === deviceId,
        )
      }
      return nativeCaps.some((n) => n.nodeId === nodeId && n.capName === capName)
    },
  }
}

// ---------------------------------------------------------------------------
// Test 1: device-scoped native cap on hub-local child → hub-local-uds dispatch
// ---------------------------------------------------------------------------

describe('Task5 – device-scoped native cap on hub-local child', () => {
  it('resolves to hub-local-uds and calls callCapOnChild with {capName, method, args+deviceId, deviceId}', async () => {
    // ptz is a device-scoped native cap owned by hub child 'provider-reolink'
    const hubLocalCaps = makeDeviceAwareHubLocalRegistry(
      new Map([['ptz', new Map([[7, 'provider-reolink']])]]),
    )

    const nativeCaps: NativeCapSpec[] = [
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'addon-provider-reolink',
        capName: 'ptz',
        deviceId: 7,
      },
    ]
    const nodeAuthority = makeNativeAwareNodeAuthority(
      new Map(),
      new Set(['hub/provider-reolink']),
      nativeCaps,
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: hubLocalCaps,
      nodeAuthority,
      inProcessProviders: () => null,
    }

    const resolver = new CapRouteResolver(deps)

    // Resolve with deviceId = 7 so the snapshot uses the device-aware accessor
    const route = resolver.resolveCapRoute('ptz', { nodeId: HUB_NODE_ID, deviceId: 7 })
    expect(route.kind).toBe('hub-local-uds')
    if (route.kind !== 'hub-local-uds') return
    expect(route.childId).toBe('provider-reolink')

    const result = await resolver.dispatch(route, 'move', { pan: 10, deviceId: 7 })
    expect(result).toEqual({ ok: true, from: 'uds' })

    expect(hubLocalCaps.callCapOnChildSpy).toHaveBeenCalledOnce()
    const [calledChildId, calledInput] = hubLocalCaps.callCapOnChildSpy.mock.calls[0] as [
      string,
      unknown,
    ]
    expect(calledChildId).toBe('provider-reolink')
    expect(calledInput).toMatchObject({
      capName: 'ptz',
      method: 'move',
      args: { pan: 10, deviceId: 7 },
      deviceId: 7,
    })
  })

  it('resolving ptz WITHOUT deviceId does NOT match the device-scoped child (no spurious route)', () => {
    // When no deviceId hint is given, the singleton fallback fires — no deviceId-less descriptor exists
    const hubLocalCaps = makeDeviceAwareHubLocalRegistry(
      new Map([
        ['ptz', new Map([[7, 'provider-reolink']])],
        // No 'singleton' entry for ptz — ptz is strictly device-scoped
      ]),
    )
    const nodeAuthority = makeNativeAwareNodeAuthority(new Map(), new Set(), [])

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: hubLocalCaps,
      nodeAuthority,
      inProcessProviders: () => null,
    }

    const resolver = new CapRouteResolver(deps)
    // Without deviceId, no hub-local-uds route → CapRouteError
    expect(() => resolver.resolveCapRoute('ptz', { nodeId: HUB_NODE_ID })).toThrow(CapRouteError)
  })
})

// ---------------------------------------------------------------------------
// Test 2: d9ba709 regression guard — hub-local singleton beats remote
// ---------------------------------------------------------------------------

describe('Task5 – d9ba709 regression: singleton prefers hub-local over remote', () => {
  it('singleton cap provided by both hub-local child AND remote node classifies to hub-local-uds (no nodeId given)', () => {
    // 'pipeline-executor' is on BOTH local child addon-detection-pipeline AND remote-agent-0
    const hubLocalCaps = makeDeviceAwareHubLocalRegistry(
      new Map([['pipeline-executor', new Map([['singleton', 'addon-detection-pipeline']])]]),
    )

    const systemCaps = new Map([
      ['pipeline-executor', { addonId: 'addon-detection-pipeline', nodeId: 'remote-agent-0' }],
    ])
    const nodeAuthority = makeNativeAwareNodeAuthority(
      systemCaps,
      new Set(['hub/addon-detection-pipeline', 'remote-agent-0']),
      [],
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: hubLocalCaps,
      nodeAuthority,
      inProcessProviders: () => null,
    }

    const resolver = new CapRouteResolver(deps)
    // Singleton resolution (no nodeId) — must prefer hub-local-uds
    const route = resolver.resolveCapRoute('pipeline-executor', {})
    expect(route.kind).toBe('hub-local-uds')
    if (route.kind === 'hub-local-uds') {
      expect(route.childId).toBe('addon-detection-pipeline')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 3: remote device-scoped native cap uses NATIVE_PROVIDER_SERVICE_INFIX
// (Remote-moleculer path: non-agent remote node hosting a native device cap,
//  e.g. a secondary hub or a directly-wired remote runner)
// ---------------------------------------------------------------------------

describe('Task5 – remote native cap uses NATIVE_PROVIDER_SERVICE_INFIX in action name', () => {
  it('dispatches remote native cap (on non-agent remote node) with action ${addonId}.native-provider.${cap}.${method}', async () => {
    const callSpy = vi.fn(
      async (_action: string, _params: unknown, _opts?: { nodeID?: string }) => ({ ok: true }),
    )
    const broker = { call: callSpy, waitForServices: vi.fn(async () => {}) }

    // ptz is provided by a REMOTE non-agent node (contains '/' so nodeIsAgent=false)
    const remoteNodeId = 'hub-secondary/provider-reolink'
    const nativeCaps: NativeCapSpec[] = [
      { nodeId: remoteNodeId, addonId: 'addon-provider-reolink', capName: 'ptz', deviceId: 7 },
    ]
    const nodeAuthority = makeNativeAwareNodeAuthority(
      new Map(),
      new Set([remoteNodeId]),
      nativeCaps,
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: null,
      nodeAuthority,
      inProcessProviders: () => null,
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('ptz', { nodeId: remoteNodeId, deviceId: 7 })
    expect(route.kind).toBe('remote-moleculer')

    await resolver.dispatch(route, 'move', { pan: 10, deviceId: 7 })

    expect(callSpy).toHaveBeenCalledOnce()
    const call = callSpy.mock.calls[0]
    expect(call?.[0]).toBe(`addon-provider-reolink${NATIVE_PROVIDER_SERVICE_INFIX}.ptz.move`)
    expect(call?.[2]?.nodeID).toBe(remoteNodeId)
  })

  it('non-native remote cap still uses plain ${addonId}.${cap}.${method} action', async () => {
    const callSpy = vi.fn(
      async (_action: string, _params: unknown, _opts?: { nodeID?: string }) => ({ ok: true }),
    )
    const broker = { call: callSpy, waitForServices: vi.fn(async () => {}) }

    const remoteNodeId = 'hub-secondary/addon-analytics-suite'
    const systemCaps = new Map([
      ['analytics', { addonId: 'addon-analytics-suite', nodeId: remoteNodeId }],
    ])
    const nodeAuthority = makeNativeAwareNodeAuthority(
      systemCaps,
      new Set([remoteNodeId]),
      [], // no native caps
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker,
      hubLocalRegistry: null,
      nodeAuthority,
      inProcessProviders: () => null,
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('analytics', { nodeId: remoteNodeId })
    expect(route.kind).toBe('remote-moleculer')

    await resolver.dispatch(route, 'getReport', { period: 'day' })

    const action = callSpy.mock.calls[0]?.[0]
    expect(action).toBe('addon-analytics-suite.analytics.getReport')
    // Must NOT have the native infix
    expect(action).not.toContain(NATIVE_PROVIDER_SERVICE_INFIX)
  })
})

// ---------------------------------------------------------------------------
// Test 4: nodeKnowsCap returns true for native caps (not just manifest)
// ---------------------------------------------------------------------------

describe('Task5 – nodeKnowsCap includes native caps', () => {
  it('nodeKnowsCap returns true when the node has a native cap entry (even with no manifest cap)', () => {
    const nativeCaps: NativeCapSpec[] = [
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'addon-provider-reolink',
        capName: 'ptz',
        deviceId: 7,
      },
    ]
    const nodeAuthority = makeNativeAwareNodeAuthority(
      new Map(), // no system caps
      new Set(['hub/provider-reolink']),
      nativeCaps,
    )

    expect(nodeAuthority.nodeKnowsCap('hub/provider-reolink', 'ptz')).toBe(true)
    expect(nodeAuthority.nodeKnowsCap('hub/provider-reolink', 'stream-broker')).toBe(false)
    expect(nodeAuthority.nodeKnowsCap('other-node', 'ptz')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 5: native-fallback regression — an in-hub WRAPPER must not shadow the
// hub-local-uds NATIVE child for the same cap name.
//
// Reproduces the snapshot bug: the `snapshot` cap has an in-hub wrapper
// (SnapshotAddon, registered as a system singleton, so inProcessProviders
// returns a ref) AND a per-device native provider in a forked vendor child
// (provider-reolink). `resolveCapRoute` gives Priority 1 to hub-in-process,
// so it returns the WRAPPER route — never reaching the hub-local-uds native.
// The setNativeFallback resolver wants the NATIVE child specifically; it must
// use `resolveHubLocalUdsRoute`, which skips the in-process branch.
// ---------------------------------------------------------------------------

describe('native-fallback – wrapper must not shadow the hub-local native child', () => {
  // snapshot has an in-hub wrapper AND a forked native child for device 7.
  const wrapperRef: InProcessProviderRef = { invoke: vi.fn(async () => ({ from: 'wrapper' })) }

  function makeSnapshotResolver(): {
    resolver: CapRouteResolver
    hubLocalCaps: FakeHubLocalRegistry
  } {
    const hubLocalCaps = makeDeviceAwareHubLocalRegistry(
      new Map([['snapshot', new Map([[7, 'provider-reolink']])]]),
    )
    const nativeCaps: NativeCapSpec[] = [
      {
        nodeId: 'hub/provider-reolink',
        addonId: 'addon-provider-reolink',
        capName: 'snapshot',
        deviceId: 7,
      },
    ]
    const nodeAuthority = makeNativeAwareNodeAuthority(
      new Map(),
      new Set(['hub/provider-reolink']),
      nativeCaps,
    )
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: hubLocalCaps,
      nodeAuthority,
      // The wrapper occupies the in-hub slot for 'snapshot'.
      inProcessProviders: (cap: string): InProcessProviderRef | null =>
        cap === 'snapshot' ? wrapperRef : null,
    }
    return { resolver: new CapRouteResolver(deps), hubLocalCaps }
  }

  it('documents the shadow: resolveCapRoute picks the in-hub wrapper (hub-in-process)', () => {
    const { resolver } = makeSnapshotResolver()
    const route = resolver.resolveCapRoute('snapshot', { nodeId: HUB_NODE_ID, deviceId: 7 })
    // The wrapper shadows the native — this is the existing (correct for the
    // generic dispatch path) behaviour the native fallback must NOT rely on.
    expect(route.kind).toBe('hub-in-process')
  })

  it('resolveHubLocalUdsRoute returns the native child route, bypassing the wrapper shadow', () => {
    const { resolver } = makeSnapshotResolver()
    const route = resolver.resolveHubLocalUdsRoute('snapshot', 7)
    expect(route).not.toBeNull()
    expect(route?.kind).toBe('hub-local-uds')
    expect(route?.childId).toBe('provider-reolink')
  })

  it('resolveHubLocalUdsRoute returns null when no hub-local child owns the cap (lets fallback try remote)', () => {
    const { resolver } = makeSnapshotResolver()
    // device 999 has no hub-local native child
    expect(resolver.resolveHubLocalUdsRoute('snapshot', 999)).toBeNull()
    // a cap with neither wrapper nor hub-local child
    expect(resolver.resolveHubLocalUdsRoute('nonexistent', 7)).toBeNull()
  })

  it('dispatching the resolved hub-local-uds route reaches the native child (not the wrapper)', async () => {
    const { resolver, hubLocalCaps } = makeSnapshotResolver()
    const route = resolver.resolveHubLocalUdsRoute('snapshot', 7)
    expect(route).not.toBeNull()
    if (route === null) return
    const result = await resolver.dispatch(route, 'getSnapshot', { deviceId: 7 })
    expect(result).toEqual({ ok: true, from: 'uds' })
    expect(hubLocalCaps.callCapOnChildSpy).toHaveBeenCalledOnce()
    const [childId] = hubLocalCaps.callCapOnChildSpy.mock.calls[0] as [string]
    expect(childId).toBe('provider-reolink')
    // The wrapper's invoke must NOT have been called.
    expect(wrapperRef.invoke).not.toHaveBeenCalled()
  })
})
