import { describe, expect, it } from 'vitest'
import { IrTimingsSchema } from '../ir-timings.js'
import { IrCodecError } from '../ir-error.js'
import { encodeSamsung, SAMSUNG_CARRIER_HZ } from '../samsung.js'

/** The Samsung32 power key: address 0x07, command 0x02, as a board stores it (`data`, `nbits: 32`). */
const POWER = 0xe0e040bf

describe('encodeSamsung', () => {
  it('encodes a 32-bit Samsung frame as header, MSB-first bits and a footer', () => {
    const timings = encodeSamsung({ data: POWER, nbits: 32 })
    // header 4500/4500, 32 bits × (mark, space), footer mark + space
    expect(timings).toHaveLength(2 + 32 * 2 + 2)
    expect(timings.slice(0, 2)).toEqual([4500, -4500])
    // first byte 0xE0 = 1110 0000: three ones, five zeros
    expect(timings.slice(2, 18)).toEqual([
      560, -1690, 560, -1690, 560, -1690, 560, -560, 560, -560, 560, -560, 560, -560, 560, -560,
    ])
    // last byte 0xBF = 1011 1111
    expect(timings.slice(50, 66)).toEqual([
      560, -1690, 560, -560, 560, -1690, 560, -1690, 560, -1690, 560, -1690, 560, -1690, 560, -1690,
    ])
    expect(timings.slice(66)).toEqual([560, -560])
    expect(IrTimingsSchema.safeParse(timings).success).toBe(true)
  })

  it('agrees with a learned raw train of the same key within the board tolerance', () => {
    // The first words of a learned Samsung power train (SmartIR, Raw): same key, same order.
    const learned = [4508, -4545, 536, -1735, 514, -1736, 514, -1736, 514, -574, 514, -574]
    const encoded = encodeSamsung({ data: POWER, nbits: 32 })
    learned.forEach((us, index) => {
      expect(Math.abs(encoded[index]! - us)).toBeLessThanOrEqual(80)
      expect(Math.sign(encoded[index]!)).toBe(Math.sign(us))
    })
  })

  it('carries the Samsung carrier', () => {
    expect(SAMSUNG_CARRIER_HZ).toBe(38000)
  })

  it('refuses a bit count the frame cannot hold and data wider than the bit count', () => {
    expect(() => encodeSamsung({ data: 1, nbits: 0 })).toThrow(IrCodecError)
    expect(() => encodeSamsung({ data: 1, nbits: 33 })).toThrow(IrCodecError)
    expect(() => encodeSamsung({ data: 0x1ff, nbits: 8 })).toThrow(IrCodecError)
    expect(() => encodeSamsung({ data: -1, nbits: 32 })).toThrow(IrCodecError)
    expect(() => encodeSamsung({ data: 1.5, nbits: 32 })).toThrow(IrCodecError)
  })
})
