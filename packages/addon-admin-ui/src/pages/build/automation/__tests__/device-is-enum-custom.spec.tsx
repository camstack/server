/**
 * A "device is" value on an enum field is PICKED from the field's own values,
 * with "Custom value…" as the way out: a stored value the enum does not list
 * still renders, and saves unchanged.
 */
import type { DeviceIsLeaf } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return {
    ...actual,
    FieldPicker: () => null,
    useFieldDescriptor: () => ({ path: 'mode', kind: 'enum', enumValues: ['auto', 'manual'] }),
  }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return { ...actual, useDeviceManagerGetDevice: () => ({ data: undefined }) }
})

import { DeviceIsFields } from '../DeviceIsFields'

const LEAF: DeviceIsLeaf = {
  kind: 'device-is',
  deviceId: 4,
  cap: 'thermostat',
  fieldPath: 'mode',
  operator: 'eq',
  value: 'auto',
}

describe('DeviceIsFields on an enum field', () => {
  it('shows the picked value from the enum and no custom box', () => {
    render(<DeviceIsFields leaf={LEAF} devices={[]} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Custom value')).toBeNull()
  })

  it('a stored value outside the enum renders as custom text and is not rewritten', () => {
    const onChange = vi.fn()
    render(
      <DeviceIsFields leaf={{ ...LEAF, value: 'legacy-mode' }} devices={[]} onChange={onChange} />,
    )
    expect((screen.getByLabelText('Custom value') as HTMLInputElement).value).toBe('legacy-mode')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('typing in the custom box writes the typed value', () => {
    const onChange = vi.fn()
    render(
      <DeviceIsFields leaf={{ ...LEAF, value: 'legacy-mode' }} devices={[]} onChange={onChange} />,
    )
    fireEvent.change(screen.getByLabelText('Custom value'), { target: { value: 'other' } })
    expect(onChange).toHaveBeenCalledWith({ ...LEAF, value: 'other' })
  })
})
