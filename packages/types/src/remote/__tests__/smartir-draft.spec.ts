import { describe, expect, it } from 'vitest'
import { parseSmartIr } from '../../ir/smartir.js'
import { smartIrDraft } from '../smartir-draft.js'
import { RemoteConfigSchema } from '../remote-config.js'

/**
 * A SmartIR media_player device-code file shaped like the published ones. The
 * pulses are synthesized: a NEC-ish header, bits of 560 mark and 560/1690
 * space, and a stop mark.
 */
function burst(bits: readonly number[]): number[] {
  const pulses: number[] = [9000, -4500]
  for (const bit of bits) pulses.push(560, bit === 1 ? -1690 : -560)
  pulses.push(560)
  return pulses
}

const POWER = burst([1, 0, 1, 0, 0, 1, 1, 0])

function fixture(commands: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manufacturer: 'Acme',
    supportedModels: ['AC-7000'],
    supportedController: 'ESPHome',
    commandsEncoding: 'Raw',
    commands: {
      off: JSON.stringify(POWER),
      on: JSON.stringify(POWER),
      previousChannel: JSON.stringify(burst([0, 0, 0, 1])),
      nextChannel: JSON.stringify(burst([0, 0, 1, 0])),
      volumeDown: JSON.stringify(burst([1, 1, 0, 0, 1, 1, 0, 0])),
      volumeUp: JSON.stringify(burst([1, 1, 0, 0, 1, 0, 1, 0])),
      mute: JSON.stringify(burst([0, 1, 0, 1])),
      sources: {
        TV: JSON.stringify(burst([1, 0, 0, 0])),
        'HDMI 1': JSON.stringify(burst([1, 0, 0, 1])),
      },
      ...commands,
    },
  }
}

const TARGET = { transmitterDeviceId: 9 }

function draftOf(file: Record<string, unknown>, target = TARGET) {
  return smartIrDraft(parseSmartIr(file).table, target)
}

describe('smartIrDraft', () => {
  it('binds each known command to its role through ir-transmitter.send on the transmitter', () => {
    const draft = draftOf(fixture())
    expect(draft.bindings['volume_up']?.action).toMatchObject({
      kind: 'cap',
      cap: 'ir-transmitter',
      method: 'send',
      deviceId: 9,
      args: { timings: expect.any(Array) },
    })
    expect(Object.keys(draft.bindings)).toEqual(
      expect.arrayContaining(['channel_up', 'channel_down', 'volume_down', 'mute']),
    )
  })

  it('identical on and off codes are ONE power toggle, different codes a discrete pair', () => {
    const toggle = draftOf(fixture())
    expect(toggle.power.mode).toBe('toggle')
    expect(toggle.bindings['power']).toBeDefined()
    expect(toggle.bindings['power_on']).toBeUndefined()

    const discrete = draftOf(fixture({ on: JSON.stringify(burst([1, 1, 1, 1])) }))
    expect(discrete.power.mode).toBe('discrete')
    expect(discrete.bindings['power_on']).toBeDefined()
    expect(discrete.bindings['power_off']).toBeDefined()
    expect(discrete.bindings['power']).toBeUndefined()
  })

  it('a source and an unknown command become custom buttons, named as the file spells them', () => {
    const draft = draftOf(fixture({ ambilight: JSON.stringify(burst([0, 0, 1, 1])) }))
    expect(draft.customButtons).toEqual(
      expect.arrayContaining([
        { key: 'source_tv', name: 'TV' },
        { key: 'source_hdmi_1', name: 'HDMI 1' },
        { key: 'ambilight', name: 'ambilight' },
      ]),
    )
    expect(draft.bindings['custom:source_hdmi_1']).toBeDefined()
    expect(draft.bindings['custom:ambilight']).toBeDefined()
  })

  it('a command that names its own transmitter keeps it, the others use the default', () => {
    const table = parseSmartIr(fixture()).table
    const draft = smartIrDraft(
      {
        ...table,
        commands: table.commands.map((c) =>
          c.name === 'volumeUp' ? { ...c, transmitterDeviceId: 42 } : c,
        ),
      },
      TARGET,
    )
    expect(draft.bindings['volume_up']?.action.deviceId).toBe(42)
    expect(draft.bindings['volume_down']?.action.deviceId).toBe(9)
  })

  it('a Pronto code is decoded and carries its carrier as a setting', () => {
    const draft = draftOf({
      ...fixture(),
      commandsEncoding: 'Pronto',
      commands: { mute: '0000 006D 0002 0000 0010 0008 0010 0020' },
    })
    expect(draft.bindings['mute']?.action.args).toMatchObject({
      settings: { carrierHz: expect.any(Number) },
    })
  })

  it('the draft is a valid remote config body', () => {
    const draft = draftOf(fixture())
    const parsed = RemoteConfigSchema.safeParse({
      layoutTemplateId: null,
      defaultTransmitterId: null,
      bindings: draft.bindings,
      customButtons: draft.customButtons,
      power: draft.power,
    })
    expect(parsed.success).toBe(true)
  })
})
