import { describe, expect, it } from 'vitest'
import type { DeviceBinding } from '../../device-binding.js'
import { DeviceRole, DeviceType } from '../../device-type.js'
import { EventCategory } from '../../../enums/event-category.js'
import { actionsForDevice, renderVocabPhrase, triggersForDevice } from '../resolve.js'

function binding(caps: readonly string[], kind: 'native' | 'wrapped' = 'native'): DeviceBinding {
  return {
    deviceId: 3630,
    entries: caps.map((capName) => ({
      capName,
      kind,
      providerAddonId: 'provider-x',
      providerNodeId: 'hub',
      nativeAddonId: 'provider-x',
    })),
  }
}

describe('actionsForDevice', () => {
  it('a siren (switch + motion-trigger) is sounded and silenced, and its motion trigger toggled', () => {
    const actions = actionsForDevice(
      binding(['switch', 'motion-trigger', 'battery']),
      DeviceType.Siren,
    )
    expect(actions.map((a) => a.id)).toEqual([
      'switch.on',
      'switch.off',
      'motionTrigger.on',
      'motionTrigger.off',
    ])
    const on = actions[0]
    expect(on?.label).toEqual({ en: 'Sound', it: 'Fai suonare' })
    expect(on?.phrase.en).toBe('Sound {device}')
    expect(on?.icon).toBe('siren')
    expect(on).toMatchObject({
      cap: 'switch',
      method: 'setState',
      args: { on: true },
      access: 'create',
    })
  })

  it('a plain switch keeps the generic wording; a switch whose ROLE is siren takes the siren wording', () => {
    const plain = actionsForDevice(['switch'], DeviceType.Switch)
    expect(plain[0]?.phrase.en).toBe('Turn on {device}')
    const siren = actionsForDevice(['switch'], DeviceType.Switch, DeviceRole.Siren)
    expect(siren[0]?.phrase).toEqual({
      en: 'Sound {device}',
      it: 'Fai suonare {device}',
    })
  })

  it('a PTZ camera goes to a preset offered from the camera’s own preset list', () => {
    const actions = actionsForDevice(
      binding(['ptz', 'ptz-autotrack', 'camera-streams', 'motion']),
      DeviceType.Camera,
    )
    const goTo = actions.find((a) => a.id === 'ptz.goToPreset')
    expect(goTo?.phrase.en).toBe('Move {device} to {presetId}')
    expect(goTo?.openArgs).toEqual([
      {
        key: 'presetId',
        label: { en: 'Preset', it: 'Preset' },
        offer: {
          kind: 'dynamic',
          from: 'method',
          method: 'getPresets',
          valueKey: 'id',
          labelKey: 'name',
        },
      },
    ])
    expect(goTo?.args).toEqual({})
    expect(actions.map((a) => a.id)).toContain('ptz.autotrackOn')
    expect(actions.some((a) => a.cap === 'camera-streams' || a.cap === 'motion')).toBe(false)
  })

  it('a lock locks, unlocks (with an optional PIN) and opens its latch', () => {
    const actions = actionsForDevice(['lock-control'], DeviceType.Lock)
    expect(actions.map((a) => a.id)).toEqual(['lock.lock', 'lock.unlock', 'lock.open'])
    expect(actions[1]?.openArgs).toEqual([
      {
        key: 'code',
        label: { en: 'PIN code', it: 'Codice PIN' },
        offer: { kind: 'text', secret: true },
        optional: true,
      },
    ])
  })

  it('a dishwasher offers its cycle actions and resets only resettable consumables', () => {
    const actions = actionsForDevice(['dishwasher', 'consumables'], DeviceType.Dishwasher)
    expect(actions.map((a) => a.id)).toContain('dishwasher.start')
    const reset = actions.find((a) => a.id === 'consumables.reset')
    expect(reset).toMatchObject({
      cap: 'consumables',
      method: 'reset',
      access: 'delete',
    })
    expect(reset?.openArgs[0]?.offer).toEqual({
      kind: 'dynamic',
      from: 'status',
      field: 'items',
      valueKey: 'key',
      labelKey: 'label',
      where: { key: 'resettable', equals: true },
    })
  })

  it('a vacuum starts, docks and picks its suction from the device list', () => {
    const actions = actionsForDevice(['vacuum-control', 'battery'], DeviceType.Vacuum)
    expect(actions.map((a) => a.id)).toEqual([
      'vacuum.start',
      'vacuum.pause',
      'vacuum.stop',
      'vacuum.dock',
      'vacuum.locate',
      'vacuum.fanSpeed',
    ])
    expect(actions[5]?.openArgs[0]?.offer).toEqual({
      kind: 'dynamic',
      from: 'status',
      field: 'availableFanSpeeds',
    })
  })

  it('never branches on the binding kind (D13): native and wrapped give the same vocabulary', () => {
    const caps = ['switch', 'brightness', 'color']
    expect(actionsForDevice(binding(caps, 'wrapped'), DeviceType.Light)).toEqual(
      actionsForDevice(binding(caps, 'native'), DeviceType.Light),
    )
  })

  it('ignores system caps, unknown caps and duplicate entries', () => {
    expect(actionsForDevice(['backup', 'no-such-cap'], DeviceType.Generic)).toEqual([])
    expect(actionsForDevice(['button', 'button'], DeviceType.Button).map((a) => a.id)).toEqual([
      'button.press',
    ])
  })
})

describe('triggersForDevice', () => {
  it('a siren is watched for sounding and for its motion-trigger toggle', () => {
    const triggers = triggersForDevice(['switch', 'motion-trigger'], DeviceType.Siren)
    expect(triggers.map((tr) => tr.id)).toEqual(['switch.state.on', 'motion-trigger.state.enabled'])
    const on = triggers[0]
    if (on?.kind !== 'boolean') throw new Error('expected a boolean trigger')
    expect(on.whenTrue.en).toBe('When {device} starts sounding')
    expect(on.whenTrueFor.en).toBe(
      'When {device} starts sounding and stays that way for {minutes} minutes',
    )
    expect(on.whenFalseFor.it).toBe(
      'Quando {device} smette di suonare e resta così per {minutes} minuti',
    )
  })

  it('a contact opens and closes; a binary sensor whose role is motion detects motion', () => {
    const contact = triggersForDevice(['contact'], DeviceType.Sensor)
    expect(contact[0]).toMatchObject({
      kind: 'boolean',
      cap: 'contact',
      field: 'entryOpen',
    })
    const motion = triggersForDevice(['binary'], DeviceType.Sensor, DeviceRole.MotionSensor)
    if (motion[0]?.kind !== 'boolean') throw new Error('expected a boolean trigger')
    expect(motion[0].whenTrue.en).toBe('When {device} detects motion')
  })

  it('a numeric field is phrased as rises above / falls below / changes by, with its unit', () => {
    const [temp] = triggersForDevice(['temperature-sensor'], DeviceType.Sensor)
    if (temp?.kind !== 'numeric') throw new Error('expected a numeric trigger')
    expect(temp.unit).toBe('°C')
    expect(temp.above.en).toBe('When the temperature of {device} rises above {threshold}')
    expect(temp.below.it).toBe('Quando la temperatura di {device} scende sotto {threshold}')
    expect(temp.changesBy.en).toBe('When the temperature of {device} changes by {delta}')
  })

  it('an enum field phrases each value, with the default wording where none is given', () => {
    const [lock] = triggersForDevice(['lock-control'], DeviceType.Lock)
    if (lock?.kind !== 'enum') throw new Error('expected an enum trigger')
    expect(lock.values.find((v) => v.value === 'jammed')?.phrase.en).toBe('When {device} jams')
    const [cover] = triggersForDevice(['cover'], DeviceType.Cover)
    if (cover?.kind !== 'enum') throw new Error('expected an enum trigger')
    expect(cover.values.find((v) => v.value === 'open')?.phrase.en).toBe(
      'When {device} is fully open',
    )
    const [climate] = triggersForDevice(['climate-control'], DeviceType.Climate)
    if (climate?.kind !== 'enum') throw new Error('expected an enum trigger')
    expect(climate.values.find((v) => v.value === 'dry')?.phrase).toEqual({
      en: 'When {device} changes to Dry',
      it: 'Quando {device} passa a Deumidificazione',
    })
  })

  it('a doorbell is an EVENT trigger on its bus category', () => {
    const triggers = triggersForDevice(['doorbell', 'motion', 'ptz'], DeviceType.Camera)
    const ring = triggers.find((tr) => tr.kind === 'event')
    expect(ring).toMatchObject({
      kind: 'event',
      cap: 'doorbell',
      category: EventCategory.DoorbellOnPressed,
      phrase: {
        en: 'When someone rings {device}',
        it: 'Quando qualcuno suona a {device}',
      },
    })
    expect(triggers.some((tr) => tr.kind === 'boolean' && tr.cap === 'motion')).toBe(true)
  })

  it('a dishwasher is watched for its cycle finishing and a vacuum for docking', () => {
    const dish = triggersForDevice(['dishwasher'], DeviceType.Dishwasher)
    const cycle = dish.find((tr) => tr.id === 'dishwasher.state.state')
    if (cycle?.kind !== 'enum') throw new Error('expected an enum trigger')
    expect(cycle.values.find((v) => v.value === 'finished')?.phrase.en).toBe(
      'When {device} finishes',
    )
    const vac = triggersForDevice(['vacuum-control'], DeviceType.Vacuum)
    const state = vac.find((tr) => tr.id === 'vacuum-control.state.state')
    if (state?.kind !== 'enum') throw new Error('expected an enum trigger')
    expect(state.values.find((v) => v.value === 'docked')?.phrase.it).toBe(
      'Quando {device} arriva alla base',
    )
  })
})

describe('renderVocabPhrase', () => {
  it('fills placeholders in the chosen language and leaves unknown ones visible', () => {
    expect(
      renderVocabPhrase(
        {
          en: 'Move {device} to {presetId}',
          it: 'Sposta {device} su {presetId}',
        },
        'it',
        {
          device: 'Garden',
          presetId: 'Cancello',
        },
      ),
    ).toBe('Sposta Garden su Cancello')
    expect(
      renderVocabPhrase({ en: 'Turn on {device} at {when}', it: '' }, 'en', {
        device: 'Lamp',
      }),
    ).toBe('Turn on Lamp at {when}')
  })
})
