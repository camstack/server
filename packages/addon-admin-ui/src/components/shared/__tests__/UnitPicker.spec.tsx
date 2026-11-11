/**
 * UnitPicker offers only same-dimension units. An unanswered / unknown
 * dimension disables the control and names why — never an all-units list
 * that could author a refused conversion.
 */
import { selectOption, selectOptionValues } from '@camstack/ui-library/testing'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnitPicker } from '../UnitPicker'

describe('UnitPicker', () => {
  it('lists only units of the given dimension', () => {
    const onChange = vi.fn()
    render(
      <UnitPicker
        dimension="temperature"
        value=""
        onChange={onChange}
        aria-label="Unit"
        inheritLabel="Inherit"
      />,
    )
    const select = screen.getByLabelText('Unit')
    const options = selectOptionValues(select)
    expect(options).toEqual(['', '°C', '°F', 'K'])
    expect(options).not.toContain('hPa')
    expect(options).not.toContain('m/s')
  })

  it('disables and names the reason when dimension is empty', () => {
    render(
      <UnitPicker
        dimension={undefined}
        value=""
        onChange={vi.fn()}
        aria-label="Unit"
        emptyReason="Source unit unknown"
      />,
    )
    const select = screen.getByLabelText('Unit')
    expect(select).toBeDisabled()
    expect(screen.getByText('Source unit unknown')).toBeTruthy()
    expect(selectOptionValues(select)).toHaveLength(0)
  })

  it('normalizes the chosen unit before calling onChange', () => {
    const onChange = vi.fn()
    render(<UnitPicker dimension="temperature" value="" onChange={onChange} aria-label="Unit" />)
    selectOption(screen.getByLabelText('Unit'), '°F')
    expect(onChange).toHaveBeenCalledWith('°F')
  })
})
