import { type DeviceInfo, DeviceType } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../../../i18n'
import { QuickDetailSaveProvider } from '../../quick-detail-save'
import { IdentityRow } from '../IdentityRow'

const setRole = vi.fn(async () => undefined)
const setDisplay = vi.fn(async () => undefined)
const setName = vi.fn(async () => undefined)
const setLocation = vi.fn(async () => undefined)

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerSetRole: () => ({ mutate: setRole, mutateAsync: setRole, isPending: false }),
    useDeviceManagerSetDisplay: () => ({
      mutate: setDisplay,
      mutateAsync: setDisplay,
      isPending: false,
    }),
    useDeviceManagerSetName: () => ({ mutateAsync: setName, isPending: false }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: setLocation, isPending: false }),
    useDeviceManagerListLocations: () => ({ data: ['Porch'] }),
    useDeviceManagerGetRoleDisplayDefaults: () => ({ data: { defaults: {} } }),
    useDeviceManagerSetRoleDisplayDefaults: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

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

function wrap(node: ReactNode, device: DeviceInfo = DEVICE): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmDialogProvider>
        <MemoryRouter>
          <QuickDetailSaveProvider
            deviceId={device.id}
            seed={{
              name: device.name,
              location: device.location ?? '',
              role: device.role ?? null,
              display: device.display,
            }}
          >
            {node}
          </QuickDetailSaveProvider>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('IdentityRow (spec U9)', () => {
  it('name, room, type, hidden and role — no per-field save, no explanation', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    for (const label of ['Name', 'Room', 'Type', 'Hidden', 'Role'])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Edit name' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit location' })).toBeNull()
    expect(screen.queryByText(/Nothing new is stored/)).toBeNull()
  })

  it('the role waits for Save; none is null', () => {
    const withRole = { ...DEVICE, id: 585, role: 'doorbell' }
    render(wrap(<IdentityRow device={withRole} />, withRole))
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: '' } })
    expect(setRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setRole).toHaveBeenCalledWith({ deviceId: 585, role: null })
  })

  it('a provider-owned role is shown, not edited', () => {
    render(wrap(<IdentityRow device={{ ...DEVICE, linkDeviceId: 12 }} />))
    expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull()
  })

  it('hidden waits for Save and writes the one display override', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide from device lists' }))
    expect(setDisplay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledWith({ deviceId: 103, display: { hidden: true } })
  })

  it('a blank name is refused and nothing is written', () => {
    render(wrap(<IdentityRow device={DEVICE} />))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Name is required')).toBeTruthy()
    expect(setName).not.toHaveBeenCalled()
  })

  it('the name field speaks the locale and has no pencil save', async () => {
    await i18n.changeLanguage('it')
    try {
      render(wrap(<IdentityRow device={DEVICE} />))
      expect(screen.getByRole('textbox', { name: 'Nome' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Modifica nome' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Modifica posizione' })).toBeNull()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
