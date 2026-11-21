/**
 * D1078 — the synthetic decode source is one Annex B file; the pacer needs it
 * as ACCESS UNITS (one coded picture each), cut on the access-unit delimiter
 * the encoder was told to write, with the keyframes known.
 */
import { describe, expect, it } from 'vitest'
import { splitAccessUnits } from '../annexb-access-units.js'

const SC4 = [0, 0, 0, 1]
const SC3 = [0, 0, 1]

/** H.264 NAL header byte for a type. */
const h264 = (type: number): number => 0x60 | type
/** H.265 NAL header (two bytes) for a type. */
const h265 = (type: number): number[] => [type << 1, 1]

describe('splitAccessUnits', () => {
  it('cuts H.264 on the delimiter (type 9) and marks the IDR pictures', () => {
    const data = Buffer.from([
      ...SC4,
      h264(9),
      0x10,
      ...SC4,
      h264(7),
      1,
      2,
      ...SC3,
      h264(8),
      3,
      ...SC3,
      h264(5),
      4,
      5,
      6,
      ...SC4,
      h264(9),
      0x30,
      ...SC3,
      h264(1),
      7,
      8,
      ...SC4,
      h264(9),
      0x30,
      ...SC3,
      h264(1),
      9,
    ])
    const units = splitAccessUnits(data, 'h264')
    expect(units.map((u) => u.keyframe)).toEqual([true, false, false])
    expect(Buffer.concat(units.map((u) => u.data)).equals(data)).toBe(true)
    expect(units[1]?.data.equals(Buffer.from([...SC4, h264(9), 0x30, ...SC3, h264(1), 7, 8]))).toBe(
      true,
    )
  })

  it('cuts H.265 on the delimiter (type 35) and marks the IRAP pictures', () => {
    const data = Buffer.from([
      ...SC4,
      ...h265(35),
      0x50,
      ...SC4,
      ...h265(32),
      1,
      ...SC3,
      ...h265(19),
      2,
      3,
      ...SC4,
      ...h265(35),
      0x50,
      ...SC3,
      ...h265(1),
      4,
    ])
    const units = splitAccessUnits(data, 'h265')
    expect(units.map((u) => u.keyframe)).toEqual([true, false])
    expect(Buffer.concat(units.map((u) => u.data)).equals(data)).toBe(true)
  })

  it('a stream without delimiters yields nothing rather than one guessed unit', () => {
    const data = Buffer.from([...SC4, h264(7), 1, ...SC3, h264(5), 2, ...SC3, h264(1), 3])
    expect(splitAccessUnits(data, 'h264')).toEqual([])
  })

  it('bytes before the first delimiter are dropped', () => {
    const data = Buffer.from([9, 9, ...SC3, h264(6), 1, ...SC4, h264(9), 0x10, ...SC3, h264(5), 2])
    const units = splitAccessUnits(data, 'h264')
    expect(units).toHaveLength(1)
    expect(units[0]?.data[4]).toBe(h264(9))
  })
})
