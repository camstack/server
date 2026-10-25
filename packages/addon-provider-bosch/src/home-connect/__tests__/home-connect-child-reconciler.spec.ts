import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import type { HomeConnectChildBinding } from '../home-connect-child-bindings.js'
import {
  HomeConnectChildReconciler,
  mergeChildBindings,
  parsePersistedBindings,
} from '../home-connect-child-reconciler.js'
import { HomeConnectConnectionResolver } from '../home-connect-gateway.js'
import { dishwasherCompactJson, dishwasherDescription, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient } from './fake-client.js'

const APPLIANCE = { haId: HA_ID, name: 'Kitchen', type: 'Dishwasher', availablePrograms: [] }

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function harness(initial: readonly HomeConnectChildBinding[] = []) {
  const resolver = new HomeConnectConnectionResolver()
  let persisted: readonly HomeConnectChildBinding[] = initial
  let malformed = 0
  const applied: (readonly HomeConnectChildBinding[])[] = []
  const reconciler = new HomeConnectChildReconciler({
    watch: (id, haId, listener) => resolver.watch(id, haId, listener),
    getClient: (id) => resolver.getClient(id),
    readPersisted: async () => ({ bindings: persisted, malformed }),
    applyEntities: async (_deviceId, entities) => {
      applied.push(entities)
      persisted = entities
    },
    logger: logger(),
    debounceMs: 100,
  })
  return {
    resolver,
    reconciler,
    applied,
    setMalformed: (n: number) => (malformed = n),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HomeConnectChildReconciler', () => {
  it('derives the children from the description once the appliance is connected', async () => {
    vi.useFakeTimers()
    const h = harness()
    const client = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      features: { [HA_ID]: { 'BSH.Common.Setting.ChildLock': false } },
    })
    h.resolver.set('int', { appliances: [APPLIANCE], client })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toHaveLength(1)
    const keys = h.applied[0]?.map((b) => b.key) ?? []
    expect(keys).toContain('BSH.Common.Status.DoorState')
    expect(keys).toContain('Dishcare.Dishwasher.Event.SaltNearlyEmpty')
    expect(keys).toContain('BSH.Common.Setting.ChildLock')
  })

  it('does nothing while the link is down or the description is missing (empty is not "no entities")', async () => {
    vi.useFakeTimers()
    const h = harness()
    const down = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      link: 'disconnected',
    })
    h.resolver.set('int', { appliances: [APPLIANCE], client: down })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    await vi.advanceTimersByTimeAsync(100)
    const bare = makeFakeClient({ appliances: [APPLIANCE], link: 'connected' })
    h.resolver.set('int', { appliances: [APPLIANCE], client: bare })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toEqual([])
  })

  it('a value that appears later adds its child; applying the same set twice is a no-op', async () => {
    vi.useFakeTimers()
    const h = harness()
    const client = makeFakeClient({ appliances: [APPLIANCE], description: dishwasherCompactJson() })
    h.resolver.set('int', { appliances: [APPLIANCE], client })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    await vi.advanceTimersByTimeAsync(100)
    const before = h.applied.length
    expect(h.applied[before - 1]?.some((b) => b.key === 'BSH.Common.Setting.ChildLock')).toBe(false)

    client.emitFeature(HA_ID, 'BSH.Common.Setting.ChildLock', true)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toHaveLength(before + 1)
    expect(h.applied.at(-1)?.some((b) => b.key === 'BSH.Common.Setting.ChildLock')).toBe(true)

    client.emitFeature(HA_ID, 'BSH.Common.Setting.ChildLock', false)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toHaveLength(before + 1)
  })

  it('a dropped link never removes a child (the value being unknown is not the entity vanishing)', async () => {
    vi.useFakeTimers()
    const h = harness()
    const client = makeFakeClient({
      appliances: [APPLIANCE],
      description: dishwasherCompactJson(),
      features: { [HA_ID]: { 'BSH.Common.Setting.ChildLock': true } },
    })
    h.resolver.set('int', { appliances: [APPLIANCE], client })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    await vi.advanceTimersByTimeAsync(100)
    const count = h.applied.length
    client.emitLink(HA_ID, 'disconnected')
    await vi.advanceTimersByTimeAsync(100)
    client.emitLink(HA_ID, 'connected') // values cleared on the drop
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toHaveLength(count)
  })

  it('stop() ends every watch and timer', async () => {
    vi.useFakeTimers()
    const h = harness()
    const client = makeFakeClient({ appliances: [APPLIANCE], description: dishwasherCompactJson() })
    h.resolver.set('int', { appliances: [APPLIANCE], client })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    h.reconciler.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.applied).toEqual([])
  })
})

describe('mergeChildBindings', () => {
  const description = dishwasherDescription()
  const binding = (key: string): HomeConnectChildBinding => ({
    stableIdSuffix: key.toLowerCase().replace(/\./g, '-'),
    key,
    cap: 'enum-sensor',
    convert: 'none',
    role: 'enum-sensor' as HomeConnectChildBinding['role'],
    name: key,
  })

  it('drops what the description no longer lists only when a second read agrees (D49)', () => {
    const persisted = [binding('BSH.Common.Status.DoorState'), binding('Gone.Feature')]
    const once = mergeChildBindings(persisted, [], description)
    expect(once.map((b) => b.key)).toEqual(['BSH.Common.Status.DoorState', 'Gone.Feature'])
    const twice = mergeChildBindings(persisted, [], description, new Set(['Gone.Feature']))
    expect(twice.map((b) => b.key)).toEqual(['BSH.Common.Status.DoorState'])
  })

  it('keeps info / network children whatever the description says', () => {
    const merged = mergeChildBindings([binding('HomeConnect.Info.vib')], [], description)
    expect(merged).toHaveLength(1)
  })
})

describe('parsePersistedBindings', () => {
  it('counts malformed rows instead of throwing or hiding them', () => {
    expect(parsePersistedBindings(undefined)).toEqual({ bindings: [], malformed: 0 })
    expect(parsePersistedBindings([{ nope: true }, null])).toEqual({ bindings: [], malformed: 2 })
  })
})

describe('HomeConnectChildReconciler — unreadable persisted rows', () => {
  it('writes nothing while a persisted row cannot be read (it would lose that child)', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setMalformed(1)
    const client = makeFakeClient({ appliances: [APPLIANCE], description: dishwasherCompactJson() })
    h.resolver.set('int', { appliances: [APPLIANCE], client })
    h.reconciler.track({ deviceId: 42, brokerId: 'int', haId: HA_ID })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.applied).toEqual([])
  })
})
