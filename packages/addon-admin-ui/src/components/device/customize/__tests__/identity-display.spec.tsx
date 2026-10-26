/**
 * Display values live in Customize's identity block and write through the
 * page's one Save — the same footer the quick-detail modal uses. There is
 * no Display section Save and no per-field save.
 */
import { type DeviceInfo, DeviceType } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import { QuickDetailSaveProvider } from '../../quick-detail-save'
import { IdentityRow } from '../IdentityRow'

const setDisplay = vi.fn(async () => undefined)
const setRoleDefaults = vi.fn()
const roleDefaults: {
  current: Record<string, { icon?: string; unit?: string; precision?: number }> | null
} = { current: {} }

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceManagerSetDisplay: () => ({
      mutate: setDisplay,
      mutateAsync: setDisplay,
      isPending: false,
    }),
    useDeviceManagerSetName: () => ({
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    useDeviceManagerSetLocation: () => ({
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    useDeviceManagerSetRole: () => ({
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    useDeviceManagerListLocations: () => ({ data: [] }),
    useDeviceManagerGetRoleDisplayDefaults: () => ({
      data: roleDefaults.current === null ? {} : { defaults: roleDefaults.current },
    }),
    useDeviceManagerSetRoleDisplayDefaults: () => ({
      mutate: setRoleDefaults,
      isPending: false,
    }),
  }
})

function device(
  partial: Pick<DeviceInfo, 'id' | 'name' | 'type'> & Partial<DeviceInfo>,
): DeviceInfo {
  return {
    stableId: `s-${String(partial.id)}`,
    addonId: 'provider-reolink',
    location: null,
    disabled: false,
    parentDeviceId: null,
    role: null,
    online: true,
    features: [],
    isCamera: partial.type === 'camera',
    config: {},
    ...partial,
  }
}

const CAMERA = device({ id: 104, name: 'Camera front door', type: DeviceType.Camera })
const CONTAINER = device({ id: 4127, name: 'Tapparella kitchen', type: DeviceType.Container })
const SIREN = device({
  id: 12,
  name: 'Sirena',
  type: DeviceType.Siren,
  role: 'siren',
  parentDeviceId: 104,
})
const TEMPERATURE = device({
  id: 88,
  name: 'Living room',
  type: DeviceType.Sensor,
  role: 'temperature-sensor',
})

function renderRow(row: DeviceInfo): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: ReactNode): ReactNode => (
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>
        <MemoryRouter>
          <QuickDetailSaveProvider
            deviceId={row.id}
            seed={{
              name: row.name,
              location: row.location ?? '',
              role: row.role ?? null,
              display: row.display,
            }}
          >
            {node}
          </QuickDetailSaveProvider>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>
  )
  return render(wrap(<IdentityRow device={row} />))
}

function pickIcon(deviceName: string, key: string): void {
  fireEvent.click(screen.getByLabelText(`Change the icon of ${deviceName}`))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: key }))
}

beforeEach(() => {
  setDisplay.mockReset()
  setRoleDefaults.mockReset()
  roleDefaults.current = {}
})

describe('identity display — one Save, every device', () => {
  it('a camera with no role offers an icon, and Save writes that one override', () => {
    renderRow(CAMERA)
    expect(screen.queryByRole('heading', { name: 'Display' })).toBeNull()
    expect(screen.getByText('Default (Camera)')).toBeTruthy()
    pickIcon('Camera front door', 'lock')
    expect(setDisplay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledTimes(1)
    expect(setDisplay).toHaveBeenCalledWith({ deviceId: 104, display: { icon: 'lock' } })
  })

  it('names a container’s inherited icon as the primary child’s', () => {
    renderRow(CONTAINER)
    expect(screen.getByText("Default (the primary child's icon)")).toBeTruthy()
  })

  it('offers neither a label nor a role default for a top-level device without a role', () => {
    renderRow(CAMERA)
    expect(screen.queryByLabelText('Label')).toBeNull()
    expect(screen.queryByRole('button', { name: /Set as default/ })).toBeNull()
  })

  it('the label shares the icon write', () => {
    renderRow(SIREN)
    pickIcon('Sirena', 'bell')
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Allarme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledWith({
      deviceId: 12,
      display: { icon: 'bell', label: 'Allarme' },
    })
  })

  it('keeps a persisted perCap refinement this form does not edit', () => {
    renderRow({
      ...SIREN,
      display: { icon: 'siren', perCap: { 'numeric-sensor': { precision: 1 } } },
    })
    pickIcon('Sirena', 'bell')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledWith({
      deviceId: 12,
      display: { icon: 'bell', perCap: { 'numeric-sensor': { precision: 1 } } },
    })
  })

  it('clearing the icon and saving an otherwise empty form writes null', () => {
    renderRow({ ...CAMERA, display: { icon: 'lock' } })
    fireEvent.click(screen.getByLabelText('Change the icon of Camera front door'))
    fireEvent.click(screen.getByRole('button', { name: 'Default (Camera)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledWith({ deviceId: 104, display: null })
  })

  it('the role default is a separate write and does not save the device', () => {
    renderRow(SIREN)
    pickIcon('Sirena', 'bell')
    fireEvent.click(screen.getByRole('button', { name: /Set as default for all Siren sensors/ }))
    expect(setRoleDefaults).toHaveBeenCalledWith({ defaults: { siren: { icon: 'bell' } } })
    expect(setDisplay).not.toHaveBeenCalled()
  })

  it('names the operator role default as what the row draws with no override', () => {
    roleDefaults.current = { siren: { icon: 'lock' } }
    renderRow(SIREN)
    expect(screen.getByText('Default (lock — the Siren role default)')).toBeTruthy()
  })

  it('falls back to the built-in role glyph when the role default names nothing drawable', () => {
    roleDefaults.current = { siren: { icon: 'nope' } }
    renderRow(SIREN)
    expect(screen.getByText('Default (Siren)')).toBeTruthy()
  })

  it('a role still draws when the defaults answer has no map', () => {
    roleDefaults.current = null
    renderRow(TEMPERATURE)
    expect(screen.getByLabelText('Unit')).toBeTruthy()
  })

  it('a temperature sensor offers only temperature units, and Save writes the unit', () => {
    renderRow(TEMPERATURE)
    const unitSelect = screen.getByLabelText('Unit')
    const values = [...unitSelect.querySelectorAll('option')].map((o) => o.value)
    expect(values).toContain('°C')
    expect(values).toContain('°F')
    expect(values).toContain('K')
    expect(values).not.toContain('hPa')
    expect(values).not.toContain('m/s')
    fireEvent.change(unitSelect, { target: { value: '°F' } })
    expect(setDisplay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplay).toHaveBeenCalledWith({ deviceId: 88, display: { unit: '°F' } })
  })
})
