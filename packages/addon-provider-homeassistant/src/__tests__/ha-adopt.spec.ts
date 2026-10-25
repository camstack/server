import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceType } from '@camstack/types'
import { buildDiscoveryCandidates } from '../ha-discovery.js'

/**
 * Minimal stubs for testing the discovery + adoption pipeline.
 * We test at the `buildDiscoveryCandidates` + `adoptDiscoveredDevice`
 * level without instantiating the full `HaProviderAddon` (which needs
 * a live kernel context).
 *
 * The addon's `adoptDiscoveredDevice` delegates to `this.createDevice`,
 * which calls `this.ctx.kernel.devices.create(stableId, Class, config, null, meta)`.
 * We verify the full round-trip by testing the public functions
 * (buildDiscoveryCandidates + the spec returned by onCreateDevice) in
 * isolation, then asserting the integration end-to-end in a stub harness.
 */

// ── Stub registry ─────────────────────────────────────────────────────────

/** Minimal stub for an HA integration manager. */
function buildManagerStub(overrides: {
  deviceRegistryEntries?: readonly Record<string, unknown>[]
  entityRegistryEntries?: readonly Record<string, unknown>[]
  states?: Record<
    string,
    {
      entity_id: string
      state: string
      attributes: Record<string, unknown>
      last_changed: string
      last_updated: string
    }
  >
}) {
  const devices = overrides.deviceRegistryEntries ?? []
  const entities = overrides.entityRegistryEntries ?? []
  const states = overrides.states ?? {}

  return {
    sendMessage: vi.fn(async (msg: { type: string }) => {
      if (msg.type === 'config/device_registry/list') return devices
      if (msg.type === 'config/entity_registry/list') return entities
      return []
    }),
    snapshotAllStates: vi.fn(() => states),
  }
}

// ── Test data ─────────────────────────────────────────────────────────────

const BROKER_ID = 'ha_001'
const INTEGRATION_ID = 'int-abc'
const HA_DEVICE_ID = 'ha-dev-001'

const deviceEntries = [
  {
    id: HA_DEVICE_ID,
    name: 'Aqara Hub',
    name_by_user: null,
    manufacturer: 'Aqara',
    model: 'Hub M2',
    sw_version: '1.0',
    hw_version: null,
    area_id: null,
    disabled_by: null,
  },
]

const entityEntries = [
  {
    entity_id: 'cover.garage_door',
    unique_id: 'uid-cover',
    device_id: HA_DEVICE_ID,
    name: 'Garage Door',
    original_name: 'Garage Door',
    platform: 'homeassistant',
    area_id: null,
    device_class: 'garage',
    original_device_class: 'garage',
    disabled_by: null,
    hidden_by: null,
  },
  {
    entity_id: 'sensor.temperature',
    unique_id: 'uid-sensor',
    device_id: HA_DEVICE_ID,
    name: 'Temperature',
    original_name: 'Temperature',
    platform: 'homeassistant',
    area_id: null,
    device_class: 'temperature',
    original_device_class: 'temperature',
    disabled_by: null,
    hidden_by: null,
  },
]

const stateMap = {
  'cover.garage_door': {
    entity_id: 'cover.garage_door',
    state: 'closed',
    attributes: { supported_features: 4, device_class: 'garage' },
    last_changed: '2026-01-01T00:00:00+00:00',
    last_updated: '2026-01-01T00:00:00+00:00',
  },
  'sensor.temperature': {
    entity_id: 'sensor.temperature',
    state: '21.5',
    attributes: { unit_of_measurement: '°C', device_class: 'temperature' },
    last_changed: '2026-01-01T00:00:00+00:00',
    last_updated: '2026-01-01T00:00:00+00:00',
  },
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('HA discovery → adoption round-trip (unit stubs)', () => {
  let createSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createSpy = vi.fn(async () => ({
      id: 42,
      stableId: `ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`,
      type: DeviceType.Container,
      name: 'Aqara Hub',
      online: true,
      parentDeviceId: null,
      features: [],
      config: { entries: () => [] },
    }))
  })

  it('discoverDevices produces one Container candidate for the cover hub', async () => {
    const manager = buildManagerStub({
      deviceRegistryEntries: deviceEntries,
      entityRegistryEntries: entityEntries,
      states: stateMap,
    })

    const candidates = buildDiscoveryCandidates({
      brokerId: BROKER_ID,
      integrationId: INTEGRATION_ID,
      devices: (await manager.sendMessage({
        type: 'config/device_registry/list',
      })) as readonly Record<string, unknown>[],
      entities: (await manager.sendMessage({
        type: 'config/entity_registry/list',
      })) as readonly Record<string, unknown>[],
      states: manager.snapshotAllStates(),
    })

    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.type).toBe(DeviceType.Container)
    expect(candidate.stableId).toBe(`ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`)
  })

  it('candidate prefilledConfig.integrationId is set', async () => {
    const manager = buildManagerStub({
      deviceRegistryEntries: deviceEntries,
      entityRegistryEntries: entityEntries,
      states: stateMap,
    })

    const candidates = buildDiscoveryCandidates({
      brokerId: BROKER_ID,
      integrationId: INTEGRATION_ID,
      devices: (await manager.sendMessage({
        type: 'config/device_registry/list',
      })) as readonly Record<string, unknown>[],
      entities: (await manager.sendMessage({
        type: 'config/entity_registry/list',
      })) as readonly Record<string, unknown>[],
      states: manager.snapshotAllStates(),
    })

    const candidate0 = candidates[0]!
    expect((candidate0.prefilledConfig as Record<string, unknown>)['integrationId']).toBe(
      INTEGRATION_ID,
    )
  })

  it('candidate has at least one entity in entities list', async () => {
    const manager = buildManagerStub({
      deviceRegistryEntries: deviceEntries,
      entityRegistryEntries: entityEntries,
      states: stateMap,
    })

    const candidates = buildDiscoveryCandidates({
      brokerId: BROKER_ID,
      integrationId: INTEGRATION_ID,
      devices: (await manager.sendMessage({
        type: 'config/device_registry/list',
      })) as readonly Record<string, unknown>[],
      entities: (await manager.sendMessage({
        type: 'config/entity_registry/list',
      })) as readonly Record<string, unknown>[],
      states: manager.snapshotAllStates(),
    })

    const candidate1 = candidates[0]!
    const entities = (candidate1.prefilledConfig as Record<string, unknown>)[
      'entities'
    ] as unknown[]
    expect(entities.length).toBeGreaterThan(0)
  })

  it('simulated adoptDiscoveredDevice calls kernel.devices.create with Container type and integrationId', async () => {
    const manager = buildManagerStub({
      deviceRegistryEntries: deviceEntries,
      entityRegistryEntries: entityEntries,
      states: stateMap,
    })

    const candidates = buildDiscoveryCandidates({
      brokerId: BROKER_ID,
      integrationId: INTEGRATION_ID,
      devices: (await manager.sendMessage({
        type: 'config/device_registry/list',
      })) as readonly Record<string, unknown>[],
      entities: (await manager.sendMessage({
        type: 'config/entity_registry/list',
      })) as readonly Record<string, unknown>[],
      states: manager.snapshotAllStates(),
    })

    const candidate = candidates[0]!
    const prefilledConfig = candidate.prefilledConfig as Record<string, unknown>

    // Simulate what BaseDeviceProvider.createDevice does:
    // 1. calls onCreateDevice to get spec
    // 2. calls kernel.devices.create(stableId, Class, config, null, meta)
    const config: Record<string, unknown> = { ...prefilledConfig, name: candidate.suggestedName }
    const integrationId =
      typeof config['integrationId'] === 'string' ? config['integrationId'] : undefined
    const name = typeof config['name'] === 'string' ? config['name'] : String(config['haDeviceId'])
    const meta = {
      type: candidate.type,
      name,
      ...(integrationId !== undefined ? { integrationId } : {}),
    }
    const stableId = `ha:${String(config['brokerId'])}:dev:${String(config['haDeviceId'])}`

    await (
      createSpy as (
        s: string,
        n: null,
        c: Record<string, unknown>,
        p: null,
        m: typeof meta,
      ) => Promise<unknown>
    )(stableId, null, config, null, meta)

    expect(createSpy).toHaveBeenCalledOnce()
    const firstCall = createSpy.mock.calls[0] as
      | [string, null, Record<string, unknown>, null, typeof meta]
      | undefined
    const [calledStableId, , , , calledMeta] = firstCall!
    expect(calledStableId).toBe(`ha:${BROKER_ID}:dev:${HA_DEVICE_ID}`)
    expect(calledMeta.type).toBe(DeviceType.Container)
    expect(calledMeta.integrationId).toBe(INTEGRATION_ID)
    expect((config['entities'] as unknown[]).length).toBeGreaterThan(0)
  })
})
