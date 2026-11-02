import { describe, expect, it } from 'vitest'
import { summarizeBinding, targetLabel } from '../binding-summary'
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
    expect(summarizeBinding({ kind: 'cap', deviceId: 5, cap: 'switch', method: 'turnOn' })).toEqual(
      {
        call: 'switch.turnOn',
        timings: null,
        carrierHz: null,
      },
    )
  })
})

describe('targetLabel', () => {
  const devices = [
    { id: 1, name: 'send_raw_command', stableId: 'a', parentName: 'Kitchen board' },
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
