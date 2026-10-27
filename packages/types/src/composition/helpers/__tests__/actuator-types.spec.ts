/**
 * Actuator groups beyond switch and light (D944 phase 3): fan, cover, valve,
 * lock, media player, climate. One method table per type; a method is shared
 * only when every member can take it; a state that is an enum counts as
 * active through the type's own list; unlocking a group is never silent.
 */
import { describe, expect, it } from 'vitest'
import { coverCapability } from '../../../capabilities/cover.cap.js'
import { climateControlCapability } from '../../../capabilities/climate-control.cap.js'
import { groupActiveCapability } from '../../../capabilities/group-active.cap.js'
import { groupStatusCapability } from '../../../capabilities/group-status.cap.js'
import { lockControlCapability } from '../../../capabilities/lock-control.cap.js'
import { mediaPlayerCapability } from '../../../capabilities/media-player.cap.js'
import { switchCapability } from '../../../capabilities/switch.cap.js'
import { valveCapability } from '../../../capabilities/valve.cap.js'
import { DeviceFeature, DeviceType } from '../../../device/device-type.js'
import { compositionSourceKey, type Composition } from '../../composition.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import {
  ACTUATOR_TEMPLATE_IDS,
  actuatorMethodRow,
  methodRefusal,
  sharedActuatorFeatures,
  sharedActuatorMethods,
  UNLOCK_CONFIRMATION,
} from '../actuator-methods.js'
import { evaluateAggregate } from '../aggregate.js'
import { groupTemplate } from '../catalog.js'
import { compileHelper } from '../compile.js'
import { sourcePickForTemplate } from '../source-pick.js'
import { type GroupHelperSpec, type GroupTemplateId, helperMembers } from '../spec.js'

const lookupCap = buildCapabilityLookup([
  switchCapability,
  groupStatusCapability,
  groupActiveCapability,
  coverCapability,
  valveCapability,
  lockControlCapability,
  mediaPlayerCapability,
  climateControlCapability,
])

const NEW_TYPES = ['fan', 'cover', 'valve', 'lock', 'media-player', 'climate'] as const

function member(templateId: GroupTemplateId, n: number) {
  const template = groupTemplate(templateId)
  const field = template?.accept[0]
  if (field === undefined) throw new Error(`no member field for ${templateId}`)
  return {
    source: { addonId: 'provider-demo', stableId: `${templateId}-${n}` },
    cap: field.cap,
    fieldPath: field.fieldPath,
  }
}

function spec(templateId: GroupTemplateId, count = 2): GroupHelperSpec {
  return {
    kind: 'group',
    templateId,
    aggregate: 'any',
    active: 'at-least-one',
    members: Array.from({ length: count }, (_, index) => member(templateId, index + 1)),
  }
}

function context(composition: Composition, deviceType: DeviceType): ValidateCompositionContext {
  const sources = new Map<string, CompositionSourceDescription>()
  const members = composition.helper === undefined ? [] : helperMembers(composition.helper)
  for (const [index, item] of members.entries()) {
    sources.set(compositionSourceKey(item.source), {
      kind: 'found',
      deviceId: 5000 + index,
      caps: new Set([item.cap]),
      deviceType,
      quantity: 'none',
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}

function fresh(value: string | boolean) {
  return { state: 'fresh' as const, value }
}

describe('the catalog row of each new type', () => {
  it.each(NEW_TYPES)('%s is an actuator that compiles and validates as a new device', (id) => {
    const template = groupTemplate(id)
    expect(template?.family).toBe('actuator')
    const compiled = compileHelper(spec(id))
    expect(compiled.ok, id).toBe(true)
    if (!compiled.ok || template === null) return
    expect(
      validateComposition(compiled.composition, context(compiled.composition, template.deviceType))
        .problems,
      id,
    ).toEqual([])
  })

  it('a fan reports switch.on, the others report group-active.active', () => {
    expect(groupTemplate('fan')?.outputCap).toBe('switch')
    for (const id of ['cover', 'valve', 'lock', 'media-player', 'climate'] as const) {
      expect(groupTemplate(id)?.outputCap, id).toBe('group-active')
    }
  })

  it('a member is asked to bind the cap it is read from, not only switch', () => {
    expect(sourcePickForTemplate(groupTemplate('cover') ?? failure()).mustBindCaps).toEqual([
      'cover',
    ])
    expect(sourcePickForTemplate(groupTemplate('lock') ?? failure()).mustBindCaps).toEqual([
      'lock-control',
    ])
  })

  it('refuses a member that reads another capability', () => {
    const wrong = compileHelper({
      ...spec('cover'),
      members: [{ ...member('cover', 1), cap: 'switch', fieldPath: 'on' }],
    })
    expect(wrong.ok).toBe(false)
  })

  it('a climate group takes thermostats and air conditioners, a lock group only locks', () => {
    expect(groupTemplate('climate')?.memberDeviceTypes).toEqual([
      DeviceType.Thermostat,
      DeviceType.Climate,
    ])
    expect(groupTemplate('lock')?.memberDeviceTypes).toEqual([DeviceType.Lock])
  })
})

describe('what counts as active', () => {
  const read = (templateId: GroupTemplateId, values: readonly (string | boolean)[]) => {
    const template = groupTemplate(templateId)
    const compiled = compileHelper(spec(templateId, values.length))
    if (!compiled.ok || template === null) throw new Error('did not compile')
    const feature = compiled.composition.features[0]
    if (feature === undefined || feature.kind !== 'fields') throw new Error('no fields')
    const source = feature.fields[template.outputField]
    if (source === undefined || source.kind !== 'aggregate') throw new Error('not an aggregate')
    return evaluateAggregate({
      reducer: source.reducer,
      publish: 'value',
      empty: source.empty,
      ...(source.activeWhen === undefined ? {} : { activeWhen: source.activeWhen }),
      members: values.map(fresh),
    })
  }

  it('a cover is active while open or part-open, and closed or closing is not', () => {
    expect(read('cover', ['closed', 'open'])).toMatchObject({ value: true })
    expect(read('cover', ['closed', 'closing'])).toMatchObject({ value: false })
    expect(read('cover', ['stopped'])).toMatchObject({ value: true })
  })

  it('a lock is active only when locked: unlocked, moving or jammed is not', () => {
    expect(read('lock', ['locked', 'locked'])).toMatchObject({ value: true })
    expect(read('lock', ['unlocked', 'jammed'])).toMatchObject({ value: false })
  })

  it('a media player is active when playing or buffering, a climate device when not off', () => {
    expect(read('media-player', ['paused', 'playing'])).toMatchObject({ value: true })
    expect(read('media-player', ['paused', 'idle'])).toMatchObject({ value: false })
    expect(read('climate', ['off', 'heat'])).toMatchObject({ value: true })
    expect(read('climate', ['off', 'off'])).toMatchObject({ value: false })
  })

  it('all means every included member, and an unknown state is left out, not inactive', () => {
    const outcome = evaluateAggregate({
      reducer: 'all',
      publish: 'value',
      empty: 'offline',
      activeWhen: ['locked'],
      members: [fresh('locked'), { state: 'unavailable', fatal: false }, fresh('locked')],
    })
    expect(outcome).toMatchObject({
      kind: 'value',
      value: true,
      counts: { included: 2, excluded: 1, total: 3 },
    })
  })

  it('a value that is not a listed state of the type is not a yes and not a no', () => {
    const outcome = evaluateAggregate({
      reducer: 'any',
      publish: 'value',
      empty: 'offline',
      activeWhen: ['locked'],
      members: [fresh(true), { state: 'fresh', value: null }],
    })
    expect(outcome.kind).toBe('unavailable')
  })
})

describe('the method table', () => {
  it('has a table for every actuator type, starting from the cap the type is', () => {
    expect([...ACTUATOR_TEMPLATE_IDS].sort()).toEqual(
      ['climate', 'cover', 'fan', 'light', 'lock', 'media-player', 'switch', 'valve'].sort(),
    )
    expect(actuatorMethodRow('cover', 'cover', 'open')).not.toBeNull()
    expect(actuatorMethodRow('cover', 'cover', 'explode')).toBeNull()
    expect(actuatorMethodRow('lock', 'lock-control', 'open')).toBeNull()
  })

  it('every method named by a table exists on its capability', () => {
    const caps = [
      coverCapability,
      valveCapability,
      lockControlCapability,
      mediaPlayerCapability,
      climateControlCapability,
    ]
    for (const id of ['cover', 'valve', 'lock', 'media-player', 'climate'] as const) {
      const template = groupTemplate(id)
      for (const cap of template?.commandCaps ?? []) {
        const def = caps.find((item) => item.name === cap)
        expect(def, cap).toBeDefined()
      }
    }
    for (const row of sharedActuatorMethods('cover', [
      { caps: ['cover'], features: [DeviceFeature.CoverPositionable, DeviceFeature.CoverTilt] },
    ])) {
      expect(Object.keys(coverCapability.methods)).toContain(row.method)
    }
    for (const row of sharedActuatorMethods('lock', [{ caps: ['lock-control'], features: [] }])) {
      expect(Object.keys(lockControlCapability.methods)).toContain(row.method)
    }
    for (const row of sharedActuatorMethods('media-player', [
      { caps: ['media-player'], features: [DeviceFeature.MediaPlayerVolume] },
    ])) {
      expect(Object.keys(mediaPlayerCapability.methods)).toContain(row.method)
    }
    for (const row of sharedActuatorMethods('climate', [
      { caps: ['climate-control'], features: [DeviceFeature.ClimateFanMode] },
    ])) {
      expect(Object.keys(climateControlCapability.methods)).toContain(row.method)
    }
  })

  const names = (rows: ReturnType<typeof sharedActuatorMethods>) =>
    rows.map((row) => `${row.cap}.${row.method}`)

  it('a cover shares position and tilt only when every member can', () => {
    const both = {
      caps: ['cover'],
      features: [DeviceFeature.CoverPositionable, DeviceFeature.CoverTilt],
    }
    const positionOnly = { caps: ['cover'], features: [DeviceFeature.CoverPositionable] }
    expect(names(sharedActuatorMethods('cover', [both, both]))).toEqual([
      'cover.open',
      'cover.close',
      'cover.stop',
      'cover.setPosition',
      'cover.setTiltPosition',
    ])
    expect(names(sharedActuatorMethods('cover', [both, positionOnly]))).toEqual([
      'cover.open',
      'cover.close',
      'cover.stop',
      'cover.setPosition',
    ])
    expect(
      names(sharedActuatorMethods('cover', [both, { caps: ['cover'], features: [] }])),
    ).toEqual(['cover.open', 'cover.close', 'cover.stop'])
  })

  it('a fan keeps on/off always and the rest by the features every fan has', () => {
    const fast = {
      caps: ['switch', 'fan-control'],
      features: [DeviceFeature.FanSpeed, DeviceFeature.FanPreset, DeviceFeature.FanOscillating],
    }
    const plain = { caps: ['switch', 'fan-control'], features: [DeviceFeature.FanSpeed] }
    const noControl = { caps: ['switch'], features: [] }
    expect(names(sharedActuatorMethods('fan', [fast, fast]))).toEqual([
      'switch.setState',
      'fan-control.setPercentage',
      'fan-control.setPreset',
      'fan-control.setOscillating',
    ])
    expect(names(sharedActuatorMethods('fan', [fast, plain]))).toEqual([
      'switch.setState',
      'fan-control.setPercentage',
    ])
    expect(names(sharedActuatorMethods('fan', [fast, noControl]))).toEqual(['switch.setState'])
    expect(sharedActuatorFeatures('fan', [fast.features, plain.features])).toEqual([
      DeviceFeature.FanSpeed,
    ])
  })

  it('shares nothing from a group with no members', () => {
    expect(sharedActuatorMethods('cover', [])).toEqual([])
  })

  it('a valve, a media player and a climate group follow the same rule', () => {
    expect(
      names(
        sharedActuatorMethods('valve', [
          { caps: ['valve'], features: [DeviceFeature.ValvePositionable] },
        ]),
      ),
    ).toEqual(['valve.open', 'valve.close', 'valve.setPosition'])
    expect(
      names(sharedActuatorMethods('media-player', [{ caps: ['media-player'], features: [] }])),
    ).toEqual(['media-player.play', 'media-player.pause'])
    expect(
      names(
        sharedActuatorMethods('climate', [
          { caps: ['climate-control'], features: [DeviceFeature.ClimateFanMode] },
        ]),
      ),
    ).toEqual([
      'climate-control.setMode',
      'climate-control.setTarget',
      'climate-control.setFanMode',
    ])
  })
})

describe('lock group safety', () => {
  const unlock = actuatorMethodRow('lock', 'lock-control', 'unlock')
  const lock = actuatorMethodRow('lock', 'lock-control', 'lock')

  it('locking needs no confirmation, unlocking always does', () => {
    expect(lock).not.toBeNull()
    expect(unlock).not.toBeNull()
    expect(methodRefusal(lock, {})).toBeNull()
    expect(methodRefusal(unlock, {})).toBe(UNLOCK_CONFIRMATION)
    expect(methodRefusal(unlock, { confirm: false })).toBe(UNLOCK_CONFIRMATION)
    expect(methodRefusal(unlock, { confirm: 'yes' })).toBe(UNLOCK_CONFIRMATION)
    expect(methodRefusal(unlock, { confirm: true })).toBeNull()
  })

  it('no other method of any table asks for a confirmation', () => {
    for (const id of ACTUATOR_TEMPLATE_IDS) {
      const rows = sharedActuatorMethods(id, [
        {
          caps: [
            'switch',
            'brightness',
            'color',
            'fan-control',
            'cover',
            'valve',
            'lock-control',
            'media-player',
            'climate-control',
          ],
          features: Object.values(DeviceFeature),
        },
      ])
      for (const row of rows) {
        if (row.cap === 'lock-control' && row.method === 'unlock') continue
        expect(methodRefusal(row, {}), `${row.cap}.${row.method}`).toBeNull()
      }
    }
  })
})

function failure(): never {
  throw new Error('missing template')
}
