import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  QuantityUnitError,
  convertQuantityInput,
  isQuantityValue,
  paramMeta,
  paramMetaOf,
} from '../quantity-input.js'

function refusalCode(run: () => unknown): string | undefined {
  try {
    run()
  } catch (err: unknown) {
    return err instanceof QuantityUnitError ? err.code : 'not-a-QuantityUnitError'
  }
  return undefined
}

describe('convertQuantityInput', () => {
  it('converts grams into the kilogram base', () => {
    expect(convertQuantityInput({ value: 10, unit: 'g', target: 'kg' })).toBeCloseTo(0.01, 9)
  })

  it('converts kilograms into a gram param', () => {
    expect(convertQuantityInput({ value: 0.1, unit: 'kg', target: 'g' })).toBeCloseTo(100, 9)
  })

  it('refuses another dimension with a typed error', () => {
    expect(refusalCode(() => convertQuantityInput({ value: 1, unit: 'L', target: 'kg' }))).toBe(
      'cross-dimension',
    )
  })

  it('refuses an unknown unit and a non-finite value', () => {
    expect(refusalCode(() => convertQuantityInput({ value: 1, unit: 'stone', target: 'kg' }))).toBe(
      'unknown-unit',
    )
    expect(
      refusalCode(() => convertQuantityInput({ value: Number.NaN, unit: 'g', target: 'kg' })),
    ).toBe('non-finite')
  })
})

describe('isQuantityValue', () => {
  it('recognises the wire pair only', () => {
    expect(isQuantityValue({ value: 3, unit: 'g' })).toBe(true)
    expect(isQuantityValue({ value: '3', unit: 'g' })).toBe(false)
    expect(isQuantityValue(3)).toBe(false)
    expect(isQuantityValue({ $var: 'x' })).toBe(false)
  })
})

describe('paramMeta', () => {
  it('is read back from a method input field, through optional wrappers', () => {
    const field = z
      .number()
      .int()
      .meta(paramMeta({ quantity: 'mass', unit: 'g' }))
      .optional()
    expect(paramMetaOf(field)).toEqual({ quantity: 'mass', unit: 'g' })
  })

  it('is undefined for a plain number', () => {
    expect(paramMetaOf(z.number())).toBeUndefined()
  })

  it('refuses a declared unit that is not of the quantity dimension', () => {
    expect(refusalCode(() => paramMeta({ quantity: 'mass', unit: 'L' }))).toBe('cross-dimension')
  })
})
