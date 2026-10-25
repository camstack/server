/**
 * Spec for the per-node singleton extension in capabilities.router, over a
 * REAL `CapabilityRegistry` (the stub it used to take answered no
 * capabilities, which the persist-first write now refuses — D675 amendment).
 *
 * Exercises:
 *  - setActiveSingleton with nodeId → per-node override live
 *    + persists `capabilities.singletonNode.<cap>.<nodeId>`
 *  - setActiveSingleton without nodeId → persists `capabilities.singleton.<cap>` (global key)
 *  - clearSingletonNodeOverride → override cleared live + the per-node key persisted as null
 *
 * The write ORDER (persist before the live switch) is pinned in
 * `capability-preference-write-order.spec.ts`.
 */
import { CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createCapabilitiesRouter } from '../../api/core/capabilities.router.js'
import { makeCtx } from './harness.js'

const quietLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => quietLogger,
  withTags: () => quietLogger,
}

function harness() {
  const registry = new CapabilityRegistry(quietLogger)
  registry.declareCapability({
    name: 'webrtc-session',
    scope: 'system',
    mode: 'singleton',
    methods: {},
  })
  registry.registerProvider('webrtc-session', 'stream-broker', { id: 'broker' })
  registry.registerProvider('webrtc-session', 'webrtc-native@dev-agent-0', { id: 'native' })
  registry.ready()
  const sets: Record<string, unknown> = {}
  const config = {
    set: async (k: string, v: unknown): Promise<void> => {
      sets[k] = v
    },
  }
  const router = createCapabilitiesRouter(registry, config)
  return { router, sets, registry }
}

describe('capabilities.router — per-node singleton', () => {
  it('setActiveSingleton with nodeId persists the per-node key', async () => {
    const { router, sets, registry } = harness()
    const caller = router.createCaller(makeCtx('admin'))
    await caller.setActiveSingleton({
      capability: 'webrtc-session',
      addonId: 'webrtc-native',
      nodeId: 'dev-agent-0',
    })
    expect(registry.getSingletonNodeOverrides('webrtc-session').get('dev-agent-0')).toBe(
      'webrtc-native',
    )
    expect(sets['capabilities.singletonNode.webrtc-session.dev-agent-0']).toBe('webrtc-native')
  })

  it('setActiveSingleton without nodeId persists the global key', async () => {
    const { router, sets } = harness()
    const caller = router.createCaller(makeCtx('admin'))
    await caller.setActiveSingleton({ capability: 'webrtc-session', addonId: 'stream-broker' })
    expect(sets['capabilities.singleton.webrtc-session']).toBe('stream-broker')
  })

  it('clearSingletonNodeOverride clears the per-node key', async () => {
    const { router, sets, registry } = harness()
    await registry.setActiveSingleton('webrtc-session', 'webrtc-native', 'dev-agent-0')
    const caller = router.createCaller(makeCtx('admin'))
    await caller.clearSingletonNodeOverride({ capability: 'webrtc-session', nodeId: 'dev-agent-0' })
    expect(registry.getSingletonNodeOverrides('webrtc-session').has('dev-agent-0')).toBe(false)
    expect(sets['capabilities.singletonNode.webrtc-session.dev-agent-0']).toBe(null)
  })
})
