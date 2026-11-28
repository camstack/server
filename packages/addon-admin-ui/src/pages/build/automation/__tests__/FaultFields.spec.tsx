/**
 * The fault row's code picker: the device's catalog is offered, a saved code
 * the catalog does not list survives, and a catalog that could not be read says
 * so and leaves the code to be typed (D315).
 */
import type { DeviceFaultRaisedLeaf } from '@dominevo/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const catalog = vi.hoisted(() => ({
  current: {
    options: [] as { value: string; label: string; hint?: string }[],
    loading: false,
    failed: false,
  },
}))

vi.mock('../../../system/useFaultTypeOptions', () => ({
  useFaultTypeOptions: () => catalog.current,
}))

vi.mock('@dominevo/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@dominevo/ui-library')>('@dominevo/ui-library')
  return { ...actual, DeviceValuePicker: () => null }
})

import { FaultFields } from '../FaultFields'

const LEAF: DeviceFaultRaisedLeaf = {
  kind: 'device-fault-raised',
  deviceId: 9,
  codes: ['unreachable'],
}

beforeEach(() => {
  catalog.current = {
    options: [
      { value: 'unreachable', label: 'Gateway unreachable', hint: 'error' },
      { value: 'auth-failed', label: 'Gateway login refused', hint: 'error' },
    ],
    loading: false,
    failed: false,
  }
})

describe('FaultFields', () => {
  it('offers the catalog by label and adds the picked code to the leaf', () => {
    const onChange = vi.fn()
    render(<FaultFields leaf={{ ...LEAF, codes: [] }} onChange={onChange} />)
    expect(screen.getByText('Gateway login refused')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Gateway login refused/))
    expect(onChange).toHaveBeenCalledWith({ ...LEAF, codes: ['auth-failed'] })
  })

  it('keeps a saved code the catalog does not list, visible and removable', () => {
    const onChange = vi.fn()
    render(<FaultFields leaf={{ ...LEAF, codes: ['vendor-specific-9'] }} onChange={onChange} />)
    expect(screen.getByText(/vendor-specific-9/)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a failed catalog read says so and is not "no options"', () => {
    catalog.current = { options: [], loading: false, failed: true }
    render(<FaultFields leaf={LEAF} onChange={vi.fn()} />)
    expect(screen.getByTestId('fault-catalog-failed').textContent).toContain('could not be read')
    expect(screen.getByPlaceholderText(/Fault code/)).toBeTruthy()
  })

  it('an answered-empty catalog offers the free entry without a warning', () => {
    catalog.current = { options: [], loading: false, failed: false }
    render(<FaultFields leaf={{ ...LEAF, codes: [] }} onChange={vi.fn()} />)
    expect(screen.queryByTestId('fault-catalog-failed')).toBeNull()
    expect(screen.getByPlaceholderText(/Fault code/)).toBeTruthy()
  })
})
