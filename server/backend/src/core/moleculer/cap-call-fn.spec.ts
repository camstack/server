import { describe, it, expect, vi } from 'vitest'
import type { CapRoute, CapCallInput } from '@camstack/system'
import { buildCapCallFn, type CapCallFnLocalChild, type CapCallFnResolver } from './cap-call-fn.js'

/**
 * buildCapCallFn — the per-(cap,node) dispatcher behind every CapabilityRegistry
 * provider proxy. These specs lock every routing branch so the UDS-migration
 * gap (an agent-hosted provider's cap call falling onto a `broker.call` to a
 * Moleculer node that does not exist → 30s `waitForServices` timeout) cannot
 * regress:
 *   - hub-local child that provides → per-child UDS (collection-safe)
 *   - hub-local child that does NOT provide → fail fast (NEVER Moleculer)
 *   - agent-hosted / remote → delegate to the unified CapRouteResolver
 *   - resolver not built yet → legacy broker fallback
 */

const REMOTE_ROUTE: CapRoute = { kind: 'remote-moleculer', capName: 'cap-x', nodeId: 'dev-agent-0' }

function recordingLocalChild(provides: boolean): {
  fake: CapCallFnLocalChild
  childProvidesCalls: Array<{ childId: string; capName: string; deviceId?: number }>
  callCapOnChildCalls: Array<{ childId: string; input: CapCallInput }>
} {
  const childProvidesCalls: Array<{ childId: string; capName: string; deviceId?: number }> = []
  const callCapOnChildCalls: Array<{ childId: string; input: CapCallInput }> = []
  return {
    childProvidesCalls,
    callCapOnChildCalls,
    fake: {
      childProvides: (childId, capName, deviceId) => {
        childProvidesCalls.push({ childId, capName, deviceId })
        return provides
      },
      callCapOnChild: async (childId, input) => {
        callCapOnChildCalls.push({ childId, input })
        return { from: 'uds' }
      },
    },
  }
}

function recordingResolver(): {
  fake: CapCallFnResolver
  resolveCalls: Array<{ capName: string; nodeId?: string; deviceId?: number }>
  dispatchCalls: Array<{
    route: CapRoute
    method: string
    args: unknown
    addonId?: string
    callerAddonId?: string
  }>
} {
  const resolveCalls: Array<{ capName: string; nodeId?: string; deviceId?: number }> = []
  const dispatchCalls: Array<{
    route: CapRoute
    method: string
    args: unknown
    addonId?: string
    callerAddonId?: string
  }> = []
  return {
    resolveCalls,
    dispatchCalls,
    fake: {
      resolveCapRoute: (capName, opts) => {
        resolveCalls.push({ capName, nodeId: opts.nodeId, deviceId: opts.deviceId })
        return REMOTE_ROUTE
      },
      dispatch: async (route, method, args, addonId, callerAddonId) => {
        dispatchCalls.push({ route, method, args, addonId, callerAddonId })
        return { from: 'resolver' }
      },
    },
  }
}

describe('buildCapCallFn', () => {
  it('hub-local child that provides the cap → routes per-child over UDS', async () => {
    const child = recordingLocalChild(true)
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'cap-x',
      nodeId: 'hub/benchmark',
      udsChildId: 'benchmark',
      getLocalChildRegistry: () => child.fake,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    const result = await fn('listPages', { deviceId: 7 })

    expect(result).toEqual({ from: 'uds' })
    expect(child.callCapOnChildCalls).toEqual([
      {
        childId: 'benchmark',
        input: { capName: 'cap-x', method: 'listPages', args: { deviceId: 7 }, deviceId: 7 },
      },
    ])
    expect(resolver.resolveCalls).toEqual([]) // resolver never consulted
    expect(legacy).not.toHaveBeenCalled()
  })

  it('hub-local child: the provider addonId rides the UDS input as the selection hint', async () => {
    // Grouped runner (`execution.group`): two co-located addons provide the
    // SAME collection cap, and the hub's collection mount strips `addonId`
    // from the args after resolving the provider — the out-of-band hint is
    // the only way the child picks the right co-located provider.
    const child = recordingLocalChild(true)
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'network-access',
      addonId: 'tailscale-ingress',
      nodeId: 'hub/net-access',
      udsChildId: 'net-access',
      getLocalChildRegistry: () => child.fake,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    await fn('getStatus', {})

    expect(child.callCapOnChildCalls).toEqual([
      {
        childId: 'net-access',
        input: {
          capName: 'network-access',
          method: 'getStatus',
          args: {},
          addonId: 'tailscale-ingress',
        },
      },
    ])
  })

  it('caller-stamped cap via resolver: stated identity reaches dispatch callerAddonId', async () => {
    const resolver = recordingResolver()
    const fn = buildCapCallFn({
      capName: 'records',
      addonId: 'sqlite-settings',
      nodeId: 'hub',
      udsChildId: null,
      getLocalChildRegistry: () => null,
      getResolver: () => resolver.fake,
      legacyBrokerCall: vi.fn(),
    })

    await fn('declareKinds', {
      kinds: { locations: { database: 'settings', schemaVersion: 1 } },
      callerAddonId: 'storage-orchestrator',
    })

    expect(resolver.dispatchCalls).toEqual([
      expect.objectContaining({
        method: 'declareKinds',
        callerAddonId: 'storage-orchestrator',
        addonId: 'sqlite-settings',
      }),
    ])
  })

  it('caller-stamped cap: hub in-process stated identity rides CapCallInput.callerAddonId', async () => {
    const child = recordingLocalChild(true)
    const fn = buildCapCallFn({
      capName: 'records',
      addonId: 'sqlite-settings',
      nodeId: 'hub',
      udsChildId: 'sqlite-settings',
      getLocalChildRegistry: () => child.fake,
      getResolver: () => null,
      legacyBrokerCall: vi.fn(),
    })

    await fn('declareKinds', {
      kinds: { locations: { database: 'settings', schemaVersion: 1 } },
      callerAddonId: 'storage-orchestrator',
    })

    expect(child.callCapOnChildCalls).toEqual([
      {
        childId: 'sqlite-settings',
        input: {
          capName: 'records',
          method: 'declareKinds',
          args: {
            kinds: { locations: { database: 'settings', schemaVersion: 1 } },
            callerAddonId: 'storage-orchestrator',
          },
          addonId: 'sqlite-settings',
          callerAddonId: 'storage-orchestrator',
        },
      },
    ])
  })

  it('hub-local child that does NOT provide → fails fast, never touches Moleculer', async () => {
    const child = recordingLocalChild(false)
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'cap-x',
      nodeId: 'hub/benchmark',
      udsChildId: 'benchmark',
      getLocalChildRegistry: () => child.fake,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    await expect(fn('listPages', undefined)).rejects.toThrow(/does not currently provide/)
    expect(child.callCapOnChildCalls).toEqual([])
    expect(resolver.resolveCalls).toEqual([])
    expect(resolver.dispatchCalls).toEqual([])
    expect(legacy).not.toHaveBeenCalled()
  })

  it('agent-hosted provider → delegates to the resolver (agent-child-forward)', async () => {
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'cap-x',
      nodeId: 'dev-agent-0',
      udsChildId: null, // not hub-local
      getLocalChildRegistry: () => null,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    const result = await fn('listPages', { deviceId: 3 })

    expect(result).toEqual({ from: 'resolver' })
    expect(resolver.resolveCalls).toEqual([
      { capName: 'cap-x', nodeId: 'dev-agent-0', deviceId: 3 },
    ])
    expect(resolver.dispatchCalls).toEqual([
      { route: REMOTE_ROUTE, method: 'listPages', args: { deviceId: 3 } },
    ])
    expect(legacy).not.toHaveBeenCalled()
  })

  it('agent-hosted GROUPED provider (deps.addonId set) → addonId reaches resolver.dispatch', async () => {
    // Mirrors "hub-local child: the provider addonId rides the UDS input as
    // the selection hint" above, but for a provider hosted under an AGENT.
    // Two co-located addons on an agent's grouped runner can register the
    // SAME collection cap; without the addonId hint reaching the resolver's
    // dispatch, the agent side has no way to disambiguate them (asymmetric
    // with the hub-local branch, which already threads deps.addonId onto the
    // UDS CapCallInput).
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'network-access',
      addonId: 'tailscale-ingress',
      nodeId: 'dev-agent-0',
      udsChildId: null, // not hub-local — agent-hosted
      getLocalChildRegistry: () => null,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    await fn('getStatus', {})

    expect(resolver.dispatchCalls).toEqual([
      { route: REMOTE_ROUTE, method: 'getStatus', args: {}, addonId: 'tailscale-ingress' },
    ])
    expect(legacy).not.toHaveBeenCalled()
  })

  it('explicit targetNodeId overrides the registered nodeId in resolution', async () => {
    const resolver = recordingResolver()
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>()
    const fn = buildCapCallFn({
      capName: 'cap-x',
      nodeId: 'dev-agent-0',
      udsChildId: null,
      getLocalChildRegistry: () => null,
      getResolver: () => resolver.fake,
      legacyBrokerCall: legacy,
    })

    await fn('listPages', undefined, 'dev-agent-1')

    expect(resolver.resolveCalls).toEqual([
      { capName: 'cap-x', nodeId: 'dev-agent-1', deviceId: undefined },
    ])
  })

  it('resolver not yet built → falls back to the legacy broker call', async () => {
    const legacy = vi.fn<(m: string, p: unknown, n: string) => Promise<unknown>>(async () => ({
      from: 'legacy',
    }))
    const fn = buildCapCallFn({
      capName: 'cap-x',
      nodeId: 'dev-agent-0',
      udsChildId: null,
      getLocalChildRegistry: () => null,
      getResolver: () => null, // pre-init window
      legacyBrokerCall: legacy,
    })

    const result = await fn('listPages', { deviceId: 1 })

    expect(result).toEqual({ from: 'legacy' })
    expect(legacy).toHaveBeenCalledWith('listPages', { deviceId: 1 }, 'dev-agent-0')
  })
})
