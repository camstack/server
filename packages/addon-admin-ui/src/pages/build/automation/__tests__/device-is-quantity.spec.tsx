/**
 * A state row on a quantity field (D972): the number is shown in the unit
 * the person picked, typing emits the stored base number with that unit, and a
 * field with no quantity keeps its plain number box.
 */
import type { DeviceIsLeaf } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const descriptor = vi.hoisted(() => ({
  current: { path: 'bowlFood', kind: 'number', quantity: 'mass' } as {
    path: string
    kind: string
    quantity?: string
  },
}))

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return { ...actual, FieldPicker: () => null, useFieldDescriptor: () => descriptor.current }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return { ...actual, useDeviceManagerGetDevice: () => ({ data: undefined }) }
})

import { DeviceIsFields } from '../DeviceIsFields'

const LEAF: DeviceIsLeaf = {
  kind: 'device-is',
  deviceId: 201,
  cap: 'pet-feeder',
  fieldPath: 'bowlFood',
  operator: 'lt',
  value: 0.05,
  unit: 'g',
}

beforeEach(() => {
  descriptor.current = { path: 'bowlFood', kind: 'number', quantity: 'mass' }
})

describe('DeviceIsFields on a quantity field', () => {
  it('shows the base-unit number in the unit it was picked in', () => {
    render(<DeviceIsFields leaf={LEAF} devices={[]} onChange={vi.fn()} />)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('50')
    expect((screen.getByLabelText('Value unit') as HTMLSelectElement).value).toBe('g')
  })

  it('emits the typed number as the stored base number and the picked unit', () => {
    const onChange = vi.fn()
    render(<DeviceIsFields leaf={LEAF} devices={[]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '80' } })
    expect(onChange).toHaveBeenCalledWith({ ...LEAF, value: 0.08, unit: 'g' })
  })

  it('writes a unit even for a leaf that came without one', () => {
    const onChange = vi.fn()
    const { unit: _unit, ...bare } = LEAF
    render(<DeviceIsFields leaf={{ ...bare, value: 0.2 }} devices={[]} onChange={onChange} />)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('0.2')
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '0.3' } })
    expect(onChange).toHaveBeenCalledWith({ ...bare, value: 0.3, unit: 'kg' })
  })

  it('keeps a plain number box when the field has no quantity', () => {
    descriptor.current = { path: 'hopperLevel', kind: 'number' }
    render(<DeviceIsFields leaf={{ ...LEAF, unit: undefined }} devices={[]} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Value unit')).toBeNull()
  })
})
