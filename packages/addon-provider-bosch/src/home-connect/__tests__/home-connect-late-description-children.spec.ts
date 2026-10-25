import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceType, type IScopedLogger } from '@camstack/types'
import type { HomeConnectChildBinding } from '../home-connect-child-bindings.js'
import {
  HomeConnectChildReconciler,
  persistedChildBindingsFromConfig,
} from '../home-connect-child-reconciler.js'
import {
  trackHomeConnectContainers,
  type HomeConnectTrackableDevice,
} from '../home-connect-container-tracker.js'
import { HomeConnectConnectionResolver } from '../home-connect-gateway.js'
import { dishwasherCompactJson, HA_ID } from './dishwasher-iddf-fixture.js'
import { makeFakeClient } from './fake-client.js'

const APPLIANCE = { haId: HA_ID, name: 'Kitchen', type: 'Dishwasher', availablePrograms: [] }
const CONTAINER = 28

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

afterEach(() => {
  vi.useRealTimers()
})

describe('a container whose IDDF arrives after boot', () => {
  it('is watched once the runner restored it, and derives its event children when the description lands', async () => {
    vi.useFakeTimers()
    const resolver = new HomeConnectConnectionResolver()
    const applied: (readonly HomeConnectChildBinding[])[] = []
    // As saved on the live hub: no `entities`, only the legacy children the device publishes.
    let config: Record<string, unknown> = {
      system: 'home-connect',
      brokerId: 'int_0004',
      haId: HA_ID,
      children: [
        { role: 'energy-forecast', stableIdSuffix: 'energy-forecast', name: 'Energy forecast' },
        {
          role: 'remote-control-level',
          stableIdSuffix: 'remote-control-level',
          name: 'Remote control level',
        },
      ],
    }
    const reconciler = new HomeConnectChildReconciler({
      watch: (id, haId, listener) => resolver.watch(id, haId, listener),
      getClient: (id) => resolver.getClient(id),
      readPersisted: async () => persistedChildBindingsFromConfig(config),
      applyEntities: async (_deviceId, entities) => {
        applied.push(entities)
        config = { ...config, entities }
      },
      logger: logger(),
      debounceMs: 100,
    })
    // Boots degraded: connected, values flowing, no IDDF yet.
    const client = makeFakeClient({ appliances: [APPLIANCE], link: 'connected' })
    resolver.set('int_0004', { appliances: [APPLIANCE], client })

    // The forked runner's order: onInitialize runs BEFORE the device restore, so the
    // first pass sees no devices; the restore then registers the container.
    let restored: readonly HomeConnectTrackableDevice[] = []
    const deps = {
      listDevices: async () => restored,
      loadConfig: async () => config,
      reconciler,
      logger: logger(),
    }
    expect(await trackHomeConnectContainers(deps, 'init')).toBe(0)
    restored = [{ id: CONTAINER, type: DeviceType.Container }]
    expect(await trackHomeConnectContainers(deps, 'restore')).toBe(1)
    expect(reconciler.tracks(CONTAINER)).toBe(true)

    await vi.advanceTimersByTimeAsync(100)
    expect(applied).toEqual([])

    // The IDDF lands late (boot enrich finishing, or the retry's setDescription).
    await client.setDescription(HA_ID, dishwasherCompactJson())
    await vi.advanceTimersByTimeAsync(100)

    expect(applied).toHaveLength(1)
    const events = (applied[0] ?? []).filter((b) => b.convert === 'event-active')
    expect(events.map((b) => b.key)).toEqual(
      expect.arrayContaining([
        'Dishcare.Dishwasher.Event.RinseAidLack',
        'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
      ]),
    )
    expect(events.every((b) => b.cap === 'binary')).toBe(true)

    // The legacy children survive with their own suffixes (same device ids): the derived
    // EnergyForecast binding takes the existing suffix rather than adding a second child.
    const first = applied[0] ?? []
    const energy = first.filter((b) => b.key === 'BSH.Common.Option.EnergyForecast')
    expect(energy.map((b) => b.stableIdSuffix)).toEqual(['energy-forecast'])
    // RemoteControlLevel is not in this description: ONE read is not enough to delete it (D49).
    expect(first.map((b) => b.stableIdSuffix)).toContain('remote-control-level')

    // A second read that agrees removes it.
    client.emitFeature(HA_ID, 'BSH.Common.Setting.ChildLock', true)
    await vi.advanceTimersByTimeAsync(100)
    const second = applied.at(-1) ?? []
    expect(second.map((b) => b.stableIdSuffix)).not.toContain('remote-control-level')
    expect(second.map((b) => b.stableIdSuffix)).toContain('energy-forecast')
  })

  it('never tracks the same container twice, and ignores devices that are not appliance containers', async () => {
    const tracked = new Set<number>()
    const reconciler = {
      tracks: (id: number) => tracked.has(id),
      track: (a: { readonly deviceId: number }) => {
        tracked.add(a.deviceId)
      },
    }
    const deps = {
      listDevices: async () => [
        { id: CONTAINER, type: DeviceType.Container },
        { id: 29, type: DeviceType.Dishwasher },
      ],
      loadConfig: async () => ({ system: 'home-connect', brokerId: 'int_0004', haId: HA_ID }),
      reconciler,
      logger: logger(),
    }
    expect(await trackHomeConnectContainers(deps, 'restore')).toBe(1)
    expect(await trackHomeConnectContainers(deps, 'connected')).toBe(0)
    expect([...tracked]).toEqual([CONTAINER])
  })
})
