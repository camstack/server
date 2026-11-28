/**
 * A string field whose device declares its values (`enumValues` from the device's
 * own catalog — a fault code, a button event) is PICKED from them, in the scalar
 * row and in the "is one of" row; without `enumValues` it stays free text.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@dominevo/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@dominevo/ui-library')>('@dominevo/ui-library')
  return { ...actual, useDeviceManagerGetDevice: () => ({ data: undefined }) }
})

import { ListValueInput, ScalarValueInput, type ScalarValueInputProps } from '../ValueInput'

type WireableField = NonNullable<ScalarValueInputProps['field']>

const DECLARED: WireableField = {
  path: 'code',
  kind: 'string',
  enumValues: ['UNREACH', 'LOW_BAT'],
}
const FREE: WireableField = { path: 'code', kind: 'string' }

describe('ScalarValueInput on a string field with declared values', () => {
  it('renders a dropdown with the declared values', () => {
    const onChange = vi.fn()
    render(<ScalarValueInput value="UNREACH" field={DECLARED} onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'LOW_BAT' }))
    expect(onChange).toHaveBeenCalledWith('LOW_BAT')
  })

  it('stays a free text box when the device declares nothing', () => {
    render(<ScalarValueInput value="" field={FREE} onChange={vi.fn()} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByRole('textbox')).toBeDefined()
  })
})

describe('ListValueInput with declared values', () => {
  it('offers a multi-pick that writes the picked values, keeping the text box', () => {
    const onChange = vi.fn()
    render(<ListValueInput value={['UNREACH']} field={DECLARED} onChange={onChange} />)
    expect(screen.getByRole('textbox')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Pick values/ }))
    fireEvent.click(screen.getByText('LOW_BAT'))
    expect(onChange).toHaveBeenCalledWith(['UNREACH', 'LOW_BAT'])
  })

  it('a value outside the catalog survives a toggle', () => {
    const onChange = vi.fn()
    render(<ListValueInput value={['UNREACH', 'CUSTOM_X']} field={DECLARED} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Pick values/ }))
    fireEvent.click(screen.getByText('LOW_BAT'))
    expect(onChange).toHaveBeenCalledWith(['UNREACH', 'LOW_BAT', 'CUSTOM_X'])
  })

  it('is only the text box without declared values', () => {
    render(<ListValueInput value={[]} field={FREE} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Pick values/ })).toBeNull()
  })
})
