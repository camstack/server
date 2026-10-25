/**
 * The Display section is the ADMIN half of the two-level icon design: a
 * global, per-device override the server resolves before the role default and
 * the type icon. What it must do:
 *
 *   1. render for a device with NO role — a camera, a container. It was gated
 *      on a role, which left exactly those devices with no icon knob at all;
 *   2. write the icon through `deviceManager.setDisplay` as part of ONE
 *      override object, with the label in the same write;
 *   3. clear with `null`, never with `{}`;
 *   4. offer the role-default button only where there is a role, and the
 *      label only where something draws it.
 *
 * The hooks are stubbed at the ui-library boundary; the picker, the form and
 * the i18n are real.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

interface DeviceRow {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly role: string | null
  readonly parentDeviceId: number | null
  readonly display?: {
    readonly icon?: string
    readonly label?: string
    readonly hidden?: boolean
    readonly perCap?: Readonly<Record<string, { readonly precision?: number }>>
  }
}

const deviceRow: { current: DeviceRow | undefined } = { current: undefined }
const sliceRow: { current: unknown } = { current: undefined }
const setDisplayMutate = vi.fn()
const setRoleDefaultsMutate = vi.fn()
const roleDefaults: { current: Record<string, { icon?: string }> } = { current: {} }

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    useDeviceCapSlice: () => sliceRow.current,
    useDeviceManagerGetDevice: () => ({ data: deviceRow.current }),
    useDeviceManagerSetDisplay: () => ({ mutate: setDisplayMutate, isPending: false }),
    useDeviceManagerGetRoleDisplayDefaults: () => ({ data: { defaults: roleDefaults.current } }),
    useDeviceManagerSetRoleDisplayDefaults: () => ({
      mutate: setRoleDefaultsMutate,
      isPending: false,
    }),
  }
})

import { DisplaySection } from '../DisplaySection'

function renderSection(deviceId: number): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: ReactNode): ReactNode => (
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  )
  return render(wrap(<DisplaySection deviceId={deviceId} />))
}

const CAMERA: DeviceRow = {
  id: 104,
  name: 'Camera front door',
  type: 'camera',
  role: null,
  parentDeviceId: null,
}
const CONTAINER: DeviceRow = {
  id: 4127,
  name: 'Tapparella kitchen',
  type: 'container',
  role: null,
  parentDeviceId: null,
}
const SIREN: DeviceRow = {
  id: 12,
  name: 'Sirena',
  type: 'siren',
  role: 'siren',
  parentDeviceId: 104,
}

function pickIcon(deviceName: string, key: string): void {
  fireEvent.click(screen.getByLabelText(`Change the icon of ${deviceName}`))
  // The catalog list is virtualised, so a tile is reached by searching, as an operator does.
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: key }))
}

const TEMPERATURE: DeviceRow = {
  id: 88,
  name: 'Living room',
  type: 'sensor',
  role: 'temperature-sensor',
  parentDeviceId: null,
}

beforeEach(() => {
  setDisplayMutate.mockReset()
  setRoleDefaultsMutate.mockReset()
  roleDefaults.current = {}
  sliceRow.current = undefined
})

describe('DisplaySection — for every device, not only the role-bearing ones', () => {
  it('renders for a camera with no role, and offers a DEVICE glyph', () => {
    deviceRow.current = CAMERA
    renderSection(104)
    expect(screen.getByText('Display')).toBeTruthy()
    expect(screen.getByText('Default (Camera)')).toBeTruthy()

    pickIcon('Camera front door', 'lock')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplayMutate).toHaveBeenCalledTimes(1)
    expect(setDisplayMutate).toHaveBeenCalledWith({ deviceId: 104, display: { icon: 'lock' } })
  })

  it('names the inherited answer of a container honestly — it is the primary child, not the box', () => {
    deviceRow.current = CONTAINER
    renderSection(4127)
    expect(screen.getByText("Default (the primary child's icon)")).toBeTruthy()
  })

  it('offers neither a label nor a role default for a top-level device without a role', () => {
    deviceRow.current = CAMERA
    renderSection(104)
    expect(screen.queryByLabelText('Label')).toBeNull()
    expect(screen.queryByRole('button', { name: /Set as default/ })).toBeNull()
  })
})

describe('DisplaySection — one override object', () => {
  it('the label shares the icon write', () => {
    deviceRow.current = SIREN
    renderSection(12)
    pickIcon('Sirena', 'bell')
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Allarme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplayMutate).toHaveBeenCalledWith({
      deviceId: 12,
      display: { icon: 'bell', label: 'Allarme' },
    })
  })

  it('keeps a persisted perCap refinement this form does not edit', () => {
    deviceRow.current = {
      ...SIREN,
      display: { icon: 'siren', perCap: { 'numeric-sensor': { precision: 1 } } },
    }
    renderSection(12)
    pickIcon('Sirena', 'bell')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplayMutate).toHaveBeenCalledWith({
      deviceId: 12,
      display: { icon: 'bell', perCap: { 'numeric-sensor': { precision: 1 } } },
    })
  })

  it('choosing the default back and saving an otherwise empty form writes null, not {}', () => {
    deviceRow.current = { ...CAMERA, display: { icon: 'lock' } }
    renderSection(104)
    fireEvent.click(screen.getByLabelText('Change the icon of Camera front door'))
    fireEvent.click(screen.getByRole('button', { name: 'Default (Camera)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplayMutate).toHaveBeenCalledWith({ deviceId: 104, display: null })
  })

  it('Reset writes null', () => {
    deviceRow.current = { ...CAMERA, display: { icon: 'lock', hidden: true } }
    renderSection(104)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(setDisplayMutate).toHaveBeenCalledWith({ deviceId: 104, display: null })
  })

  it('the role default is a separate write, offered only with a role', () => {
    deviceRow.current = SIREN
    renderSection(12)
    pickIcon('Sirena', 'bell')
    fireEvent.click(screen.getByRole('button', { name: /Set as default for all Siren sensors/ }))
    expect(setRoleDefaultsMutate).toHaveBeenCalledWith({ defaults: { siren: { icon: 'bell' } } })
    expect(setDisplayMutate).not.toHaveBeenCalled()
  })
})

describe('DisplaySection — the inherited answer is the second level, not the third', () => {
  it('names the operator role default as what the row draws with no override', () => {
    roleDefaults.current = { siren: { icon: 'lock' } }
    deviceRow.current = SIREN
    renderSection(12)
    expect(screen.getByText('Default (lock — the Siren role default)')).toBeTruthy()
  })

  it('falls back to the built-in role glyph when the role default names nothing drawable', () => {
    roleDefaults.current = { siren: { icon: 'nope' } }
    deviceRow.current = SIREN
    renderSection(12)
    expect(screen.getByText('Default (Siren)')).toBeTruthy()
  })
})

describe('DisplaySection — dimension-filtered display unit (display only)', () => {
  it('with live slice unit °C, options are temperature units only', () => {
    sliceRow.current = { unit: '°C', celsius: 21.5 }
    deviceRow.current = TEMPERATURE
    renderSection(88)
    const unitSelect = screen.getByLabelText('Unit')
    const values = [...unitSelect.querySelectorAll('option')].map((o) => o.value)
    expect(values).toContain('°C')
    expect(values).toContain('°F')
    expect(values).toContain('K')
    expect(values).not.toContain('hPa')
    expect(values).not.toContain('m/s')
  })

  it('picking °F calls setDisplay with normalized unit (display only)', () => {
    sliceRow.current = { unit: '°C', celsius: 21.5 }
    deviceRow.current = TEMPERATURE
    renderSection(88)
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: '°F' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setDisplayMutate).toHaveBeenCalledWith({
      deviceId: 88,
      display: { unit: '°F' },
    })
  })
})
