import { describe, expect, it } from 'vitest'
import { describeBinding, summarizeBinding, targetLabel } from '../binding-summary'
import { templateEditPath } from '../EditTemplateButton'

describe('summarizeBinding', () => {
  it('counts the timings of an infrared train and reads its carrier', () => {
    expect(
      summarizeBinding({
        kind: 'cap',
        deviceId: 5,
        cap: 'ir-transmitter',
        method: 'send',
        args: { timings: [1, -1, 1], settings: { carrierHz: 38000 } },
      }),
    ).toEqual({ call: 'ir-transmitter.send', timings: 3, carrierHz: 38000 })
  })

  it('reports no timings for an action without a train', () => {
    expect(
      summarizeBinding({
        kind: 'cap',
        deviceId: 5,
        cap: 'switch',
        method: 'turnOn',
      }),
    ).toEqual({
      call: 'switch.turnOn',
      timings: null,
      carrierHz: null,
    })
  })
})

describe('targetLabel', () => {
  const devices = [
    {
      id: 1,
      name: 'send_raw_command',
      stableId: 'a',
      parentName: 'Kitchen board',
    },
    { id: 2, name: 'Plug', stableId: 'b' },
  ]
  it('joins the device and its parent board', () => {
    expect(targetLabel(1, devices, '?')).toBe('send_raw_command · Kitchen board')
    expect(targetLabel(2, devices, '?')).toBe('Plug')
    expect(targetLabel(9, devices, '#9')).toBe('#9')
  })
})

describe('templateEditPath', () => {
  it('is the Templates page with the id to edit', () => {
    expect(templateEditPath('tpl 1')).toBe('/system/templates?edit=tpl%201')
  })
})

describe('describeBinding', () => {
  const devices = [
    {
      id: 5,
      name: 'send_raw_command',
      stableId: 'a',
      parentName: 'Broadlink salone',
    },
    { id: 7, name: 'Living room TV', stableId: 'b' },
  ]

  it('reads no binding as unbound', () => {
    expect(describeBinding(undefined, devices)).toEqual({ kind: 'unbound' })
  })

  it('reads a binding without device, cap or method as incomplete', () => {
    expect(describeBinding({ kind: 'cap', deviceId: 0, cap: '', method: '' }, devices)).toEqual({
      kind: 'incomplete',
    })
    expect(
      describeBinding({ kind: 'cap', deviceId: 7, cap: 'switch', method: '' }, devices),
    ).toEqual({ kind: 'incomplete' })
  })

  it('describes an infrared send by its transmitter, pulses and carrier', () => {
    expect(
      describeBinding(
        {
          kind: 'cap',
          deviceId: 5,
          cap: 'ir-transmitter',
          method: 'send',
          args: { timings: [1, -1, 1], settings: { carrierHz: 38000 } },
        },
        devices,
      ),
    ).toEqual({
      kind: 'infrared',
      target: 'send_raw_command · Broadlink salone',
      pulses: 3,
      carrierKhz: 38,
      args: [],
    })
  })

  it('describes any other cap call by target, call and scalar arguments only', () => {
    expect(
      describeBinding(
        {
          kind: 'cap',
          deviceId: 7,
          cap: 'media-player',
          method: 'setVolume',
          args: {
            level: 20,
            mode: 'soft',
            muted: false,
            steps: [1, 2],
            extra: { a: 1 },
          },
        },
        devices,
      ),
    ).toEqual({
      kind: 'call',
      target: 'Living room TV',
      call: 'media-player.setVolume',
      args: [
        { name: 'level', value: '20' },
        { name: 'mode', value: 'soft' },
        { name: 'muted', value: 'false' },
      ],
    })
  })

  it('falls back to the device id when the device is unknown', () => {
    expect(
      describeBinding({ kind: 'cap', deviceId: 99, cap: 'switch', method: 'turnOn' }, devices),
    ).toMatchObject({ kind: 'call', target: '#99' })
  })
})
