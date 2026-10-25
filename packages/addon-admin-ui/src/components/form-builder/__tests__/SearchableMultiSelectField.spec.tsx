/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigMultiSelectField } from '@camstack/types'

expect.extend(jestDomMatchers)

import { SearchableMultiSelectField } from '../SearchableMultiSelectField'

const field: ConfigMultiSelectField = {
  type: 'multiselect',
  key: '_linkedDeviceIds',
  label: 'Manually linked devices',
  options: [
    { value: '10', label: 'Hall Cam (Hall)' },
    { value: '11', label: 'Kitchen Doorbell (Kitchen)' },
    { value: '12', label: 'Garden PTZ (Garden)' },
  ],
}

describe('SearchableMultiSelectField', () => {
  it('renders selected values as removable chips', () => {
    const onChange = vi.fn()
    render(<SearchableMultiSelectField field={field} value={['10']} onChange={onChange} />)
    // The chip carries the option label.
    expect(screen.getByText('Hall Cam (Hall)')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove Hall Cam (Hall)'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('filters the dropdown by the typed query (name / location / id)', () => {
    render(<SearchableMultiSelectField field={field} value={[]} onChange={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'kitchen' } })
    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveTextContent('Kitchen Doorbell (Kitchen)')
    expect(listbox).not.toHaveTextContent('Hall Cam')
    expect(listbox).not.toHaveTextContent('Garden PTZ')
  })

  it('adds an option to the selection on click', () => {
    const onChange = vi.fn()
    render(<SearchableMultiSelectField field={field} value={[]} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.click(screen.getByRole('option', { name: /Garden PTZ/ }))
    expect(onChange).toHaveBeenCalledWith(['12'])
  })

  it('shows a no-matches note for an unmatched query', () => {
    render(<SearchableMultiSelectField field={field} value={[]} onChange={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByRole('listbox')).toHaveTextContent('No matches')
  })

  it('pops the last chip on Backspace with an empty query', () => {
    const onChange = vi.fn()
    render(<SearchableMultiSelectField field={field} value={['10', '11']} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['10'])
  })

  it('blocks additions past maxItems but still allows removals', () => {
    const onChange = vi.fn()
    const capped: ConfigMultiSelectField = { ...field, maxItems: 1 }
    render(<SearchableMultiSelectField field={capped} value={['10']} onChange={onChange} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    // Unselected option is disabled at the cap.
    const opt = screen.getByRole('option', { name: /Kitchen Doorbell/ })
    expect(opt).toBeDisabled()
    // Removing the selected chip still works.
    fireEvent.click(screen.getByLabelText('Remove Hall Cam (Hall)'))
    expect(onChange).toHaveBeenCalledWith([])
  })
})
