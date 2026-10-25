import { type DeviceInfo, DeviceType } from '@camstack/types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../../../i18n'

const setRole = vi.fn()
const setDisplay = vi.fn()
const setLocation = vi.hoisted(() => vi.fn(async (_input: object) => undefined))
const setName = vi.hoisted(() => vi.fn(async (_input: object) => undefined))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerSetRole: () => ({ mutate: setRole, isPending: false }),
    useDeviceManagerSetDisplay: () => ({ mutate: setDisplay, isPending: false }),
    useDeviceManagerSetName: () => ({
      mutateAsync: setName,
      isPending: false,
    }),
    useDeviceManagerSetLocation: () => ({
      mutateAsync: setLocation,
      isPending: false,
    }),
    useDeviceManagerListLocations: () => ({ data: ['Porch'] }),
  }
})
const { IdentityRow } = await import('../IdentityRow')

const DEVICE: DeviceInfo = {
  id: 103,
  name: 'Camera porch',
  addonId: 'provider-reolink',
  stableId: 'r-103',
  type: DeviceType.Camera,
  location: 'Porch',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
  display: undefined,
}
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
)

describe('IdentityRow (spec U9)', () => {
  it('name, room, hidden and role — no Type row, no explanation', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    for (const label of ['Name', 'Room', 'Hidden', 'Role'])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.queryByText('Type')).toBeNull()
    expect(screen.queryByText(/Nothing new is stored/)).toBeNull()
  })
  it('the role writes setRole; none is null', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    // A change event fires only when the value differs: start from a stored role.
    render(wrap(<IdentityRow device={{ ...DEVICE, id: 585, role: 'doorbell' }} />))
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Role' })[1] as HTMLElement, {
      target: { value: '' },
    })
    expect(setRole).toHaveBeenCalledWith({ deviceId: 585, role: null }, expect.anything())
  })
  it('a provider-owned role is shown, not edited (roleIsProviderOwned)', () => {
    render(wrap(<IdentityRow device={{ ...DEVICE, linkDeviceId: 12 }} />))
    expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull()
  })
  it('hidden writes the ONE display override', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(setDisplay).toHaveBeenCalledWith(
      { deviceId: 103, display: { hidden: true } },
      expect.anything(),
    )
  })
  it('a refused role write is said by name, and a later success clears it (D391)', () => {
    render(wrap(<IdentityRow device={{ ...DEVICE, role: 'doorbell' }} />))
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '' } })
    const options = setRole.mock.calls.at(-1)?.[1]
    act(() => options?.onError?.(new Error('role refused by its owner')))
    expect(screen.getByRole('alert').textContent).toBe('role refused by its owner')
    act(() => options?.onSuccess?.())
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('a refused hidden write is said by name', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('checkbox'))
    const options = setDisplay.mock.calls.at(-1)?.[1]
    act(() => options?.onError?.(new Error('display refused')))
    expect(screen.getByRole('alert').textContent).toBe('display refused')
  })
  it('a refused name write is said by name and keeps the editor open', async () => {
    setName.mockRejectedValueOnce(new Error('name refused by the provider'))
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Porch 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('name refused by the provider'),
    )
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
  it('a later successful name save clears the refusal (R1)', async () => {
    setName.mockRejectedValueOnce(new Error('name refused'))
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Porch 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
  it('cancelling the edit clears the refusal (R1)', async () => {
    setName.mockRejectedValueOnce(new Error('name refused'))
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Porch 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('the save and cancel controls speak the locale (R2)', async () => {
    await i18n.changeLanguage('it')
    try {
      render(wrap(<IdentityRow device={DEVICE} />))
      expect(screen.getByRole('button', { name: 'Modifica posizione' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Modifica nome' }))
      expect(screen.getByRole('button', { name: 'Salva' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Annulla' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
  it('a refused room save is said, then cleared by a later save and by cancel (R1)', async () => {
    setLocation.mockRejectedValueOnce(new Error('room refused'))
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('button', { name: 'Edit location' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cortile' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('room refused')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    setLocation.mockRejectedValueOnce(new Error('room refused again'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit location' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Orto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('the edit-name control is translated, not hard-coded English (F6)', async () => {
    await i18n.changeLanguage('it')
    try {
      render(wrap(<IdentityRow device={DEVICE} />))
      expect(screen.getByRole('button', { name: 'Modifica nome' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Edit name' })).toBeNull()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
