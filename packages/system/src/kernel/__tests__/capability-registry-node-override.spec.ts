import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityRegistry } from '../capability-registry.js'
import type { IScopedLogger } from '@camstack/types'

function createMockLogger(): IScopedLogger {
  return {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: function () {
      return this as IScopedLogger
    },
    withTags: function () {
      return this as IScopedLogger
    },
  }
}

const singletonDef = (name: string) => ({
  name,
  mode: 'singleton' as const,
  scope: 'system' as const,
  methods: {},
})

describe('CapabilityRegistry — per-node singleton override', () => {
  let reg: CapabilityRegistry

  beforeEach(() => {
    reg = new CapabilityRegistry(createMockLogger())
    reg.declareCapability(singletonDef('webrtc-session'))
    // hub providers (bare keys) + an agent provider (addonId@nodeId)
    reg.registerProvider('webrtc-session', 'stream-broker', { id: 'stream-broker' })
    reg.registerProvider('webrtc-session', 'webrtc-native', { id: 'webrtc-native' })
    reg.registerProvider('webrtc-session', 'webrtc-native@dev-agent-0', {
      id: 'webrtc-native',
      nodeId: 'dev-agent-0',
    })
    reg.ready()
  })

  it('groups providers by node (bare → hub, @node → agent)', () => {
    const byNode = reg.getProvidersByNode('webrtc-session')
    expect(byNode.get('hub')?.toSorted()).toEqual(['stream-broker', 'webrtc-native'])
    expect(byNode.get('dev-agent-0')).toEqual(['webrtc-native'])
  })

  it('resolves first-available when no override/global default', () => {
    expect(reg.resolveSingletonAddonIdForNode('webrtc-session', 'dev-agent-0')).toBe(
      'webrtc-native',
    )
  })

  it('honors the global default when available on the node', async () => {
    await reg.setActiveSingleton('webrtc-session', 'stream-broker')
    expect(reg.resolveSingletonAddonIdForNode('webrtc-session', 'hub')).toBe('stream-broker')
    // agent has no stream-broker → falls back to its first available
    expect(reg.resolveSingletonAddonIdForNode('webrtc-session', 'dev-agent-0')).toBe(
      'webrtc-native',
    )
  })

  it('per-node override beats the global default', async () => {
    await reg.setActiveSingleton('webrtc-session', 'stream-broker') // global
    await reg.setActiveSingleton('webrtc-session', 'webrtc-native', 'hub') // hub override
    expect(reg.resolveSingletonAddonIdForNode('webrtc-session', 'hub')).toBe('webrtc-native')
  })

  it('rejects an override for an addon not present on the node', async () => {
    await expect(
      reg.setActiveSingleton('webrtc-session', 'stream-broker', 'dev-agent-0'),
    ).rejects.toThrow(/not available on node/)
  })

  it('clears a per-node override (inherit global)', async () => {
    await reg.setActiveSingleton('webrtc-session', 'stream-broker')
    await reg.setActiveSingleton('webrtc-session', 'webrtc-native', 'hub')
    reg.clearSingletonNodeOverride('webrtc-session', 'hub')
    expect(reg.resolveSingletonAddonIdForNode('webrtc-session', 'hub')).toBe('stream-broker')
  })

  it('listCapabilities exposes the per-node view', async () => {
    await reg.setActiveSingleton('webrtc-session', 'webrtc-native', 'dev-agent-0')
    const info = reg.listCapabilities().find((c) => c.name === 'webrtc-session')!
    const agent = info.perNode?.find((n) => n.nodeId === 'dev-agent-0')
    expect(agent).toMatchObject({ resolvedActive: 'webrtc-native', hasOverride: true })
  })

  /**
   * Regression — the admin-ui SPA 404 boot race (2026-07-13): an agent
   * node's agent-ui registered the cluster-shared `admin-ui` cap FIRST,
   * the cluster election picked it, and the hub bootstrap's
   * `getSingleton('admin-ui')` handed back the REMOTE provider whose
   * `staticDir` lives on another machine — so the SPA catch-all never
   * registered and every `GET /` 404'd until a restart re-rolled the
   * election. A caller that reads the provider's files from local disk
   * must resolve node-scoped.
   */
  it('getSingletonForNode(hub) never resolves a remote registration, even when it won the cluster election', () => {
    const fresh = new CapabilityRegistry(createMockLogger())
    fresh.declareCapability(singletonDef('admin-ui'))
    // Remote node registers FIRST → becomes the cluster-elected active.
    fresh.registerProvider('admin-ui', 'agent-ui@agent-a', {
      id: 'agent-ui',
      nodeId: 'agent-a',
    })
    fresh.registerProvider('admin-ui', 'admin-ui', { id: 'admin-ui' })
    fresh.ready()
    // The cluster-global election is the remote one (the hazard)…
    expect(fresh.getSingletonAddonId('admin-ui')).toBe('agent-ui@agent-a')
    // …but the hub-scoped resolution must stay on this node.
    expect(fresh.resolveSingletonAddonIdForNode('admin-ui', 'hub')).toBe('admin-ui')
    const hubProvider = fresh.getSingletonForNode<{ id: string }>('admin-ui', 'hub')
    expect(hubProvider?.id).toBe('admin-ui')
  })
})
