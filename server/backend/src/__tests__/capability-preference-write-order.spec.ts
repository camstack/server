/**
 * A capability preference is PERSISTED before the live registry switches
 * (D675 amendment, 2026-09-29).
 *
 * Since D675 `ConfigManager.set` rejects when the write does not land. Every
 * caller used to switch the registry first, so a failed write reported an
 * error for a switch that was already live — and reverted at the next boot.
 * These specs drive a REAL `CapabilityRegistry` through every write path and
 * a store whose write fails: nothing live may change. And on success, the
 * store must have been written while the registry still held the OLD state.
 */
import { CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { createCapabilitiesRouter as createCoreRouter } from '../api/core/capabilities.router.js'
import { buildAddonsProvider } from '../api/core/cap-providers.js'
import { initLifecycleRunner } from '../core/lifecycle/lifecycle-runner.singleton.js'
import { makeCtx } from './cap-routers/harness.js'

const quietLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => quietLogger,
  withTags: () => quietLogger,
}

interface RegistrySnapshot {
  readonly active: string | null
  readonly disabled: readonly string[]
  readonly nodeOverride: string | null
}

/** A settings store whose write lands or fails, recording the live state it saw. */
class RecordingStore {
  readonly writes: Array<{ key: string; value: unknown; liveAtWrite: RegistrySnapshot }> = []
  failWrites = false

  constructor(private readonly observe: () => RegistrySnapshot) {}

  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error('settings door timed out')
    this.writes.push({ key, value, liveAtWrite: this.observe() })
  }
}

function buildRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry(quietLogger)
  registry.declareCapability({ name: 'decoder', scope: 'system', mode: 'singleton', methods: {} })
  registry.declareCapability({
    name: 'turn-relay',
    scope: 'system',
    mode: 'collection',
    methods: {},
  })
  registry.registerProvider('decoder', 'decoder-cpu', { id: 'cpu' })
  registry.registerProvider('decoder', 'decoder-gpu', { id: 'gpu' })
  registry.registerProvider('turn-relay', 'relay-a', { id: 'a' })
  registry.registerProvider('turn-relay', 'relay-b', { id: 'b' })
  registry.ready()
  return registry
}

function snapshot(registry: CapabilityRegistry): RegistrySnapshot {
  const caps = registry.listCapabilities()
  return {
    active: caps.find((c) => c.name === 'decoder')?.activeProvider ?? null,
    disabled: (caps.find((c) => c.name === 'turn-relay')?.disabledProviders ?? []).toSorted(),
    nodeOverride: registry.getSingletonNodeOverrides('decoder').get('hub') ?? null,
  }
}

let registry: CapabilityRegistry
let store: RecordingStore
let before: RegistrySnapshot

beforeEach(() => {
  registry = buildRegistry()
  store = new RecordingStore(() => snapshot(registry))
  before = snapshot(registry)
})

function coreCaller() {
  return createCoreRouter(registry, store).createCaller(makeCtx('admin'))
}

function addonsProvider() {
  initLifecycleRunner({
    dataDir: '/tmp/capability-preference-write-order-spec',
    fetchTarball: async () => Buffer.from(''),
    extract: async () => {},
    applyAddonUpdate: async () => {},
    emit: () => {},
  })
  // Documented type boundary, kept on purpose: `buildAddonsProvider` takes five
  // CONCRETE service classes (no port types), so a typed fake would mean
  // re-implementing each; `setCapabilityProviderEnabled` reads only the
  // registry and `store.set`, and the rest are inert stand-ins.
  const ar = { getCapabilityRegistry: () => registry }
  const moleculer = { broker: {} }
  return buildAddonsProvider(
    ar as never,
    {} as never,
    { createLogger: () => quietLogger } as never,
    moleculer as never,
    store as never,
    makeCtx('admin'),
  )
}

describe('a failed write changes nothing live', () => {
  beforeEach(() => {
    store.failWrites = true
  })

  it('core setActiveSingleton (global)', async () => {
    const other = before.active === 'decoder-gpu' ? 'decoder-cpu' : 'decoder-gpu'
    await expect(
      coreCaller().setActiveSingleton({ capability: 'decoder', addonId: other }),
    ).rejects.toThrow(/timed out/)
    expect(snapshot(registry)).toEqual(before)
  })

  it('core setActiveSingleton (per node)', async () => {
    await expect(
      coreCaller().setActiveSingleton({
        capability: 'decoder',
        addonId: 'decoder-gpu',
        nodeId: 'hub',
      }),
    ).rejects.toThrow(/timed out/)
    expect(snapshot(registry)).toEqual(before)
  })

  it('core clearSingletonNodeOverride', async () => {
    await registry.setActiveSingleton('decoder', 'decoder-gpu', 'hub')
    const overridden = snapshot(registry)
    await expect(
      coreCaller().clearSingletonNodeOverride({ capability: 'decoder', nodeId: 'hub' }),
    ).rejects.toThrow(/timed out/)
    expect(snapshot(registry)).toEqual(overridden)
  })

  it('core setCollectionEnabledProviders', async () => {
    await expect(
      coreCaller().setCollectionEnabledProviders({
        capability: 'turn-relay',
        enabledAddonIds: ['relay-b'],
      }),
    ).rejects.toThrow(/timed out/)
    expect(snapshot(registry)).toEqual(before)
  })

  it('addons.setCapabilityProviderEnabled', async () => {
    await expect(
      addonsProvider().setCapabilityProviderEnabled({
        capName: 'turn-relay',
        addonId: 'relay-a',
        enabled: false,
      }),
    ).rejects.toThrow(/timed out/)
    expect(snapshot(registry)).toEqual(before)
  })
})

describe('a write that lands is persisted BEFORE the live switch', () => {
  it('core setActiveSingleton (global) persists, then hot-swaps', async () => {
    const other = before.active === 'decoder-gpu' ? 'decoder-cpu' : 'decoder-gpu'
    await coreCaller().setActiveSingleton({ capability: 'decoder', addonId: other })
    expect(store.writes).toEqual([
      { key: 'capabilities.singleton.decoder', value: other, liveAtWrite: before },
    ])
    expect(snapshot(registry).active).toBe(other)
  })

  it('core setActiveSingleton (per node) persists the node key, then overrides', async () => {
    await coreCaller().setActiveSingleton({
      capability: 'decoder',
      addonId: 'decoder-gpu',
      nodeId: 'hub',
    })
    expect(store.writes).toEqual([
      { key: 'capabilities.singletonNode.decoder.hub', value: 'decoder-gpu', liveAtWrite: before },
    ])
    expect(snapshot(registry).nodeOverride).toBe('decoder-gpu')
  })

  it('core setCollectionEnabledProviders persists the disabled set it then applies', async () => {
    await coreCaller().setCollectionEnabledProviders({
      capability: 'turn-relay',
      enabledAddonIds: ['relay-b'],
    })
    expect(store.writes).toEqual([
      {
        key: 'capabilities.collection.turn-relay',
        value: JSON.stringify({ disabled: ['relay-a'] }),
        liveAtWrite: before,
      },
    ])
    expect(snapshot(registry).disabled).toEqual(['relay-a'])
  })

  it('addons.setCapabilityProviderEnabled persists, then disables', async () => {
    await addonsProvider().setCapabilityProviderEnabled({
      capName: 'turn-relay',
      addonId: 'relay-a',
      enabled: false,
    })
    expect(store.writes).toEqual([
      {
        key: 'capabilities.collection.turn-relay',
        value: JSON.stringify({ disabled: ['relay-a'] }),
        liveAtWrite: before,
      },
    ])
    expect(snapshot(registry).disabled).toEqual(['relay-a'])
  })

  it('two concurrent toggles on one collection persist BOTH', async () => {
    const addons = addonsProvider()
    await Promise.all([
      addons.setCapabilityProviderEnabled({
        capName: 'turn-relay',
        addonId: 'relay-a',
        enabled: false,
      }),
      addons.setCapabilityProviderEnabled({
        capName: 'turn-relay',
        addonId: 'relay-b',
        enabled: false,
      }),
    ])
    const last = store.writes.at(-1)
    expect(last?.value).toBe(JSON.stringify({ disabled: ['relay-a', 'relay-b'] }))
    expect(snapshot(registry).disabled).toEqual(['relay-a', 'relay-b'])
  })
})

describe('a refused switch persists nothing', () => {
  it('core setActiveSingleton to an unregistered provider', async () => {
    await expect(
      coreCaller().setActiveSingleton({ capability: 'decoder', addonId: 'decoder-npu' }),
    ).rejects.toThrow(/not registered/)
    expect(store.writes).toEqual([])
    expect(snapshot(registry)).toEqual(before)
  })

  it('core setActiveSingleton to a provider absent from the node', async () => {
    await expect(
      coreCaller().setActiveSingleton({
        capability: 'decoder',
        addonId: 'decoder-gpu',
        nodeId: 'agent-1',
      }),
    ).rejects.toThrow(/not available on node/)
    expect(store.writes).toEqual([])
  })

  it('a collection switched through the singleton path', async () => {
    await expect(
      coreCaller().setActiveSingleton({ capability: 'turn-relay', addonId: 'relay-a' }),
    ).rejects.toThrow(/not a singleton/)
    expect(store.writes).toEqual([])
  })
})
