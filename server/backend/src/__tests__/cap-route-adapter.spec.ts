/**
 * Unit tests for the two adapter factories and the resolver wired with them.
 *
 * Exercises:
 *  - createNodeCapAuthority: delegates to HubNodeRegistry correctly
 *  - createInProcessProviderLookup: invokes provider methods cast-free
 *  - Resolver wired with both adapters:
 *      hub-local UDS child cap resolves via callCapOnChild
 *      hub-resident singleton resolves in-process (invoke called)
 *      absent cap throws CapRouteError (NOT the old opaque string)
 *
 * We test the adapter factories directly + a resolver wired with them —
 * standing up a full MoleculerService is too heavy for a unit test, and
 * testing the adapters + resolver in isolation exercises the meaningful unit.
 */

import type { CapRouteResolverDeps, HubLocalChildDispatcher } from '@camstack/system'
import { CapRouteError, CapRouteResolver } from '@camstack/system'
import { describe, expect, it, vi } from 'vitest'
import {
  createHubResidentProviderLookup,
  createInProcessProviderLookup,
  createNodeCapAuthority,
} from '../core/moleculer/cap-route-authority.js'

// ---------------------------------------------------------------------------
// Helpers for stub HubNodeRegistry
// ---------------------------------------------------------------------------

interface StubNodeEntry {
  readonly addonId: string
  readonly capabilities: readonly string[]
}

function makeNodeRegistry(nodes: ReadonlyMap<string, readonly StubNodeEntry[]>) {
  return {
    getNodeManifest(nodeId: string) {
      return nodes.get(nodeId)
    },
    listNodeIds(): readonly string[] {
      return [...nodes.keys()]
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers for stub CapabilityService
// ---------------------------------------------------------------------------

function makeCapabilityService(providers: ReadonlyMap<string, Record<string, unknown>>) {
  return {
    getSingleton<T>(capability: string): T | null {
      return (providers.get(capability) as T) ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// createNodeCapAuthority
// ---------------------------------------------------------------------------

describe('createNodeCapAuthority', () => {
  const nodes = new Map([
    [
      'hub/stream-broker',
      [{ addonId: 'addon-stream-broker', capabilities: ['stream-broker', 'stream-params'] }],
    ],
    ['dev-agent-0', [{ addonId: 'addon-detection-pipeline', capabilities: ['pipeline-executor'] }]],
  ])
  const registry = makeNodeRegistry(nodes)
  const authority = createNodeCapAuthority(registry)

  it('nodeKnowsCap returns true when the node manifest includes the cap', () => {
    expect(authority.nodeKnowsCap('hub/stream-broker', 'stream-broker')).toBe(true)
    expect(authority.nodeKnowsCap('hub/stream-broker', 'stream-params')).toBe(true)
    expect(authority.nodeKnowsCap('hub/stream-broker', 'ghost-cap')).toBe(false)
  })

  it('nodeKnowsCap returns false for unknown nodes', () => {
    expect(authority.nodeKnowsCap('not-a-node', 'stream-broker')).toBe(false)
  })

  it('getAddonId returns the addonId for a known cap', () => {
    expect(authority.getAddonId('hub/stream-broker', 'stream-broker')).toBe('addon-stream-broker')
    expect(authority.getAddonId('dev-agent-0', 'pipeline-executor')).toBe(
      'addon-detection-pipeline',
    )
  })

  it('getAddonId returns null for missing nodes or caps', () => {
    expect(authority.getAddonId('not-a-node', 'stream-broker')).toBeNull()
    expect(authority.getAddonId('hub/stream-broker', 'ghost-cap')).toBeNull()
  })

  it('nodeIsAgent: hub and hub-children are NOT agents; bare-id non-hub nodes are agents', () => {
    expect(authority.nodeIsAgent('hub')).toBe(false)
    expect(authority.nodeIsAgent('hub/stream-broker')).toBe(false)
    expect(authority.nodeIsAgent('dev-agent-0')).toBe(true)
    expect(authority.nodeIsAgent('some-remote-agent')).toBe(true)
  })

  it('nodeOnline: nodes in the registry are online; absent ones are not', () => {
    expect(authority.nodeOnline('hub/stream-broker')).toBe(true)
    expect(authority.nodeOnline('dev-agent-0')).toBe(true)
    expect(authority.nodeOnline('not-registered')).toBe(false)
  })

  it('listNodeIds returns all registered node ids', () => {
    const ids = authority.listNodeIds()
    expect(ids).toContain('hub/stream-broker')
    expect(ids).toContain('dev-agent-0')
    expect(ids).toHaveLength(2)
  })

  it('getAgentChildId always returns null (hub cannot resolve; Task 6 handles it)', () => {
    expect(authority.getAgentChildId('dev-agent-0', 'pipeline-executor')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createNodeCapAuthority — per-node singleton override
// ---------------------------------------------------------------------------

describe('createNodeCapAuthority — per-node singleton override', () => {
  it('getAddonId honors the per-node singleton override when available', () => {
    const nodeRegistry = {
      getNodeManifest: (id: string) =>
        id === 'dev-agent-0'
          ? [
              { addonId: 'webrtc-native', capabilities: ['webrtc-session'] },
              { addonId: 'stream-broker', capabilities: ['webrtc-session'] },
            ]
          : undefined,
      listNodeIds: () => ['hub', 'dev-agent-0'],
    }
    const authority = createNodeCapAuthority(nodeRegistry, {
      resolveSingleton: (cap, nodeId) =>
        cap === 'webrtc-session' && nodeId === 'dev-agent-0' ? 'stream-broker' : null,
    })
    expect(authority.getAddonId('dev-agent-0', 'webrtc-session')).toBe('stream-broker')
  })

  it('getAddonId falls back to first manifest match without an override', () => {
    const nodeRegistry = {
      getNodeManifest: (id: string) =>
        id === 'dev-agent-0'
          ? [{ addonId: 'webrtc-native', capabilities: ['webrtc-session'] }]
          : undefined,
      listNodeIds: () => ['hub', 'dev-agent-0'],
    }
    const authority = createNodeCapAuthority(nodeRegistry, { resolveSingleton: () => null })
    expect(authority.getAddonId('dev-agent-0', 'webrtc-session')).toBe('webrtc-native')
  })
})

// ---------------------------------------------------------------------------
// createInProcessProviderLookup
// ---------------------------------------------------------------------------

describe('createInProcessProviderLookup', () => {
  it('returns null for a cap not hosted in-process', () => {
    const lookup = createInProcessProviderLookup(makeCapabilityService(new Map()))
    expect(lookup('device-manager')).toBeNull()
  })

  it('returns an InProcessProviderRef whose invoke delegates to the provider method', async () => {
    const getStatusImpl = vi.fn().mockReturnValue({ ok: true })
    const providers = new Map<string, Record<string, unknown>>([
      ['device-manager', { getStatus: getStatusImpl }],
    ])
    const lookup = createInProcessProviderLookup(makeCapabilityService(providers))

    const ref = lookup('device-manager')
    expect(ref).not.toBeNull()

    const result = await ref!.invoke('getStatus', { deviceId: 1 })
    expect(result).toEqual({ ok: true })
    expect(getStatusImpl).toHaveBeenCalledOnce()
    expect(getStatusImpl).toHaveBeenCalledWith({ deviceId: 1 })
  })

  it('invoke throws a typed Error when the method is not a function (never casts)', async () => {
    const providers = new Map<string, Record<string, unknown>>([
      ['device-manager', { notAFn: 'some-string' }],
    ])
    const lookup = createInProcessProviderLookup(makeCapabilityService(providers))
    const ref = lookup('device-manager')
    expect(ref).not.toBeNull()

    await expect(ref!.invoke('notAFn', {})).rejects.toThrow(/method "notAFn" not found/)
    await expect(ref!.invoke('missingMethod', {})).rejects.toThrow(
      /method "missingMethod" not found/,
    )
  })
})

// ---------------------------------------------------------------------------
// createHubResidentProviderLookup — node-accurate, NO elected fallback
// ---------------------------------------------------------------------------

describe('createHubResidentProviderLookup', () => {
  function makeNodeAwareCapabilityService(opts: {
    readonly elected?: Record<string, unknown>
    readonly hubResident?: Record<string, unknown>
  }) {
    return {
      getSingleton<T>(_capability: string): T | null {
        return (opts.elected as T) ?? null
      },
      getSingletonForNode<T>(_capability: string, nodeId: string): T | null {
        return nodeId === 'hub' ? ((opts.hubResident as T) ?? null) : null
      },
    }
  }

  it('returns null when the hub hosts no resident provider — even with a cluster-elected (remote) one', () => {
    // Regression: the elected singleton can be a REMOTE proxy object in the
    // hub registry; it must NOT satisfy a hub-resident lookup.
    const remoteProxy = { createSession: vi.fn() }
    const lookup = createHubResidentProviderLookup(
      makeNodeAwareCapabilityService({ elected: remoteProxy }),
    )
    expect(lookup('decoder')).toBeNull()
  })

  it('resolves the hub-resident provider when one exists', async () => {
    const createSessionImpl = vi.fn().mockReturnValue({ sessionId: 's1', nodeId: 'hub' })
    const lookup = createHubResidentProviderLookup(
      makeNodeAwareCapabilityService({
        elected: { createSession: vi.fn() },
        hubResident: { createSession: createSessionImpl },
      }),
    )
    const ref = lookup('decoder')
    expect(ref).not.toBeNull()
    await expect(ref!.invoke('createSession', { codec: 'h264' })).resolves.toEqual({
      sessionId: 's1',
      nodeId: 'hub',
    })
    expect(createSessionImpl).toHaveBeenCalledWith({ codec: 'h264' })
  })

  it('returns null when the service lacks getSingletonForNode (no unsafe fallback)', () => {
    const lookup = createHubResidentProviderLookup(
      makeCapabilityService(new Map([['decoder', { createSession: vi.fn() }]])),
    )
    expect(lookup('decoder')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Resolver wired with both adapters
// ---------------------------------------------------------------------------

describe('Resolver + adapters — end-to-end dispatch', () => {
  const HUB_NODE_ID = 'hub'

  function makeCallCapOnChildSpy() {
    return vi.fn(async (_childId: string, _input: unknown) => ({ ok: true, from: 'uds' }))
  }

  function makeHubLocalRegistry(
    caps: ReadonlyMap<string, string>,
  ): HubLocalChildDispatcher & { callSpy: ReturnType<typeof vi.fn> } {
    const callSpy = makeCallCapOnChildSpy()
    return {
      resolveChildId: (capName: string) => caps.get(capName) ?? null,
      callCapOnChild: callSpy,
      callSpy,
    }
  }

  it('hub-local UDS child cap resolves via callCapOnChild', async () => {
    // Registry: stream-broker is served by a hub-local child.
    const nodes = new Map([
      ['hub/stream-broker', [{ addonId: 'addon-stream-broker', capabilities: ['stream-broker'] }]],
    ])
    const nodeRegistry = makeNodeRegistry(nodes)
    const authority = createNodeCapAuthority(nodeRegistry)

    const hubLocalCaps = new Map([['stream-broker', 'addon-stream-broker']])
    const hubLocalRegistry = makeHubLocalRegistry(hubLocalCaps)

    const lookup = createInProcessProviderLookup(makeCapabilityService(new Map()))

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry,
      nodeAuthority: authority,
      inProcessProviders: lookup,
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('stream-broker', { nodeId: HUB_NODE_ID })
    expect(route.kind).toBe('hub-local-uds')

    const result = await resolver.dispatch(route, 'attachCamera', { deviceId: 5 })
    expect(result).toEqual({ ok: true, from: 'uds' })
    expect(hubLocalRegistry.callSpy).toHaveBeenCalledOnce()
  })

  it('hub-resident singleton resolves in-process via invoke', async () => {
    const invokeSpy = vi.fn().mockResolvedValue({ devices: [] })
    const providers = new Map<string, Record<string, unknown>>([
      ['device-manager', { listAll: invokeSpy }],
    ])
    const lookup = createInProcessProviderLookup(makeCapabilityService(providers))

    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: null,
      nodeAuthority: createNodeCapAuthority(makeNodeRegistry(new Map())),
      inProcessProviders: lookup,
    }

    const resolver = new CapRouteResolver(deps)
    const route = resolver.resolveCapRoute('device-manager', { nodeId: HUB_NODE_ID })
    expect(route.kind).toBe('hub-in-process')

    const result = await resolver.dispatch(route, 'listAll', {})
    expect(result).toEqual({ devices: [] })
    expect(invokeSpy).toHaveBeenCalledOnce()
  })

  it('genuinely-absent cap throws CapRouteError, NOT the old opaque string', () => {
    const deps: CapRouteResolverDeps = {
      hubNodeId: HUB_NODE_ID,
      broker: { call: vi.fn(), waitForServices: vi.fn() },
      hubLocalRegistry: null,
      nodeAuthority: createNodeCapAuthority(makeNodeRegistry(new Map())),
      inProcessProviders: createInProcessProviderLookup(makeCapabilityService(new Map())),
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
    // Must NOT be the old opaque string
    expect((thrown as CapRouteError).message).not.toContain(
      'Capability "ghost-cap" not available on node',
    )
  })
})
