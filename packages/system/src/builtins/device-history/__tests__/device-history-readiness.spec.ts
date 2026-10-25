/**
 * device-history is `ready` when its STORE is open, not when its provider is
 * registered.
 *
 * `.50`, 1.2.607, every boot: the provider registered at `onInitialize`, the
 * base class emitted `ready` at once (and again from `postBrokerStart`), and
 * every producer that declares on `ready` — metrics-native, pipeline-analytics
 * — got "device-history is starting — the history store is not open yet",
 * because the store only opens in `onHubReachable`.
 */
import type { AddonContext, SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceHistoryAddon } from '../device-history.addon.js'
import { openRealDoor, type RealDoor, silentLogger } from './support/real-door.js'

interface ReadinessView {
  readonly capName: string
  readonly state: string
  readonly scope: { readonly type: string; readonly nodeId?: string }
}

function isReadinessView(value: unknown): value is ReadinessView {
  return (
    typeof value === 'object' &&
    value !== null &&
    'capName' in value &&
    'state' in value &&
    'scope' in value
  )
}

function readiness(events: readonly SystemEvent[], capName: string): string[] {
  return events
    .filter((e) => e.category === 'system.ready-state')
    .flatMap((e): ReadinessView[] => {
      const data: unknown = e.data
      return isReadinessView(data) ? [data] : []
    })
    .filter((d) => d.capName === capName && d.scope.type === 'node' && d.scope.nodeId === 'hub')
    .map((d) => d.state)
}

let rd: RealDoor | null = null
afterEach(async () => {
  await rd?.close()
  rd = null
})

function fakeContext(door: RealDoor['door'], events: SystemEvent[]): AddonContext {
  const ctx = {
    id: 'device-history',
    logger: silentLogger(),
    kernel: { localNodeId: 'hub/device-history' },
    eventBus: {
      emit: (event: SystemEvent) => {
        events.push(event)
      },
      subscribe: () => () => undefined,
    },
    settings: { readAddonStore: async () => ({}) },
    addDisposer: () => undefined,
    api: {
      settingsStore: door,
      deviceManager: {
        listAll: { query: async () => [] },
        getDevice: { query: async () => null },
        listDeletedSince: { query: async () => ({ deleted: [], cursor: 0 }) },
      },
      deviceState: {
        getAllSnapshots: { query: async () => ({}) },
        getCapSlice: { query: async () => null },
      },
    },
  }
  // Documented test-only type boundary: a narrowed AddonContext carrying only
  // what device-history's boot reaches for.
  return ctx as unknown as AddonContext
}

describe('device-history readiness', () => {
  it('emits ready only once the store is open, and declareSeries then answers', async () => {
    rd = await openRealDoor()
    const events: SystemEvent[] = []
    const addon = new DeviceHistoryAddon()
    const init = await addon.initialize(fakeContext(rd.door, events))
    addon.postBrokerStart()

    expect(readiness(events, 'device-history')).not.toContain('ready')
    expect(readiness(events, 'device-removal-hook')).not.toContain('ready')

    const providers = init !== undefined && 'providers' in init ? (init.providers ?? []) : []
    const history = providers.find((p) => p.capability.name === 'device-history')?.provider
    const declare = (): Promise<unknown> =>
      Reflect.apply(Reflect.get(history ?? {}, 'declareSeries'), history, [
        {
          name: 'level',
          subjectKind: 'node',
          kind: 'gauge',
          displayName: 'Level',
          ingest: 'points',
          callerAddonId: 'metrics-native',
        },
      ])
    await expect(declare()).rejects.toThrow(/starting/)

    await addon.onHubReachable()
    expect(readiness(events, 'device-history')).toEqual(['starting', 'ready'])
    expect(readiness(events, 'device-removal-hook')).toEqual(['starting', 'ready'])
    await expect(declare()).resolves.toEqual({ key: 'addon:metrics-native/level' })

    await addon.shutdown()
    expect(readiness(events, 'device-history').at(-1)).toBe('down')
  })
})
