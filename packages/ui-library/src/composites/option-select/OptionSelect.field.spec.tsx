/**
 * `singleDisplay="field"`: a single choice that always exists is shown IN the
 * field (no chip above it, no clear ×); typing still searches the list.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OptionSelect } from './OptionSelect'

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

function mount(singleDisplay?: 'field', onChange = vi.fn()) {
  render(
    <OptionSelect
      mode="single"
      options={OPTIONS}
      value="a"
      onChange={onChange}
      searchable
      optionTestIdPrefix="opt"
      {...(singleDisplay !== undefined ? { singleDisplay } : {})}
    />,
  )
  return onChange
}

describe('OptionSelect single, field display', () => {
  it('draws the current choice in the field and no removable chip', () => {
    mount('field')
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Alpha')
    expect(screen.queryByRole('button', { name: 'Remove Alpha' })).toBeNull()
  })

  it('still searches and reports a pick', () => {
    const onChange = mount('field')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bet' } })
    fireEvent.click(screen.getByTestId('opt-b'))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('keeps the chip by default', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Remove Alpha' })).toBeTruthy()
  })
})
