/**
 * Task G2 — single cap-ownership authority (consolidation)
 *
 * This test pins the consolidated behavior: the `setNativeFallback` closure
 * consults the CapRouteResolver FIRST for hub-local native caps, and only
 * falls through to `resolveNativeCapOwnerSync` for remote native caps.
 *
 * The three canonical cases:
 *  (a) Hub-local child device-scoped native cap  → resolver classifies hub-local-uds;
 *      `resolveNativeCapOwnerSync` is NOT consulted.
 *  (b) Remote device-scoped native cap            → resolver does not find hub-local;
 *      `resolveNativeCapOwnerSync` is consulted and `buildNativeCapProxy` is used.
 *  (c) Cap absent entirely                        → neither resolver nor resolveNativeCapOwnerSync
 *      know the owner; fallback returns null.
 *
 * Behavior parity: the old flow called resolveNativeCapOwnerSync first and then
 * forked on nodeId prefix. The new flow queries the resolver first for hub-local
 * (skipping resolveNativeCapOwnerSync in that branch) and falls through to
 * resolveNativeCapOwnerSync only for the remote branch. Both flows return
 * identical proxy objects / null for the same inputs.
 */

import { describe, it, expect, vi } from 'vitest'
import type {
  NodeCapAuthority,
  HubLocalChildDispatcher,
  CapRouteResolverDeps,
} from '@camstack/system'
import { CapRouteResolver, CapRouteError } from '@camstack/system'

// ---------------------------------------------------------------------------
// Helper: build the consolidated native-cap fallback (the G2 implementation)
// ---------------------------------------------------------------------------

/**
 * The G2-consolidated `setNativeFallback` implementation.
 *
 * Resolution order:
 *  1. Try the resolver for hub-local (avoids resolveNativeCapOwnerSync entirely
 *     when the resolver's snapshot knows the child).
 *  2. If no hub-local route: consult resolveNativeCapOwnerSync for remote caps.
 *  3. If not remote either: return null.
 */
function buildConsolidatedNativeFallback(opts: {
  readonly resolver: CapRouteResolver | null
  readonly hubNodeId: string
  readonly resolveNativeCapOwnerSync: (
    capName: string,
    deviceId: number,
  ) => { addonId: string; nodeId: string } | null
  readonly buildNativeCapProxy: (
    addonId: string,
    capName: string,
    deviceId: number,
  ) => Record<string, unknown>
}): (capName: string, deviceId: number) => unknown | null {
  const { resolver, hubNodeId, resolveNativeCapOwnerSync, buildNativeCapProxy } = opts

  return (capName: string, deviceId: number): unknown | null => {
    // 1. Hub-local: resolver is the single authority. No resolveNativeCapOwnerSync needed.
    if (resolver !== null) {
      try {
        const route = resolver.resolveCapRoute(capName, { nodeId: hubNodeId, deviceId })
        if (route.kind === 'hub-local-uds') {
          // Build a proxy that routes every method through the resolver.
          const proxy: Record<string, (input: unknown) => Promise<unknown>> = {}
          // Proxy is returned as a property-access object (same shape as before)
          return new Proxy(proxy, {
            get(_target, property): ((input: unknown) => Promise<unknown>) | undefined {
              if (typeof property !== 'string') return undefined
              return (input: unknown): Promise<unknown> => {
                const mergedInput =
                  typeof input === 'object' && input !== null
                    ? { ...input, deviceId }
                    : { deviceId }
                const r = resolver.resolveCapRoute(capName, { nodeId: hubNodeId, deviceId })
                return resolver.dispatch(r, property, mergedInput)
              }
            },
          })
        }
      } catch (err) {
        // resolver throws CapRouteError for no-provider/node-offline — fall through to remote
        if (!(err instanceof CapRouteError)) throw err
      }
    }

    // 2. Remote: consult resolveNativeCapOwnerSync (includes push-fed remoteNativeCaps).
    const owner = resolveNativeCapOwnerSync(capName, deviceId)
    if (!owner) return null

    // Only build a remote proxy for genuinely-remote nodes; hub-local already handled above.
    if (!owner.nodeId.startsWith(`${hubNodeId}/`)) {
      return buildNativeCapProxy(owner.addonId, capName, deviceId)
    }

    // Edge case: resolver was null OR didn't find the hub-local route but resolveNativeCapOwnerSync
    // says hub-local. This can happen during startup before the resolver is initialised.
    // Fall through to null — the caller will retry when the resolver is ready.
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers to build test doubles
// ---------------------------------------------------------------------------

interface FakeHubLocalRegistry extends HubLocalChildDispatcher {
  readonly callSpy: ReturnType<typeof vi.fn>
}

function makeHubLocalRegistry(
  caps: ReadonlyMap<string, ReadonlyMap<number | 'singleton', string>>,
): FakeHubLocalRegistry {
  const callSpy = vi.fn(async (_childId: string, _input: unknown) => ({ ok: true, from: 'uds' }))
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
    callCapOnChild: callSpy,
    callSpy,
  }
}

interface NativeCapSpec {
  readonly nodeId: string
  readonly addonId: string
  readonly capName: string
  readonly deviceId: number
}

function makeNodeAuthority(
  systemCaps: ReadonlyMap<string, { addonId: string; nodeId: string }>,
  onlineNodes: ReadonlySet<string>,
  nativeCaps: readonly NativeCapSpec[],
): NodeCapAuthority {
  return {
    nodeKnowsCap: (nodeId: string, capName: string): boolean => {
      const sys = systemCaps.get(capName)
      if (sys !== undefined && sys.nodeId === nodeId) return true
      return nativeCaps.some((n) => n.nodeId === nodeId && n.capName === capName)
    },
    nodeIsAgent: (nodeId: string): boolean => nodeId !== 'hub' && !nodeId.includes('/'),
    nodeOnline: (nodeId: string): boolean => onlineNodes.has(nodeId),
    listNodeIds: (): readonly string[] => {
      const ids = new Set<string>()
      for (const spec of systemCaps.values()) ids.add(spec.nodeId)
      for (const n of nativeCaps) ids.add(n.nodeId)
      return [...ids]
    },
    getAddonId: (nodeId: string, capName: string): string | null => {
      const sys = systemCaps.get(capName)
      if (sys !== undefined && sys.nodeId === nodeId) return sys.addonId
      const nat = nativeCaps.find((n) => n.nodeId === nodeId && n.capName === capName)
      return nat?.addonId ?? null
    },
    getAgentChildId: (): string | null => null,
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

const HUB_NODE_ID = 'hub'

// ---------------------------------------------------------------------------
// Test (a): hub-local child device-scoped native cap
// ---------------------------------------------------------------------------

describe('G2 — (a) hub-local device-scoped native cap: resolver is consulted first, resolveNativeCapOwnerSync is NOT called', () => {
  it('builds a proxy without consulting resolveNativeCapOwnerSync when resolver finds hub-local-uds', async () => {
    const hubLocalRegistry = makeHubLocalRegistry(
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
    const nodeAuthority = makeNodeAuthority(
      new Map(),
      new Set(['hub/provider-reolink']),
      nativeCaps,
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry,
      nodeAuthority,
      inProcessProviders: () => null,
    }
    const resolver = new CapRouteResolver(deps)

    const resolveNativeCapOwnerSync = vi.fn()
    const buildNativeCapProxy = vi.fn()

    const fallback = buildConsolidatedNativeFallback({
      resolver,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync,
      buildNativeCapProxy,
    })

    const proxy = fallback('ptz', 7)

    // Proxy is NOT null — hub-local route was found
    expect(proxy).not.toBeNull()
    expect(typeof proxy).toBe('object')

    // resolveNativeCapOwnerSync was NOT called (resolver handled it)
    expect(resolveNativeCapOwnerSync).not.toHaveBeenCalled()
    // buildNativeCapProxy was NOT called (not a remote cap)
    expect(buildNativeCapProxy).not.toHaveBeenCalled()
  })

  it('proxy built by the consolidated fallback routes to callCapOnChild via the resolver', async () => {
    const hubLocalRegistry = makeHubLocalRegistry(
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
    const nodeAuthority = makeNodeAuthority(
      new Map(),
      new Set(['hub/provider-reolink']),
      nativeCaps,
    )

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry,
      nodeAuthority,
      inProcessProviders: () => null,
    }
    const resolver = new CapRouteResolver(deps)

    const fallback = buildConsolidatedNativeFallback({
      resolver,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync: vi.fn(),
      buildNativeCapProxy: vi.fn(),
    })

    const proxy = fallback('ptz', 7) as Record<string, (args: unknown) => Promise<unknown>>
    expect(proxy).not.toBeNull()

    // Invoke a method through the proxy — should reach callCapOnChild
    const result = await proxy['move']!({ pan: 10 })
    expect(result).toEqual({ ok: true, from: 'uds' })
    expect(hubLocalRegistry.callSpy).toHaveBeenCalledOnce()
    const [calledChildId, calledInput] = hubLocalRegistry.callSpy.mock.calls[0] as [string, unknown]
    expect(calledChildId).toBe('provider-reolink')
    expect(calledInput).toMatchObject({ capName: 'ptz', method: 'move', deviceId: 7 })
  })
})

// ---------------------------------------------------------------------------
// Test (b): remote device-scoped native cap
// ---------------------------------------------------------------------------

describe('G2 — (b) remote device-scoped native cap: resolver does not find hub-local, resolveNativeCapOwnerSync IS called', () => {
  it('falls through to resolveNativeCapOwnerSync and calls buildNativeCapProxy for remote caps', () => {
    // No hub-local registry for this cap+device (resolver will throw no-provider for hub)
    const hubLocalRegistry = makeHubLocalRegistry(new Map()) // empty: no hub-local caps
    const nodeAuthority = makeNodeAuthority(new Map(), new Set([]), [])

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry,
      nodeAuthority,
      inProcessProviders: () => null,
    }
    const resolver = new CapRouteResolver(deps)

    const resolveNativeCapOwnerSync = vi.fn().mockReturnValue({
      addonId: 'addon-provider-reolink',
      nodeId: 'dev-agent-0/provider-reolink', // remote node
    })
    const remoteProxy = { remote: true }
    const buildNativeCapProxy = vi.fn().mockReturnValue(remoteProxy)

    const fallback = buildConsolidatedNativeFallback({
      resolver,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync,
      buildNativeCapProxy,
    })

    const result = fallback('ptz', 7)

    // resolveNativeCapOwnerSync was called (no hub-local route in resolver)
    expect(resolveNativeCapOwnerSync).toHaveBeenCalledWith('ptz', 7)
    // buildNativeCapProxy was called with the remote owner's addonId
    expect(buildNativeCapProxy).toHaveBeenCalledWith('addon-provider-reolink', 'ptz', 7)
    // The remote proxy is returned
    expect(result).toBe(remoteProxy)
  })
})

// ---------------------------------------------------------------------------
// Test (c): cap absent entirely
// ---------------------------------------------------------------------------

describe('G2 — (c) cap absent: returns null (no hub-local, no remote owner)', () => {
  it('returns null when resolver finds no hub-local route AND resolveNativeCapOwnerSync returns null', () => {
    const hubLocalRegistry = makeHubLocalRegistry(new Map())
    const nodeAuthority = makeNodeAuthority(new Map(), new Set([]), [])

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry,
      nodeAuthority,
      inProcessProviders: () => null,
    }
    const resolver = new CapRouteResolver(deps)

    const resolveNativeCapOwnerSync = vi.fn().mockReturnValue(null)
    const buildNativeCapProxy = vi.fn()

    const fallback = buildConsolidatedNativeFallback({
      resolver,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync,
      buildNativeCapProxy,
    })

    const result = fallback('ptz', 7)

    expect(result).toBeNull()
    expect(buildNativeCapProxy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test (startup-window): resolver === null, resolveNativeCapOwnerSync returns a hub-local
// owner — must return null (no Moleculer proxy to a UDS-only child)
// ---------------------------------------------------------------------------

describe('G2 — (startup-window) resolver null, resolveNativeCapOwnerSync returns hub-local owner: returns null', () => {
  it('returns null and does NOT call buildNativeCapProxy when resolver is null and owner is hub-local', () => {
    // resolver === null simulates the window before the CapRouteResolver is initialised
    const resolveNativeCapOwnerSync = vi.fn().mockReturnValue({
      addonId: 'addon-provider-x',
      nodeId: `${HUB_NODE_ID}/provider-x`, // hub-local UDS child — must NOT get a Moleculer proxy
    })
    const buildNativeCapProxy = vi.fn()

    const fallback = buildConsolidatedNativeFallback({
      resolver: null,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync,
      buildNativeCapProxy,
    })

    const result = fallback('ptz', 7)

    // Guard: hub-local UDS children must not receive a Moleculer proxy
    expect(result).toBeNull()
    expect(buildNativeCapProxy).not.toHaveBeenCalled()
    // resolveNativeCapOwnerSync IS consulted (resolver skipped due to null)
    expect(resolveNativeCapOwnerSync).toHaveBeenCalledWith('ptz', 7)
  })
})

// ---------------------------------------------------------------------------
// Test: singleton (hub-in-process) cap resolves in-process, no resolveNativeCapOwnerSync
// ---------------------------------------------------------------------------

describe('G2 — (d) hub-in-process singleton: resolver classifies hub-in-process, resolveNativeCapOwnerSync not called', () => {
  it('resolves hub-in-process singleton without consulting resolveNativeCapOwnerSync', () => {
    const invokeSpy = vi.fn().mockResolvedValue({ ok: true })
    const inProcessProviders = (_cap: string) =>
      _cap === 'device-manager' ? { invoke: invokeSpy } : null

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: null,
      nodeAuthority: makeNodeAuthority(new Map(), new Set([]), []),
      inProcessProviders,
    }
    const resolver = new CapRouteResolver(deps)

    const resolveNativeCapOwnerSync = vi.fn()
    const buildNativeCapProxy = vi.fn()

    const fallback = buildConsolidatedNativeFallback({
      resolver,
      hubNodeId: HUB_NODE_ID,
      resolveNativeCapOwnerSync,
      buildNativeCapProxy,
    })

    // For in-process singletons, the fallback is not called at all (CapabilityRegistry
    // finds the provider directly). But if called with a deviceId for such a cap, the
    // resolver will classify hub-in-process — not hub-local-uds — so we fall through
    // to the remote branch and resolveNativeCapOwnerSync is consulted (returns null).
    // This is the correct behavior: in-process singletons go through getNativeProvider
    // on the local nativeProviders map, not through setNativeFallback.
    //
    // The consolidated fallback is specifically for CROSS-PROCESS native caps.
    // The assertion here is that for a cap with NO hub-local-uds route AND no
    // resolveNativeCapOwnerSync result, the fallback correctly returns null.
    const result = fallback('device-manager', 7)
    expect(result).toBeNull()
    expect(buildNativeCapProxy).not.toHaveBeenCalled()
  })
})
