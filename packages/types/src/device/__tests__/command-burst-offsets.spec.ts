import { describe, expect, it } from 'vitest'
import { commandBurstOffsets } from '../state-refresh.js'

describe('commandBurstOffsets', () => {
  it('reads at 3 s and 10 s, then every 10 s, then once 2 s before a 30 s hold expires', () => {
    expect(commandBurstOffsets(30_000)).toEqual([3_000, 10_000, 20_000, 28_000])
  })

  it('covers a 120 s hold up to 2 s before its limit', () => {
    const offsets = commandBurstOffsets(120_000)
    expect(offsets.at(-1)).toBe(118_000)
    expect(offsets.slice(0, 3)).toEqual([3_000, 10_000, 20_000])
    expect(offsets.every((o, i) => i === 0 || o > (offsets[i - 1] ?? 0))).toBe(true)
  })

  it('never reads at or after the hold limit', () => {
    expect(commandBurstOffsets(8_000)).toEqual([3_000, 6_000])
    expect(commandBurstOffsets(0)).toEqual([])
  })
  it('skips the tail read when it would land within a second of the last stepped read', () => {
    expect(commandBurstOffsets(22_001)).toEqual([3_000, 10_000, 20_000])
    expect(commandBurstOffsets(23_000)).toEqual([3_000, 10_000, 20_000, 21_000])
  })
})
