import { describe, expect, it } from 'vitest'
import { parseFlipperIr } from '../../ir/flipper.js'
import { flipperIrDraft, flipperRole } from '../flipper-ir-draft.js'

describe('flipperRole', () => {
  it.each([
    ['Power', 'power'],
    ['POWER', 'power'],
    ['Pwr', 'power'],
    ['Power_On', 'power_on'],
    ['Off', 'power_off'],
    ['Vol_up', 'volume_up'],
    ['Vol+', 'volume_up'],
    ['VOL-', 'volume_down'],
    ['Volume Down', 'volume_down'],
    ['Mute', 'mute'],
    ['Ch_next', 'channel_up'],
    ['CH+', 'channel_up'],
    ['Channel_Down', 'channel_down'],
    ['Ch_prev', 'channel_down'],
    ['0', 'digit_0'],
    ['Num_7', 'digit_7'],
    ['Digit9', 'digit_9'],
    ['Enter', 'ok'],
    ['OK', 'ok'],
    ['Return', 'back'],
    ['Source', 'input'],
    ['FF', 'fast_forward'],
    ['Play_Pause', 'play_pause'],
    ['Up', 'up'],
  ])('%s -> %s', (name, role) => {
    expect(flipperRole(name)).toBe(role)
  })

  it.each([
    'Netflix',
    'Prime Video',
    'Samsung TV Plus',
    'Vol_up_2x',
    '10',
  ])('%s has no known role', (name) => {
    expect(flipperRole(name)).toBeUndefined()
  })
})

const HEAD = 'Filetype: IR signals file\nVersion: 1\n'
const sam = (name: string, cmd: string): string =>
  `#\nname: ${name}\ntype: parsed\nprotocol: Samsung32\naddress: 07 00 00 00\ncommand: ${cmd} 00 00 00\n`

describe('flipperIrDraft', () => {
  const text =
    HEAD +
    sam('Power', '02') +
    sam('Vol_up', '07') +
    sam('Vol_up', '07') +
    sam('Netflix', 'F3') +
    sam('3', '08') +
    '#\nname: Ch_up\ntype: parsed\nprotocol: RC5\naddress: 05 00 00 00\ncommand: 20 00 00 00\n'
  const draft = flipperIrDraft(parseFlipperIr(text), { transmitterDeviceId: 11 })

  it('binds known names to roles through the transmitter', () => {
    expect(draft.power.mode).toBe('toggle')
    expect(Object.keys(draft.bindings).sort()).toEqual([
      'custom:netflix',
      'digit_3',
      'power',
      'volume_up',
    ])
    expect(draft.bindings['power']?.action).toMatchObject({
      kind: 'cap',
      deviceId: 11,
      cap: 'ir-transmitter',
      method: 'send',
    })
  })

  it('keeps an app as a custom button named as the file spells it', () => {
    expect(draft.customButtons).toEqual([{ key: 'netflix', name: 'Netflix' }])
  })

  it('reports an unsupported protocol and a duplicate role, never drops silently', () => {
    expect(draft.skipped.map((s) => s.name).sort()).toEqual(['Ch_up', 'Vol_up'])
    expect(draft.skipped.find((s) => s.name === 'Ch_up')?.reason).toMatch(/RC5/)
    expect(draft.skipped.find((s) => s.name === 'Vol_up')?.reason).toMatch(/volume_up/)
  })

  it('separate Power_On and Power_Off are a discrete pair', () => {
    const d = flipperIrDraft(
      parseFlipperIr(HEAD + sam('Power_On', '02') + sam('Power_Off', '03')),
      { transmitterDeviceId: 1 },
    )
    expect(d.power.mode).toBe('discrete')
    expect(Object.keys(d.bindings).sort()).toEqual(['power_off', 'power_on'])
  })
})
