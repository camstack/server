/**
 * QuantityValueInput: shows a stored number in the unit the person picked
 * without converting it again, emits `{ value, unit }`, converts the offer's
 * bounds into the picked unit, and has no picker when only one unit exists.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuantityValueInput } from './QuantityValueInput'
import { boundsInPicked, outsideBounds, storedToPicked, typedToStored } from './quantity-value'

describe('quantity-value helpers', () => {
  it('shows a number stored in grams in ounces, tidied', () => {
    expect(storedToPicked(56.699, 'g', 'oz')).toBe(2)
    expect(storedToPicked(0.05, 'kg', 'g')).toBe(50)
  })

  it('leaves the number as stored when the unit is the stored one', () => {
    expect(storedToPicked(30, 'g', 'g')).toBe(30)
  })

  it('converts the bounds of the offer into the picked unit', () => {
    expect(boundsInPicked({ min: 10, max: 500 }, 'g', 'kg')).toEqual({ min: 0.01, max: 0.5 })
  })

  it('judges a stored number against stored-unit bounds', () => {
    expect(outsideBounds(600, { min: 10, max: 500 })).toBe(true)
    expect(outsideBounds(50, { min: 10, max: 500 })).toBe(false)
  })

  it('stores what was typed in the stored unit and keeps the picked unit', () => {
    expect(typedToStored({ value: 2, unit: 'oz' }, 'g')).toEqual({ value: 56.699, unit: 'oz' })
  })

  it('refuses a unit of another dimension', () => {
    expect(() => typedToStored({ value: 2, unit: 'm' }, 'g')).toThrow(/cross-dimension/)
  })
})

describe('QuantityValueInput', () => {
  it('displays the stored value in the stored picked unit, not re-converted', () => {
    render(
      <QuantityValueInput
        quantity="mass"
        storedUnit="g"
        value={56.699}
        unit="oz"
        aria-label="Portion"
        onChange={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Portion') as HTMLInputElement).value).toBe('2')
    expect((screen.getByLabelText('Portion unit') as HTMLSelectElement).value).toBe('oz')
  })

  it('emits the typed number with the picked unit', () => {
    const onChange = vi.fn()
    render(
      <QuantityValueInput
        quantity="mass"
        storedUnit="g"
        value={30}
        unit="g"
        aria-label="Portion"
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Portion'), { target: { value: '45' } })
    expect(onChange).toHaveBeenCalledWith({ value: 45, unit: 'g' })
  })

  it('keeps the physical amount when the unit changes', () => {
    const onChange = vi.fn()
    render(
      <QuantityValueInput
        quantity="mass"
        storedUnit="g"
        value={1000}
        unit="g"
        aria-label="Portion"
        onChange={onChange}
      />,
    )
    fireEvent.change(screen.getByLabelText('Portion unit'), { target: { value: 'kg' } })
    expect(onChange).toHaveBeenCalledWith({ value: 1, unit: 'kg' })
  })

  it('falls back to the stored unit when the saved one is not a unit of the quantity', () => {
    render(
      <QuantityValueInput
        quantity="mass"
        storedUnit="g"
        value={30}
        unit="m"
        aria-label="Portion"
        onChange={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Portion unit') as HTMLSelectElement).value).toBe('g')
  })

  it('shows the unit as a suffix, with no picker, when only one unit exists', () => {
    render(
      <QuantityValueInput quantity="percentage" value={40} aria-label="Level" onChange={vi.fn()} />,
    )
    expect(screen.queryByLabelText('Level unit')).toBeNull()
    expect(screen.getByText('%')).toBeTruthy()
  })
})
