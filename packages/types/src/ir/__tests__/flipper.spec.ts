import { describe, expect, it } from 'vitest'
import { encodeFlipperParsed, flipperIrTable, parseFlipperIr } from '../flipper.js'
import { IrCodecError } from '../ir-error.js'
import { IrTimingsSchema } from '../ir-timings.js'
import { encodeSamsung } from '../samsung.js'

const FILE = `Filetype: IR signals file
Version: 1
#
# Samsung TV
name: Power
type: parsed
protocol: Samsung32
address: 07 00 00 00
command: 02 00 00 00
#
name: Netflix
type: parsed
protocol: Samsung32
address: 07 00 00 00
command: F3 00 00 00
#
name: Vol_up
type: parsed
protocol: NEC
address: 04 00 00 00
command: 02 00 00 00
#
name: Raw_thing
type: raw
frequency: 36000
duty_cycle: 0.330000
data: 9000 4500 560 560 560 1690 560
#
name: Ch_up
type: parsed
protocol: RC5
address: 05 00 00 00
command: 20 00 00 00
`

describe('parseFlipperIr', () => {
  it('reads parsed and raw entries in order', () => {
    const file = parseFlipperIr(FILE)
    expect(file.buttons.map((b) => b.name)).toEqual([
      'Power',
      'Netflix',
      'Vol_up',
      'Raw_thing',
      'Ch_up',
    ])
    expect(file.buttons[1]).toEqual({
      type: 'parsed',
      name: 'Netflix',
      protocol: 'Samsung32',
      address: 0x07,
      command: 0xf3,
    })
    expect(file.buttons[3]).toEqual({
      type: 'raw',
      name: 'Raw_thing',
      frequency: 36000,
      dutyCycle: 0.33,
      data: [9000, 4500, 560, 560, 560, 1690, 560],
    })
  })

  it('reads a multi-byte address as little endian', () => {
    const file = parseFlipperIr(
      'Filetype: IR signals file\nVersion: 1\n#\nname: A\ntype: parsed\nprotocol: NECext\naddress: 85 23 00 00\ncommand: 4F 90 00 00\n',
    )
    expect(file.buttons[0]).toMatchObject({ address: 0x2385, command: 0x904f })
  })

  it('refuses a file that is not an IR signals file', () => {
    expect(() => parseFlipperIr('hello')).toThrow(IrCodecError)
  })

  it('refuses a button with a missing field', () => {
    expect(() =>
      parseFlipperIr(
        'Filetype: IR signals file\nVersion: 1\n#\nname: A\ntype: parsed\nprotocol: NEC\n',
      ),
    ).toThrow(IrCodecError)
  })
})

describe('encodeFlipperParsed', () => {
  it('Samsung32 addr 0x07 cmd 0xF3 (Netflix) equals the proven Samsung encoder', () => {
    // bytes 07 07 F3 0C, each sent LSB first == MSB-first word 0xE0E0CF30.
    const encoded = encodeFlipperParsed({ protocol: 'Samsung32', address: 0x07, command: 0xf3 })
    expect(encoded.timings).toEqual(encodeSamsung({ data: 0xe0e0cf30, nbits: 32 }))
    expect(encoded.timings.slice(0, 2)).toEqual([4500, -4500])
    expect(encoded.carrierHz).toBe(38000)
    expect(IrTimingsSchema.safeParse(encoded.timings).success).toBe(true)
  })

  it('Samsung32 power 0x07/0x02 is the well known 0xE0E040BF', () => {
    const encoded = encodeFlipperParsed({ protocol: 'Samsung32', address: 0x07, command: 0x02 })
    expect(encoded.timings).toEqual(encodeSamsung({ data: 0xe0e040bf, nbits: 32 }))
  })

  it('NEC addr 0x04 cmd 0x02: 9000/-4500 header, A ~A C ~C LSB first, stop mark', () => {
    const { timings } = encodeFlipperParsed({ protocol: 'NEC', address: 0x04, command: 0x02 })
    expect(timings.slice(0, 2)).toEqual([9000, -4500])
    expect(timings).toHaveLength(2 + 32 * 2 + 2)
    // address 0x04 LSB first: 0,0,1,0,0,0,0,0
    const bits = timings.slice(2, 2 + 16).filter((_, i) => i % 2 === 1)
    expect(bits.map((s) => (s === -1690 ? 1 : 0))).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(timings.at(-2)).toBe(560)
  })

  it('NECext sends a 16-bit address and command with no inversion', () => {
    const { timings } = encodeFlipperParsed({
      protocol: 'NECext',
      address: 0x2385,
      command: 0x904f,
    })
    expect(timings.slice(0, 2)).toEqual([9000, -4500])
    expect(timings).toHaveLength(2 + 32 * 2 + 2)
    const bits = timings.slice(2, 2 + 64).filter((_, i) => i % 2 === 1)
    // 0x85 LSB first = 1,0,1,0,0,0,0,1
    expect(bits.slice(0, 8).map((s) => (s === -1690 ? 1 : 0))).toEqual([1, 0, 1, 0, 0, 0, 0, 1])
  })

  it('names a protocol it cannot encode', () => {
    expect(() => encodeFlipperParsed({ protocol: 'RC5', address: 5, command: 0x20 })).toThrow(/RC5/)
  })

  it('refuses an out-of-range Samsung32 command', () => {
    expect(() =>
      encodeFlipperParsed({ protocol: 'Samsung32', address: 0x07, command: 0x1ff }),
    ).toThrow(IrCodecError)
  })
})

describe('flipperIrTable', () => {
  it('turns supported buttons into commands and reports the rest by name', () => {
    const { table, skipped } = flipperIrTable(parseFlipperIr(FILE))
    expect(table.commands.map((c) => c.name)).toEqual(['Power', 'Netflix', 'Vol_up', 'Raw_thing'])
    expect(skipped).toEqual([
      { name: 'Ch_up', group: 'command', reason: expect.stringContaining('RC5') },
    ])
    const raw = table.commands[3]
    expect(raw?.payload).toEqual({
      kind: 'raw',
      timings: [9000, -4500, 560, -560, 560, -1690, 560],
      settings: { carrierHz: 36000, dutyCyclePercent: 33 },
    })
    const netflix = table.commands[1]
    expect(netflix?.payload).toMatchObject({ kind: 'raw', settings: { carrierHz: 38000 } })
  })
})
