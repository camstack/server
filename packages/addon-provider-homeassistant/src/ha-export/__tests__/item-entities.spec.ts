/**
 * Per-item entities: a capability whose value is an ARRAY of named items
 * (`consumables.items`) becomes one set of Home Assistant entities PER ITEM,
 * minted at reconcile time from the device's own slice.
 *
 * Every consumable — wear parts, supplies (a vacuum's clean water, a
 * dishwasher's salt and rinse aid), waste (a dirty-water tank) — reaches Home
 * Assistant this way (D915 follow-up).
 */
import type { ConsumablesStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyCapCommand,
  type CapCommandDevice,
  type CommandTarget,
  isCapCommand,
  resolveCommand,
} from '../command-routes.js'
import { buildDevicePlan, CAPS_NOT_EXPORTED, unclassifiedCaps } from '../entity-catalog.js'
import { ITEM_ENTITY_MAP, itemEntitiesFor, projectItemSlice } from '../item-entities.js'
import { commandTopic, deviceKeyFor, stateTopic, toComponentKey } from '../topics.js'
import type { CatalogDevice, HaComponent } from '../types.js'

const VACUUM_SLICE: ConsumablesStatus = {
  lastChangedAt: 1,
  items: [
    {
      key: 'main-brush',
      label: 'Main brush',
      kind: 'wear',
      level: 63,
      status: 'ok',
      lastResetAt: null,
      resettable: true,
      remaining: { value: 190, kind: 'duration' },
    },
    {
      key: 'clean-water',
      label: 'Clean water tank',
      kind: 'supply',
      level: 40,
      status: 'low',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'dirty-water',
      label: 'Dirty water tank',
      kind: 'waste',
      level: null,
      status: 'full',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'descaler',
      label: 'Descaler',
      level: null,
      status: null,
      lastResetAt: null,
      resettable: false,
      remaining: { value: 12, kind: 'count' },
    },
  ],
}

const DISHWASHER_SLICE: ConsumablesStatus = {
  lastChangedAt: 1,
  items: [
    {
      key: 'salt',
      label: 'Salt',
      kind: 'supply',
      level: null,
      status: 'empty',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'rinse-aid',
      label: 'Rinse aid',
      kind: 'supply',
      level: null,
      status: 'ok',
      lastResetAt: null,
      resettable: false,
    },
  ],
}

function device(
  id: number,
  type: string,
  slice: ConsumablesStatus,
  extraCaps: readonly string[] = [],
): CatalogDevice {
  const entities = itemEntitiesFor('consumables', slice)
  if (entities === null) throw new Error('the fixture slice must parse')
  return {
    id,
    name: `Device ${id}`,
    type,
    features: [],
    boundCaps: ['consumables', ...extraCaps],
    zones: [],
    switches: [],
    slices: ['consumables'],
    itemEntities: { consumables: entities },
  }
}

function component(
  plan: ReturnType<typeof buildDevicePlan>,
  platform: string,
  entity: string,
): HaComponent {
  const found = plan.cmps[toComponentKey(platform, entity)]
  if (found === undefined) {
    throw new Error(`no ${platform} ${entity} in [${Object.keys(plan.cmps).sort().join(', ')}]`)
  }
  return found
}

describe('consumables are exported, not excluded', () => {
  it('classifies consumables as a per-item capability', () => {
    expect(CAPS_NOT_EXPORTED.some((entry) => entry.cap === 'consumables')).toBe(false)
    expect(Object.keys(ITEM_ENTITY_MAP)).toContain('consumables')
    expect(unclassifiedCaps(['consumables'])).toEqual([])
  })
})

describe('one entity set per consumable item', () => {
  const plan = buildDevicePlan(device(503, 'vacuum', VACUUM_SLICE))
  const key = deviceKeyFor(503)

  it('mints a level sensor in percent with a measurement state class', () => {
    const level = component(plan, 'sensor', 'consumable_main_brush_level')
    expect(level).toMatchObject({
      unique_id: '503_consumable_main-brush_level',
      name: 'Main brush',
      unit_of_measurement: '%',
      state_class: 'measurement',
      entity_category: 'diagnostic',
      state_topic: stateTopic(key, 'consumable_main_brush_level'),
    })
    expect(level.command_topic).toBeUndefined()
  })

  it('keeps a supply or waste level on the device page, not under diagnostics', () => {
    const tank = component(plan, 'sensor', 'consumable_clean_water_level')
    expect(tank.name).toBe('Clean water tank')
    expect(tank.entity_category).toBeUndefined()
  })

  it('mints a status sensor for an item that reports a status', () => {
    const status = component(plan, 'sensor', 'consumable_dirty_water_status')
    expect(status).toMatchObject({
      unique_id: '503_consumable_dirty-water_status',
      name: 'Dirty water tank status',
    })
    // An enum sensor over the cap's own vocabulary: a value outside it
    // reads `unknown` in Home Assistant rather than as free text.
    expect(status.device_class).toBe('enum')
    expect(status.options).toEqual(['ok', 'low', 'empty', 'full', 'replace'])
    expect(status.unit_of_measurement).toBeUndefined()
    expect(status.state_class).toBeUndefined()
  })

  it('mints no level sensor for an item that reports no level', () => {
    expect(plan.cmps[toComponentKey('sensor', 'consumable_dirty_water_level')]).toBeUndefined()
    expect(plan.cmps[toComponentKey('sensor', 'consumable_descaler_status')]).toBeUndefined()
  })

  it('gives a remaining-time counter a duration in its own unit', () => {
    expect(component(plan, 'sensor', 'consumable_main_brush_remaining')).toMatchObject({
      unique_id: '503_consumable_main-brush_remaining',
      device_class: 'duration',
      unit_of_measurement: 's',
      state_class: 'measurement',
    })
  })

  it('gives a cycle counter a count, not a duration', () => {
    const cycles = component(plan, 'sensor', 'consumable_descaler_remaining')
    expect(cycles.unit_of_measurement).toBeUndefined()
    expect(cycles.device_class).toBeUndefined()
  })

  it('mints a reset button only for a resettable item', () => {
    expect(component(plan, 'button', 'consumable_main_brush_reset')).toMatchObject({
      unique_id: '503_consumable_main-brush_reset',
      name: 'Reset Main brush',
      entity_category: 'config',
      command_topic: commandTopic(key, 'consumable_main_brush_reset'),
      payload_press: 'PRESS',
    })
    expect(plan.cmps[toComponentKey('button', 'consumable_clean_water_reset')]).toBeUndefined()
  })

  it('exports the dishwasher salt and rinse aid D915 moved into consumables', () => {
    const dishwasher = buildDevicePlan(device(880, 'dishwasher', DISHWASHER_SLICE))
    expect(component(dishwasher, 'sensor', 'consumable_salt_status').name).toBe('Salt status')
    expect(component(dishwasher, 'sensor', 'consumable_rinse_aid_status').name).toBe(
      'Rinse aid status',
    )
  })

  it('exports a camera consumable too — the cap binds on every device type', () => {
    const camera = buildDevicePlan(device(101, 'camera', VACUUM_SLICE, ['motion']))
    expect(component(camera, 'sensor', 'consumable_main_brush_level').unique_id).toBe(
      '101_consumable_main-brush_level',
    )
  })

  it('drops an item that left the slice from the plan', () => {
    const fewer: ConsumablesStatus = { ...VACUUM_SLICE, items: VACUUM_SLICE.items.slice(1) }
    const shrunk = buildDevicePlan(device(503, 'vacuum', fewer))
    expect(Object.keys(shrunk.cmps).filter((k) => k.includes('main-brush'))).toEqual([])
  })
})

describe('values', () => {
  it('publishes every reported value on the topic the plan announced', () => {
    const key = deviceKeyFor(503)
    const values = projectItemSlice(key, 'consumables', VACUUM_SLICE)
    expect(values).toEqual(
      expect.arrayContaining([
        { topic: stateTopic(key, 'consumable_main_brush_level'), value: '63' },
        { topic: stateTopic(key, 'consumable_main_brush_status'), value: 'ok' },
        { topic: stateTopic(key, 'consumable_main_brush_remaining'), value: '190' },
        { topic: stateTopic(key, 'consumable_clean_water_level'), value: '40' },
        { topic: stateTopic(key, 'consumable_dirty_water_status'), value: 'full' },
        { topic: stateTopic(key, 'consumable_descaler_remaining'), value: '12' },
      ]),
    )
    // A status the provider no longer knows is published OUTSIDE the enum,
    // which the component reads as `unknown` — never the last verdict kept.
    expect(values).toContainEqual({
      topic: stateTopic(key, 'consumable_descaler_status'),
      value: 'unknown',
    })
    // A button carries no value.
    expect(values?.some((v) => v.topic.endsWith('_reset'))).toBe(false)
  })

  it('refuses a slice that is not the capability shape rather than guessing', () => {
    expect(projectItemSlice(deviceKeyFor(503), 'consumables', { items: 'nope' })).toBeNull()
    expect(itemEntitiesFor('consumables', { items: [{ key: '' }] })).toBeNull()
  })
})

describe('the reset button', () => {
  const entities = itemEntitiesFor('consumables', VACUUM_SLICE) ?? []
  const target: CommandTarget = {
    deviceId: 503,
    type: 'vacuum',
    boundCaps: ['consumables'],
    itemEntities: entities,
  }

  it('resets the item by its ORIGINAL key, not the slug', async () => {
    const resolution = resolveCommand(target, 'consumable_main_brush_reset', 'PRESS')
    if (!resolution.ok) throw new Error(`expected a command, got ${resolution.reason}`)
    expect(resolution.command).toEqual({
      kind: 'consumable-reset',
      deviceId: 503,
      key: 'main-brush',
    })
    if (!isCapCommand(resolution.command)) throw new Error('expected a capability command')

    const calls: unknown[] = []
    const consumables: NonNullable<CapCommandDevice['consumables']> = {
      reset: async (input) => {
        calls.push(input)
      },
      getStatus: async () => VACUUM_SLICE,
    }
    const outcome = await applyCapCommand({ consumables }, resolution.command)
    expect(outcome).toEqual({ ok: true })
    expect(calls).toEqual([{ key: 'main-brush' }])
  })

  it('refuses a reset for an item that is not resettable', () => {
    expect(resolveCommand(target, 'consumable_clean_water_reset', 'PRESS')).toEqual({
      ok: false,
      reason: 'unknown-entity',
    })
  })

  it('refuses a reset when the device no longer binds the capability', () => {
    expect(
      resolveCommand({ ...target, boundCaps: [] }, 'consumable_main_brush_reset', 'PRESS'),
    ).toEqual({ ok: false, reason: 'cap-not-bound', capName: 'consumables' })
  })

  it('names the missing provider instead of pretending it reset', async () => {
    const resolution = resolveCommand(target, 'consumable_main_brush_reset', 'PRESS')
    if (!resolution.ok || !isCapCommand(resolution.command)) throw new Error('expected a command')
    expect(await applyCapCommand({}, resolution.command)).toEqual({
      ok: false,
      reason: 'no-provider',
      capName: 'consumables',
    })
  })
})
