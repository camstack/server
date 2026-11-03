import {
  type Composition,
  DeviceType,
  type HelperMember,
  mediaPlayerExtensionCommands,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { canCreate, createNeedOf, nakedComposition, sourceRequestOf } from '../device-create-model'

const PLUG: HelperMember = {
  source: { addonId: 'provider-homeassistant', stableId: 'switch.stove_plug' },
  cap: 'switch',
  fieldPath: 'on',
}
const PLAYER: HelperMember = {
  source: { addonId: 'provider-homeassistant', stableId: 'media_player.tv' },
  cap: 'media-player',
  fieldPath: 'state',
}
const METER: HelperMember = { ...PLUG, cap: 'power-meter', fieldPath: 'power' }

const capsOf = (c: Composition | null): readonly string[] => (c?.features ?? []).map((f) => f.cap)

describe('a device is created naked (D1004)', () => {
  it.each([
    DeviceType.Sensor,
    DeviceType.Washer,
    DeviceType.Switch,
    DeviceType.Light,
  ])('%s carries no feature, and asks for nothing', (type) => {
    expect(nakedComposition(type, null)).toEqual({ target: { kind: 'new', type }, features: [] })
    expect(createNeedOf(type)).toBe('none')
    expect(sourceRequestOf(type)).toBeNull()
  })

  it('never attaches power metrics, running state or consumables, whatever the source', () => {
    for (const type of [DeviceType.Heater, DeviceType.MediaPlayer, DeviceType.Washer]) {
      const caps = capsOf(nakedComposition(type, PLUG))
      for (const cap of ['power-meter', 'running-state', 'consumables', 'power-source']) {
        expect(caps).not.toContain(cap)
      }
    }
  })
})

describe('media player', () => {
  it('forwards every media-player command to the source when it exposes them, never to a remote', () => {
    const composition = nakedComposition(DeviceType.MediaPlayer, PLAYER)
    const feature = composition?.features[0]
    const commands = feature?.kind === 'fields' ? (feature.commands ?? {}) : {}
    const methods = Object.keys(mediaPlayerExtensionCommands())
    expect(Object.keys(commands).sort()).toEqual([...methods].sort())
    for (const method of methods) {
      expect(commands[method]).toEqual({
        kind: 'forward',
        source: PLAYER.source,
        cap: 'media-player',
        method,
      })
    }
  })

  it('is naked without a source', () => {
    expect(nakedComposition(DeviceType.MediaPlayer, null)?.features).toEqual([])
  })

  it('is naked when the source does not expose the media-player cap', () => {
    expect(nakedComposition(DeviceType.MediaPlayer, PLUG)?.features).toEqual([])
  })

  it('asks for a media-player source, and the source is optional', () => {
    expect(sourceRequestOf(DeviceType.MediaPlayer)?.accept[0]?.cap).toBe('media-player')
    expect(canCreate(DeviceType.MediaPlayer, null)).toBe(true)
  })
})

describe('heater', () => {
  it('cannot be created before its plug is picked, nor from a non-switch member', () => {
    expect(nakedComposition(DeviceType.Heater, null)).toBeNull()
    expect(canCreate(DeviceType.Heater, METER)).toBe(false)
    expect(nakedComposition(DeviceType.Heater, METER)).toBeNull()
  })

  it('is created with only the plug control: on/off forward to the plug', () => {
    const composition = nakedComposition(DeviceType.Heater, PLUG)
    expect(capsOf(composition)).toEqual(['switch'])
    const feature = composition?.features[0]
    expect(feature?.kind === 'fields' ? feature.commands : undefined).toEqual({
      setState: { kind: 'forward', source: PLUG.source, cap: 'switch', method: 'setState' },
    })
  })

  it('asks for a plug', () => {
    expect(createNeedOf(DeviceType.Heater)).toBe('control-source')
    expect(sourceRequestOf(DeviceType.Heater)?.mustBindCaps).toEqual(['switch'])
  })
})
