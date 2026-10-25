import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import {
  buildContainerEntities,
  diffContainerEntities,
  deriveChildLayout,
  parseContainerEntities,
} from '../ha-container-reconcile.js'
import type { HaContainerEntityConfig } from '../ha-container-reconcile.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'

function entity(partial: Partial<HaDiscoveredEntity> & { entityId: string }): HaDiscoveredEntity {
  return {
    entityId: partial.entityId,
    domain: partial.domain ?? partial.entityId.split('.')[0] ?? 'sensor',
    name: partial.name ?? partial.entityId,
    state: partial.state ?? 'unknown',
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

function haDevice(entities: HaDiscoveredEntity[]): HaDiscoveredDevice {
  return {
    haDeviceId: 'ha-dev-1',
    name: 'Plug',
    area: null,
    manufacturer: null,
    model: null,
    swVersion: null,
    integration: null,
    entityCount: entities.length,
    entities,
    alreadyAdopted: true,
    adoptedCamDeviceId: 1,
  }
}

describe('buildContainerEntities', () => {
  it('maps mapped entities to the Container config shape and skips unmapped ones', () => {
    const dev = haDevice([
      entity({
        entityId: 'sensor.plug_power',
        name: 'Plug Power',
        deviceClass: 'power',
        unitOfMeasurement: 'W',
        mappedTo: {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.PowerSensor,
          capabilities: ['power-meter'],
        },
      }),
      entity({ entityId: 'sensor.unmapped', mappedTo: null }),
    ])

    const out = buildContainerEntities(dev)

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      entityId: 'sensor.plug_power',
      deviceType: DeviceType.Sensor,
      capabilities: ['power-meter'],
      role: DeviceRole.PowerSensor,
      unitOfMeasurement: 'W',
      deviceClass: 'power',
      name: 'Plug Power',
    })
  })

  it('carries entityCategory from the discovered entity into the config', () => {
    const dev = haDevice([
      entity({
        entityId: 'switch.relay',
        name: 'Relay',
        mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
      }),
      entity({
        entityId: 'sensor.signal',
        name: 'Signal',
        entityCategory: 'diagnostic',
        mappedTo: {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.EnumSensor,
          capabilities: ['enum-sensor'],
        },
      }),
      entity({
        entityId: 'number.threshold',
        name: 'Threshold',
        entityCategory: 'config',
        mappedTo: {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.NumericSensor,
          capabilities: ['numeric-sensor'],
        },
      }),
    ])

    const out = buildContainerEntities(dev)

    // Plain control: category omitted.
    expect(out[0]?.entityCategory).toBeUndefined()
    // Diagnostic.
    expect(out[1]?.entityCategory).toBe('diagnostic')
    // Config.
    expect(out[2]?.entityCategory).toBe('config')
  })

  it('round-trips entityCategory through parseContainerEntities', () => {
    const dev = haDevice([
      entity({
        entityId: 'number.threshold',
        name: 'Threshold',
        entityCategory: 'config',
        mappedTo: {
          deviceType: DeviceType.Sensor,
          role: DeviceRole.NumericSensor,
          capabilities: ['numeric-sensor'],
        },
      }),
    ])
    const built = buildContainerEntities(dev)
    const parsed = parseContainerEntities(built)
    expect(parsed[0]?.entityCategory).toBe('config')
  })

  it('carries mapping-derived features (e.g. lock-open) into the entity config', () => {
    const dev = haDevice([
      entity({
        entityId: 'lock.front',
        name: 'Front lock',
        mappedTo: {
          deviceType: DeviceType.Lock,
          role: null,
          capabilities: ['lock-control'],
          features: ['lock-open'],
        },
      }),
    ])
    const out = buildContainerEntities(dev)
    expect(out[0]?.features).toEqual(['lock-open'])
  })
})

describe('diffContainerEntities', () => {
  const enumSensor: HaContainerEntityConfig = {
    entityId: 'sensor.plug_power',
    deviceType: DeviceType.Sensor,
    capabilities: ['enum-sensor'],
    role: DeviceRole.EnumSensor,
    name: 'Plug Power',
  }
  const powerMeter: HaContainerEntityConfig = {
    entityId: 'sensor.plug_power',
    deviceType: DeviceType.Sensor,
    capabilities: ['power-meter'],
    role: DeviceRole.PowerSensor,
    unitOfMeasurement: 'W',
    name: 'Plug Power',
  }

  it('reports no change when persisted and fresh match', () => {
    const plan = diffContainerEntities([enumSensor], [enumSensor])
    expect(plan.entitiesChanged).toBe(false)
    expect(plan.membershipChanged).toBe(false)
    expect(plan.changedChildren).toHaveLength(0)
  })

  it('flags an existing entity whose mapping-derived fields changed (class change → rebuild, no reprobe)', () => {
    const plan = diffContainerEntities([enumSensor], [powerMeter])
    expect(plan.entitiesChanged).toBe(true)
    expect(plan.membershipChanged).toBe(false)
    expect(plan.changedChildren).toHaveLength(1)
    const change = plan.changedChildren[0]!
    expect(change.entityId).toBe('sensor.plug_power')
    expect(change.type).toBe(DeviceType.Sensor)
    expect(change.role).toBe(DeviceRole.PowerSensor)
    expect(change.config).toMatchObject({ capabilities: ['power-meter'], unitOfMeasurement: 'W' })
  })

  it('persists a name-only change but does NOT rebuild the child or reprobe', () => {
    const renamed: HaContainerEntityConfig = { ...enumSensor, name: 'Renamed In HA' }
    const plan = diffContainerEntities([enumSensor], [renamed])
    expect(plan.entitiesChanged).toBe(true)
    expect(plan.membershipChanged).toBe(false)
    expect(plan.changedChildren).toHaveLength(0)
  })

  it('marks membership changed (→ reprobe) for a brand-new entity, with no child rebuild', () => {
    const added: HaContainerEntityConfig = {
      entityId: 'sensor.new',
      deviceType: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
      role: DeviceRole.NumericSensor,
      name: 'New',
    }
    const plan = diffContainerEntities([enumSensor], [enumSensor, added])
    expect(plan.entitiesChanged).toBe(true)
    expect(plan.membershipChanged).toBe(true)
    expect(plan.changedChildren).toHaveLength(0)
    expect(plan.freshEntities).toHaveLength(2)
  })

  it('marks membership changed (→ reprobe) when an entity was removed', () => {
    const plan = diffContainerEntities(
      [enumSensor, powerMeter].map((e, i) => ({ ...e, entityId: `sensor.e${i}` })),
      [],
    )
    expect(plan.entitiesChanged).toBe(true)
    expect(plan.membershipChanged).toBe(true)
    expect(plan.changedChildren).toHaveLength(0)
  })

  it('persists (entitiesChanged) a section-only change without a child rebuild', () => {
    const before: HaContainerEntityConfig = { ...enumSensor }
    const after: HaContainerEntityConfig = { ...enumSensor, entityCategory: 'diagnostic' }
    const plan = diffContainerEntities([before], [after])
    expect(plan.entitiesChanged).toBe(true)
    expect(plan.membershipChanged).toBe(false)
    expect(plan.changedChildren).toHaveLength(0)
  })
})

describe('deriveChildLayout', () => {
  function cfg(
    entityId: string,
    extra: Partial<HaContainerEntityConfig> = {},
  ): HaContainerEntityConfig {
    return {
      entityId,
      deviceType: DeviceType.Sensor,
      capabilities: ['enum-sensor'],
      name: entityId,
      ...extra,
    }
  }

  it('groups by entity_category into HA-nomenclature sections', () => {
    const layout = deriveChildLayout([
      cfg('switch.relay'), // null category → Controls
      cfg('sensor.signal', { entityCategory: 'diagnostic' }), // → Diagnostic
      cfg('number.threshold', { entityCategory: 'config' }), // → Configuration
    ])

    const byKey = new Map(layout.map((e) => [e.childKey, e]))
    expect(byKey.get('switch.relay')?.section).toBe('Controls')
    expect(byKey.get('number.threshold')?.section).toBe('Configuration')
    expect(byKey.get('sensor.signal')?.section).toBe('Diagnostic')

    // No section is collapsed by the HA provider (the generic UI owns collapse).
    expect(byKey.get('switch.relay')?.collapsed).toBeUndefined()
    expect(byKey.get('sensor.signal')?.collapsed).toBeUndefined()
    expect(byKey.get('number.threshold')?.collapsed).toBeUndefined()
  })

  it('emits the array ordered Controls → Configuration → Diagnostic', () => {
    const layout = deriveChildLayout([
      cfg('sensor.diag', { entityCategory: 'diagnostic' }),
      cfg('switch.control'),
      cfg('number.config', { entityCategory: 'config' }),
    ])
    expect(layout.map((e) => e.section)).toEqual(['Controls', 'Configuration', 'Diagnostic'])
  })

  it('childKey is the entityId and order preserves stable intra-section ascending sort across sections', () => {
    // Interleaved input spanning two sections: a control, then a diagnostic, then
    // another control. Within the Controls section the relative ascending order
    // must follow input order (ctrl_a before ctrl_b). This would FAIL if someone
    // switched `order` to a per-section zero-based counter incorrectly.
    const layout = deriveChildLayout([
      cfg('switch.ctrl_a'),
      cfg('sensor.diagnostic_x', { entityCategory: 'diagnostic' }),
      cfg('switch.ctrl_b'),
    ])

    const byKey = new Map(layout.map((e) => [e.childKey, e]))
    const ctrlA = byKey.get('switch.ctrl_a')!
    const ctrlB = byKey.get('switch.ctrl_b')!

    // Both controls live in the Controls section, and ctrl_a precedes ctrl_b.
    expect(ctrlA.section).toBe('Controls')
    expect(ctrlB.section).toBe('Controls')
    expect(ctrlA.order ?? Infinity).toBeLessThan(ctrlB.order ?? -Infinity)

    // `order` is the original input index (cross-section gaps are fine).
    expect(ctrlA.order).toBe(0)
    expect(byKey.get('sensor.diagnostic_x')?.order).toBe(1)
    expect(ctrlB.order).toBe(2)
  })
})
