import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole, type DeviceConfig, type IDevice } from '@camstack/types'
import {
  buildFreshStandaloneSpec,
  diffStandaloneEntity,
  isStandaloneEntityDevice,
  planStandaloneReconcile,
  readPersistedStandaloneSpec,
  standaloneEntityId,
  type StandaloneEntitySpec,
} from '../ha-standalone-entity.js'
import type { HaDiscoveredEntity } from '../ha-discovery-types.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

const BROKER_ID = 'ha_001'

function entity(partial: Partial<HaDiscoveredEntity> & { entityId: string }): HaDiscoveredEntity {
  return {
    entityId: partial.entityId,
    domain: partial.domain ?? partial.entityId.split('.')[0] ?? 'sensor',
    name: partial.name ?? partial.entityId,
    state: partial.state ?? 'on',
    deviceClass: partial.deviceClass ?? null,
    unitOfMeasurement: partial.unitOfMeasurement ?? null,
    area: partial.area ?? null,
    options: partial.options ?? null,
    entityCategory: partial.entityCategory ?? null,
    mappedTo: partial.mappedTo ?? null,
    alreadyAdopted: partial.alreadyAdopted ?? false,
    adoptedCamDeviceId: partial.adoptedCamDeviceId ?? null,
  }
}

/** A minimal live IDevice stub: only the fields the reconcile path reads
 *  (id, type, role, parentDeviceId, config.entries()). */
function deviceStub(args: {
  id: number
  type: DeviceType
  role?: DeviceRole
  parentDeviceId?: number | null
  config: Record<string, unknown>
}): IDevice {
  const entries = Object.entries(args.config).map(([key, value]) => ({ key, value }))
  const config = { entries: () => entries } as unknown as DeviceConfig<never>
  return {
    id: args.id,
    stableId: `ha:${BROKER_ID}:entity:${String(args.config['entityId'])}`,
    type: args.type,
    name: 'stub',
    location: null,
    disabled: false,
    parentDeviceId: args.parentDeviceId ?? null,
    ...(args.role !== undefined ? { role: args.role } : {}),
    online: true,
    features: [],
    config,
  } as unknown as IDevice
}

/** A persisted standalone switch device. */
function switchDevice(id = 501): IDevice {
  return deviceStub({
    id,
    type: DeviceType.Switch,
    config: {
      system: 'homeassistant',
      brokerId: BROKER_ID,
      entityId: 'switch.kitchen',
      capabilities: ['switch'],
    },
  })
}

// ── diffStandaloneEntity (pure) ──────────────────────────────────────────────

describe('diffStandaloneEntity', () => {
  const sw: StandaloneEntitySpec = { type: DeviceType.Switch, capabilities: ['switch'] }
  const light: StandaloneEntitySpec = {
    type: DeviceType.Light,
    capabilities: ['switch', 'brightness'],
  }

  it('reports no drift when persisted and fresh match', () => {
    expect(diffStandaloneEntity(sw, sw)).toEqual({ changed: false })
  })

  it('flags a capability drift (switch → switch+brightness) with the new type + config', () => {
    const diff = diffStandaloneEntity(sw, light)
    expect(diff.changed).toBe(true)
    expect(diff.type).toBe(DeviceType.Light)
    expect(diff.config).toMatchObject({ capabilities: ['switch', 'brightness'] })
  })

  it('does NOT treat a role-only difference as drift (Role is operator-owned)', () => {
    const a: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      role: DeviceRole.EnumSensor,
      capabilities: ['enum-sensor'],
    }
    const b: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      capabilities: ['enum-sensor'],
    }
    expect(diffStandaloneEntity(a, b)).toEqual({ changed: false })
  })

  it('on capability drift, updates type/config but never re-pushes role', () => {
    const a: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      role: DeviceRole.EnumSensor,
      capabilities: ['enum-sensor'],
    }
    const b: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      capabilities: ['power-meter'],
      unitOfMeasurement: 'W',
    }
    const diff = diffStandaloneEntity(a, b)
    expect(diff.changed).toBe(true)
    expect(diff.type).toBe(DeviceType.Sensor)
    expect(diff.role).toBeUndefined()
    expect(diff.config).toMatchObject({
      capabilities: ['power-meter'],
      unitOfMeasurement: 'W',
    })
    expect(diff.config).not.toHaveProperty('role')
  })

  it('flags a unit drift only (caps unchanged)', () => {
    const a: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
      unitOfMeasurement: '°C',
    }
    const b: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
      unitOfMeasurement: 'K',
    }
    const diff = diffStandaloneEntity(a, b)
    expect(diff.changed).toBe(true)
    expect(diff.config).toMatchObject({ unitOfMeasurement: 'K' })
  })

  // Role is operator-owned after adopt. A mapping that drops its derived role
  // (or changes it) must not trigger a rebuild and must not clear/overwrite
  // the operator's Role select via applyDerivedSpec.
  it('ignores role removal — no drift, no role in any patch', () => {
    const withRole: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      capabilities: ['power-meter'],
    }
    const withoutRole: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      capabilities: ['power-meter'],
    }
    expect(diffStandaloneEntity(withRole, withoutRole)).toEqual({ changed: false })
  })
})

// ── readPersistedStandaloneSpec / buildFreshStandaloneSpec ────────────────────

describe('standalone spec projection', () => {
  it('reads the persisted spec from a live device (type/role + config fields)', () => {
    const dev = deviceStub({
      id: 5,
      type: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'sensor.p',
        capabilities: ['power-meter'],
        unitOfMeasurement: 'W',
      },
    })
    expect(readPersistedStandaloneSpec(dev)).toEqual({
      type: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      capabilities: ['power-meter'],
      unitOfMeasurement: 'W',
    })
  })

  it('builds the fresh spec from a mapped HA entity', () => {
    const fresh = buildFreshStandaloneSpec(
      entity({
        entityId: 'light.lamp',
        mappedTo: {
          deviceType: DeviceType.Light,
          role: null,
          capabilities: ['switch', 'brightness'],
        },
      }),
    )
    expect(fresh.type).toBe(DeviceType.Light)
    expect(fresh.capabilities).toEqual(['switch', 'brightness'])
  })

  it('a persisted switch vs a fresh light entity diffs as a drift', () => {
    const persisted = readPersistedStandaloneSpec(switchDevice())
    const fresh = buildFreshStandaloneSpec(
      entity({
        entityId: 'switch.kitchen',
        mappedTo: {
          deviceType: DeviceType.Light,
          role: null,
          capabilities: ['switch', 'brightness'],
        },
      }),
    )
    expect(diffStandaloneEntity(persisted, fresh).changed).toBe(true)
  })

  it('a persisted switch vs the same fresh switch diffs as no drift', () => {
    const persisted = readPersistedStandaloneSpec(switchDevice())
    const fresh = buildFreshStandaloneSpec(
      entity({
        entityId: 'switch.kitchen',
        mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
      }),
    )
    expect(diffStandaloneEntity(persisted, fresh).changed).toBe(false)
  })

  // Fix — the per-sensor dateTimeFormat must round-trip through the standalone
  // re-sync projection (it was dropped before, so a format change went undetected).
  it('round-trips dateTimeFormat: persisted spec reads it from the config blob', () => {
    const dev = deviceStub({
      id: 10,
      type: DeviceType.Sensor,
      role: DeviceRole.EnumSensor,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'sensor.last_clean',
        capabilities: ['enum-sensor'],
        dateTimeFormat: 'datetime',
      },
    })
    expect(readPersistedStandaloneSpec(dev).dateTimeFormat).toBe('datetime')
  })

  it('drops an invalid persisted dateTimeFormat (safeParse guard)', () => {
    const dev = deviceStub({
      id: 11,
      type: DeviceType.Sensor,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'sensor.x',
        capabilities: ['enum-sensor'],
        dateTimeFormat: 'bogus',
      },
    })
    expect(readPersistedStandaloneSpec(dev).dateTimeFormat).toBeUndefined()
  })

  it('builds the fresh spec dateTimeFormat from the HA mapping', () => {
    const fresh = buildFreshStandaloneSpec(
      entity({
        entityId: 'sensor.last_clean',
        mappedTo: {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.DateTimeSensor,
          capabilities: ['enum-sensor'],
          dateTimeFormat: 'date',
        },
      }),
    )
    expect(fresh.dateTimeFormat).toBe('date')
  })

  it('detects a dateTimeFormat-only change as drift and emits it in the patch', () => {
    const persisted: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      capabilities: ['enum-sensor'],
      dateTimeFormat: 'datetime',
    }
    const fresh: StandaloneEntitySpec = {
      type: DeviceType.Sensor,
      capabilities: ['enum-sensor'],
      dateTimeFormat: 'date',
    }
    const diff = diffStandaloneEntity(persisted, fresh)
    expect(diff.changed).toBe(true)
    expect(diff.config).toMatchObject({ dateTimeFormat: 'date' })
  })
})

// ── isStandaloneEntityDevice / standaloneEntityId (enumeration predicate) ─────

describe('isStandaloneEntityDevice', () => {
  it('accepts a top-level entity device for the broker', () => {
    expect(isStandaloneEntityDevice(switchDevice(), BROKER_ID)).toBe(true)
  })
  it('rejects a Container (haDeviceId, no entityId)', () => {
    const container = deviceStub({
      id: 6,
      type: DeviceType.Container,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        haDeviceId: 'ha-dev-1',
        entities: [],
      },
    })
    expect(isStandaloneEntityDevice(container, BROKER_ID)).toBe(false)
  })
  it('rejects an accessory child (has a parent)', () => {
    const child = deviceStub({
      id: 7,
      type: DeviceType.Switch,
      parentDeviceId: 601,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'switch.x',
        capabilities: ['switch'],
      },
    })
    expect(isStandaloneEntityDevice(child, BROKER_ID)).toBe(false)
  })
  it('rejects a non-HA device (no brokerId source)', () => {
    const other = deviceStub({ id: 8, type: DeviceType.Camera, config: { foo: 'bar' } })
    expect(isStandaloneEntityDevice(other, BROKER_ID)).toBe(false)
  })
  it('rejects a standalone device on a DIFFERENT broker', () => {
    expect(isStandaloneEntityDevice(switchDevice(), 'ha_other')).toBe(false)
  })
  it('standaloneEntityId returns the entityId for a standalone device, null otherwise', () => {
    expect(standaloneEntityId(switchDevice())).toBe('switch.kitchen')
    const other = deviceStub({ id: 9, type: DeviceType.Camera, config: { foo: 'bar' } })
    expect(standaloneEntityId(other)).toBeNull()
  })
})

// ── planStandaloneReconcile (pure sweep) ─────────────────────────────────────

describe('planStandaloneReconcile', () => {
  function freshMap(entities: HaDiscoveredEntity[]): Map<string, HaDiscoveredEntity> {
    return new Map(entities.map((e) => [e.entityId, e]))
  }

  it('plans an applyDerivedSpec action for a drifted entity (switch → light)', () => {
    const devices = [switchDevice(501)]
    const fresh = freshMap([
      entity({
        entityId: 'switch.kitchen',
        mappedTo: {
          deviceType: DeviceType.Light,
          role: null,
          capabilities: ['switch', 'brightness'],
        },
      }),
    ])
    const actions = planStandaloneReconcile(devices, fresh, BROKER_ID)
    expect(actions).toHaveLength(1)
    expect(actions[0]!.deviceId).toBe(501)
    expect(actions[0]!.type).toBe(DeviceType.Light)
    expect(actions[0]!.config).toMatchObject({ capabilities: ['switch', 'brightness'] })
  })

  it('plans NO action when the entity is unchanged', () => {
    const devices = [switchDevice(501)]
    const fresh = freshMap([
      entity({
        entityId: 'switch.kitchen',
        mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
      }),
    ])
    expect(planStandaloneReconcile(devices, fresh, BROKER_ID)).toHaveLength(0)
  })

  it('ignores Containers, accessory children, non-HA and other-broker devices', () => {
    const container = deviceStub({
      id: 601,
      type: DeviceType.Container,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        haDeviceId: 'ha-dev-1',
        entities: [],
      },
    })
    const child = deviceStub({
      id: 700,
      type: DeviceType.Switch,
      parentDeviceId: 601,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'switch.kitchen',
        capabilities: ['switch'],
      },
    })
    const otherBroker = deviceStub({
      id: 800,
      type: DeviceType.Switch,
      config: {
        system: 'homeassistant',
        brokerId: 'ha_other',
        entityId: 'switch.kitchen',
        capabilities: ['switch'],
      },
    })
    const nonHa = deviceStub({ id: 900, type: DeviceType.Camera, config: { foo: 'bar' } })
    // All would-drift if considered (fresh maps switch.kitchen → light).
    const fresh = freshMap([
      entity({
        entityId: 'switch.kitchen',
        mappedTo: {
          deviceType: DeviceType.Light,
          role: null,
          capabilities: ['switch', 'brightness'],
        },
      }),
    ])
    expect(
      planStandaloneReconcile([container, child, otherBroker, nonHa], fresh, BROKER_ID),
    ).toHaveLength(0)
  })

  it('leaves a standalone device in place when its entity is GONE from HA (no crash, no action)', () => {
    const devices = [switchDevice(501)]
    const actions = planStandaloneReconcile(devices, new Map(), BROKER_ID)
    expect(actions).toHaveLength(0)
  })

  it('skips an entity that became unmapped in HA', () => {
    const devices = [switchDevice(501)]
    const fresh = freshMap([entity({ entityId: 'switch.kitchen', mappedTo: null })])
    expect(planStandaloneReconcile(devices, fresh, BROKER_ID)).toHaveLength(0)
  })

  it('plans only the drifted devices in a mixed set', () => {
    const drifted = switchDevice(501)
    const stable = deviceStub({
      id: 502,
      type: DeviceType.Switch,
      config: {
        system: 'homeassistant',
        brokerId: BROKER_ID,
        entityId: 'switch.hall',
        capabilities: ['switch'],
      },
    })
    const fresh = freshMap([
      entity({
        entityId: 'switch.kitchen',
        mappedTo: {
          deviceType: DeviceType.Light,
          role: null,
          capabilities: ['switch', 'brightness'],
        },
      }),
      entity({
        entityId: 'switch.hall',
        mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
      }),
    ])
    const actions = planStandaloneReconcile([drifted, stable], fresh, BROKER_ID)
    expect(actions.map((a) => a.deviceId)).toEqual([501])
  })
})
