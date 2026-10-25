import {
  AlarmPanelStatusSchema,
  ClimateControlStatusSchema,
  CoverStatusSchema,
  FanControlStatusSchema,
  HumidifierStatusSchema,
  LockControlStatusSchema,
  MediaPlayerStatusSchema,
  VacuumControlStatusSchema,
  ValveStatusSchema,
  WaterHeaterStatusSchema,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { LEGACY_SUPPORT } from '../component-support.js'
import { buildDerivedPlan, CAP_ENTITY_MAP } from '../entity-catalog.js'
import {
  buildNativeComponent,
  NATIVE_CAP_PLATFORMS,
  nativePlatformFor,
} from '../native-platforms.js'
import { stateTopic } from '../topics.js'
import type { CatalogDevice, HaComponent, HaPlatform } from '../types.js'

/** Everything a 0.4.0 component builds. */
const NATIVE_SUPPORT: ReadonlySet<HaPlatform> = new Set<HaPlatform>([
  ...LEGACY_SUPPORT,
  'alarm_control_panel',
  'cover',
  'climate',
  'lock',
  'fan',
  'vacuum',
  'valve',
  'humidifier',
  'water_heater',
  'media_player',
])

function device(overrides: Partial<CatalogDevice> = {}): CatalogDevice {
  return {
    id: 812,
    name: 'Tapparella hall',
    type: 'cover',
    features: [],
    boundCaps: ['cover'],
    zones: [],
    switches: [],
    slices: ['cover'],
    ...overrides,
  }
}

function componentOf(
  plan: { readonly cmps: Readonly<Record<string, HaComponent>> },
  key: string,
): HaComponent {
  const component = plan.cmps[key]
  if (component === undefined) {
    throw new Error(`${key} is not in [${Object.keys(plan.cmps).join(', ')}]`)
  }
  return component
}

describe('the native half is opt-in', () => {
  it('announces the degraded fan-out to a component that builds no cover', () => {
    const plan = buildDerivedPlan(device(), { platforms: LEGACY_SUPPORT })

    expect(Object.keys(plan.cmps)).toContain('sensor-cover')
    expect(Object.keys(plan.cmps).filter((key) => key.startsWith('cover-'))).toEqual([])
  })

  it('is the default, so a caller that forgets to negotiate loses fidelity and not entities', () => {
    const negotiated = buildDerivedPlan(device(), {
      platforms: LEGACY_SUPPORT,
    })

    expect(Object.keys(buildDerivedPlan(device()).cmps).sort()).toEqual(
      Object.keys(negotiated.cmps).sort(),
    )
  })

  it('announces ONE cover to a component that builds one', () => {
    const plan = buildDerivedPlan(device(), { platforms: NATIVE_SUPPORT })

    expect(Object.keys(plan.cmps)).toContain('cover-cover')
    expect(Object.keys(plan.cmps)).not.toContain('sensor-cover')
  })

  it('gives the native entity the SAME unique_id the degraded one had', () => {
    /**
     * Home Assistant keys its registry on (platform, integration,
     * unique_id), so this is a new entity either way — but keeping the id
     * means a component downgrade puts the operator back on exactly the
     * entity they had, rather than on a second one beside it.
     */
    const legacy = buildDerivedPlan(device(), { platforms: LEGACY_SUPPORT })
    const native = buildDerivedPlan(device(), { platforms: NATIVE_SUPPORT })

    expect(componentOf(native, 'cover-cover').unique_id).toBe(
      componentOf(legacy, 'sensor-cover').unique_id,
    )
  })
})

describe('what a native entity absorbs', () => {
  it('takes over every entity it reads, so no value is announced twice', () => {
    const plan = buildDerivedPlan(device(), { platforms: NATIVE_SUPPORT })

    const leftovers = Object.keys(plan.cmps).filter((key) => key.includes('cover'))
    expect(leftovers).toEqual(['cover-cover'])
  })

  it('leaves alone what the native platform cannot show', () => {
    /**
     * Home Assistant's vacuum has no place for a progress percentage or a
     * vendor error string. Dropping them to make the device look tidy
     * would be a silent loss of a value an operator already automates on.
     */
    const plan = buildDerivedPlan(
      device({
        type: 'vacuum',
        boundCaps: ['vacuum-control'],
        slices: ['vacuum-control'],
      }),
      { platforms: NATIVE_SUPPORT },
    )

    expect(Object.keys(plan.cmps)).toContain('vacuum-vacuum-control')
    expect(Object.keys(plan.cmps)).toContain('sensor-vacuum-control-progress')
    expect(Object.keys(plan.cmps)).toContain('sensor-vacuum-control-battery')
  })

  it('supersedes the enum sensor a lock only needed because a switch cannot say `jammed`', () => {
    const plan = buildDerivedPlan(
      device({
        type: 'lock',
        boundCaps: ['lock-control'],
        slices: ['lock-control'],
      }),
      { platforms: NATIVE_SUPPORT },
    )

    expect(Object.keys(plan.cmps)).toContain('lock-lock-control')
    expect(Object.keys(plan.cmps)).not.toContain('sensor-lock-control-state')
  })
})

describe('the topics a native entity names', () => {
  it('are the topics the degraded entities already published on', () => {
    /**
     * The whole safety property of the native half: it changes STRUCTURE
     * and never the value plane, so `state-projector.ts` needs no branch
     * and the two cannot disagree.
     */
    const legacy = buildDerivedPlan(device(), { platforms: LEGACY_SUPPORT })
    const native = componentOf(
      buildDerivedPlan(device(), { platforms: NATIVE_SUPPORT }),
      'cover-cover',
    )

    expect(native.state_topic).toBe(componentOf(legacy, 'sensor-cover').state_topic)
    expect(native.controls?.['position']?.state_topic).toBe(
      componentOf(legacy, 'number-cover-position').state_topic,
    )
  })

  it('resolve a verb button to its own command topic', () => {
    const native = componentOf(
      buildDerivedPlan(device(), { platforms: NATIVE_SUPPORT }),
      'cover-cover',
    )

    expect(native.controls?.['open']?.command_topic).toBe('camstack/camstack-812/cover_open/set')
    expect(native.controls?.['open']?.state_topic).toBeUndefined()
  })

  it('offers NO command a capability has no route for', () => {
    /**
     * D62 generalised, and the reason a prettier platform is not a reason
     * to ship a control that calls nothing. `media-player` is read-only in
     * the degraded table, so its native form is a read-only media player.
     */
    const plan = buildDerivedPlan(
      device({
        type: 'media-player',
        boundCaps: ['media-player'],
        slices: ['media-player'],
      }),
      { platforms: NATIVE_SUPPORT },
    )
    const native = componentOf(plan, 'media_player-media-player')

    const writableInTheDegradedTable = CAP_ENTITY_MAP['media-player']?.writable === true
    expect(native.command_topic === undefined).toBe(!writableInTheDegradedTable)
  })
})

describe('what the device says about itself', () => {
  it('carries the modes THIS thermostat accepts, from its slice', () => {
    const plan = buildDerivedPlan(
      device({
        type: 'thermostat',
        boundCaps: ['climate-control'],
        slices: ['climate-control'],
        capSlices: {
          'climate-control': {
            mode: 'heat',
            availableModes: ['off', 'heat', 'auto'],
            availableFanModes: ['low', 'high'],
          },
        },
      }),
      { platforms: NATIVE_SUPPORT },
    )
    const native = componentOf(plan, 'climate-climate-control')

    expect(native.options).toEqual(['off', 'heat', 'auto'])
    expect(native.controls?.['fan_mode']?.options).toEqual(['low', 'high'])
    expect(native.temperature_unit).toBe('°C')
  })

  it('prefers the bounds the device reports over the static backstop', () => {
    const plan = buildDerivedPlan(
      device({
        type: 'water-heater',
        boundCaps: ['water-heater'],
        slices: ['water-heater'],
        capSlices: { 'water-heater': { minTemp: 35, maxTemp: 60 } },
      }),
      { platforms: NATIVE_SUPPORT },
    )
    const target = componentOf(plan, 'water_heater-water-heater').controls?.['target']

    expect(target?.min).toBe(35)
    expect(target?.max).toBe(60)
  })

  it('is a water heater whose STATE is its operation mode, not its temperature', () => {
    /**
     * The capability's primary entity is the measured temperature; Home
     * Assistant's water heater is its mode. The binding names the entity
     * rather than assuming the primary, which is the whole reason it can.
     */
    const plan = buildDerivedPlan(
      device({
        type: 'water-heater',
        boundCaps: ['water-heater'],
        slices: ['water-heater'],
      }),
      { platforms: NATIVE_SUPPORT },
    )
    const native = componentOf(plan, 'water_heater-water-heater')

    expect(native.state_topic).toBe(stateTopic('camstack-812', 'water_heater_mode'))
    expect(native.controls?.['current_temperature']?.state_topic).toBe(
      stateTopic('camstack-812', 'water_heater'),
    )
  })

  it('tells the panel card whether a PIN is required', () => {
    const plan = buildDerivedPlan(
      device({
        type: 'alarm-panel',
        boundCaps: ['alarm-panel'],
        slices: ['alarm-panel'],
        capSlices: {
          'alarm-panel': {
            availableModes: ['home', 'away'],
            requiresCode: true,
          },
        },
      }),
      { platforms: NATIVE_SUPPORT },
    )
    const native = componentOf(plan, 'alarm_control_panel-alarm-panel')

    expect(native.code_arm_required).toBe(true)
    expect(native.options).toEqual(['home', 'away'])
  })
})

describe('the platform an old component cannot build at all', () => {
  it('degrades an alarm panel to a sensor rather than announcing nothing', () => {
    /**
     * A live defect rather than a hypothetical: the export has announced
     * `alarm_control_panel` since it shipped, and the 0.3.x component
     * builds eight platforms not including it — so every alarm panel
     * exported to one produced a warning line and no entity.
     */
    const plan = buildDerivedPlan(
      device({
        type: 'alarm-panel',
        boundCaps: ['alarm-panel'],
        slices: ['alarm-panel'],
      }),
      { platforms: LEGACY_SUPPORT },
    )

    const component = componentOf(plan, 'sensor-alarm-panel')
    expect(component.platform).toBe('sensor')
    // A reading, not a control: nothing on the wire can reach it.
    expect(component.command_topic).toBeUndefined()
  })
})

describe('the two tables agree', () => {
  it('gives every native platform a degraded row to fall back to', () => {
    for (const cap of Object.keys(NATIVE_CAP_PLATFORMS)) {
      expect(CAP_ENTITY_MAP[cap], `${cap} has a native platform and no fallback row`).toBeDefined()
    }
  })

  it('binds every slice field it names to the capability status schema', () => {
    /**
     * The same authority `scripts/check-export-coverage.ts` holds the
     * degraded table to. Eleven descriptors there once named a field the
     * schema did not declare, which is an entity that can never receive a
     * value; an option list that names one is a control that offers
     * nothing.
     */
    const schemas: Readonly<Record<string, { shape: Readonly<Record<string, unknown>> }>> = {
      cover: CoverStatusSchema,
      valve: ValveStatusSchema,
      'lock-control': LockControlStatusSchema,
      'alarm-panel': AlarmPanelStatusSchema,
      'climate-control': ClimateControlStatusSchema,
      'fan-control': FanControlStatusSchema,
      humidifier: HumidifierStatusSchema,
      'water-heater': WaterHeaterStatusSchema,
      'vacuum-control': VacuumControlStatusSchema,
      'media-player': MediaPlayerStatusSchema,
    }

    expect(Object.keys(schemas).sort()).toEqual(Object.keys(NATIVE_CAP_PLATFORMS).sort())
    for (const [cap, native] of Object.entries(NATIVE_CAP_PLATFORMS)) {
      const fields = Object.keys(schemas[cap]?.shape ?? {})
      const bindings = [native.primary, ...Object.values(native.controls ?? {})]
      for (const binding of bindings) {
        for (const field of [
          binding.optionsField,
          binding.minField,
          binding.maxField,
          binding.stepField,
        ]) {
          if (field === undefined) continue
          expect(fields, `${cap} names '${field}'`).toContain(field)
        }
      }
      for (const field of Object.values(native.flagFields ?? {})) {
        expect(fields, `${cap} names '${field}'`).toContain(field)
      }
    }
  })

  it('builds a native component for every capability the table claims one for', () => {
    for (const [cap, native] of Object.entries(NATIVE_CAP_PLATFORMS)) {
      const mapping = CAP_ENTITY_MAP[cap]
      if (mapping === undefined) continue
      const plan = buildNativeComponent({
        deviceKey: 'camstack-x',
        deviceId: 812,
        capName: cap,
        label: cap,
        slice: undefined,
        mapping,
      })
      expect(plan?.component.platform, `${cap} cannot be built`).toBe(native.platform)
    }
  })

  it('leaves an unbound control BESIDE the native entity rather than losing it', () => {
    /**
     * Rule 3 in the other direction. A thermostat's vertical swing is a
     * boolean and Home Assistant's climate expresses swing as a mode
     * vocabulary the capability does not have — so it cannot be bound, and
     * it must therefore still be announced. An unbound control is not
     * absorbed; nothing is silently dropped when the degraded table grows.
     */
    const swing = CAP_ENTITY_MAP['climate-control']?.extras?.['swing-vertical']
    expect(swing, 'the fixture this test is about no longer exists').toBeDefined()

    const plan = buildDerivedPlan(
      device({
        type: 'thermostat',
        boundCaps: ['climate-control'],
        slices: ['climate-control'],
      }),
      { platforms: NATIVE_SUPPORT },
    )

    expect(Object.keys(plan.cmps)).toContain('climate-climate-control')
    expect(
      Object.keys(plan.cmps).some((key) => key.endsWith('climate-control-swing-vertical')),
    ).toBe(true)
  })

  it('reports the platform a capability becomes, and nothing for one that has none', () => {
    expect(nativePlatformFor('cover')).toBe('cover')
    expect(nativePlatformFor('motion')).toBeNull()
  })
})

describe('the lock, which is why the platform is worth having', () => {
  it('reads the enum extra and writes the switch the route table resolves', () => {
    /**
     * The degraded `lock-control` is a `switch`, so its primary entity
     * publishes a boolean DERIVED from the state — and a boolean reports a
     * jammed door as unlocked. The native lock therefore reads the enum and
     * writes the switch, which is the one `parseLocked` routes.
     */
    const plan = buildDerivedPlan(
      device({ type: 'lock', boundCaps: ['lock-control'], slices: ['lock-control'] }),
      { platforms: NATIVE_SUPPORT },
    )
    const native = componentOf(plan, 'lock-lock-control')

    expect(native.state_topic).toBe(stateTopic('camstack-812', 'lock_control_state'))
    expect(native.command_topic).toBe('camstack/camstack-812/lock_control/set')
    // Both ends are absorbed: neither is announced a second time.
    expect(Object.keys(plan.cmps).filter((key) => key.includes('lock-control'))).toEqual([
      'lock-lock-control',
    ])
  })
})
