import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

/** The device whose Customize tab is open: a gate switch that a camera may link. */
const GATE = {
  id: 703,
  name: 'Cancello',
  addonId: 'provider-zigbee',
  stableId: 'z:gate',
  type: DeviceType.Switch,
  location: 'Garden',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}

const slotOf = (deviceIds: readonly number[], trackedDeviceIds?: readonly number[]) => ({
  state: 'ok',
  slotRef: 'device-manager:linked-devices',
  slot: 'linked-devices',
  authority: 'device-manager:_linkedDeviceIds',
  activation: null,
  value: {
    slot: 'linked-devices',
    deviceIds,
    ...(trackedDeviceIds === undefined ? {} : { trackedDeviceIds }),
  },
  sources: deviceIds.map((deviceId) => ({
    deviceId,
    name: `#${deviceId}`,
    health: 'ok',
  })),
})

interface SlotsAnswer {
  readonly status: string
  readonly data?: readonly unknown[]
  readonly error?: { readonly message: string }
}
/** Each camera's own slot read, by camera id. */
const slotsByCamera = vi.hoisted((): { current: Record<number, SlotsAnswer> } => ({ current: {} }))
const setSlot = vi.fn(async (_input: unknown) => ({
  applied: true,
  reload: 'none',
}))
const refetch = vi.fn(async () => undefined)
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceExtensionListSlots: (input: { deviceId: number }) => ({
      ...(slotsByCamera.current[input.deviceId] ?? { status: 'pending' }),
      refetch,
    }),
    useDeviceExtensionListCandidates: () => ({ status: 'pending' }),
    useDeviceExtensionSetSlot: () => ({
      mutateAsync: setSlot,
      isPending: false,
    }),
  }
})
const fleetRow = (id: number, name: string, type: string, location: string, isCamera: boolean) => ({
  id,
  name,
  addonId: 'a',
  stableId: `s-${id}`,
  type,
  location,
  isCamera,
  integration: 'Reolink',
})
vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      fleetRow(103, 'Camera porch', 'camera', 'Porch', true),
      fleetRow(104, 'Camera garden', 'camera', 'Garden', true),
      fleetRow(105, 'Camera shed', 'camera', 'Shed', true),
      fleetRow(701, 'Luce porch', 'light', 'Porch', false),
      fleetRow(703, 'Cancello', 'switch', 'Garden', false),
    ],
  }),
}))
const { LinkedDevicesTable } = await import('../LinkedDevicesTable')

function wrap(node: ReactNode): ReactNode {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

beforeEach(() => {
  setSlot.mockClear()
  slotsByCamera.current = {
    103: { status: 'success', data: [slotOf([701, 702], [702])] },
    104: { status: 'success', data: [slotOf([703, 705])] },
    105: { status: 'error', error: { message: 'owner timed out' } },
  }
})

describe('LinkedDevicesTable on a device a camera can link (reverse direction)', () => {
  it('lists only the cameras', () => {
    render(wrap(<LinkedDevicesTable device={GATE} />))
    expect(screen.getByText('Camera porch')).toBeTruthy()
    expect(screen.getByText('Camera garden')).toBeTruthy()
    expect(screen.queryByText('Luce porch')).toBeNull()
  })
  it('a tick is read from the camera slot: linked on 104, not on 103', () => {
    render(wrap(<LinkedDevicesTable device={GATE} />))
    const on = screen.getByRole('switch', { name: 'Linked to Camera garden' })
    const off = screen.getByRole('switch', { name: 'Linked to Camera porch' })
    expect(on.getAttribute('aria-checked')).toBe('true')
    expect(off.getAttribute('aria-checked')).toBe('false')
  })
  it('ticking writes THIS device into the camera slot, keeping its other ids and its tracked opt-in', async () => {
    render(wrap(<LinkedDevicesTable device={GATE} />))
    fireEvent.click(screen.getByRole('switch', { name: 'Linked to Camera porch' }))
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 103,
        slotRef: 'device-manager:linked-devices',
        value: {
          slot: 'linked-devices',
          deviceIds: [701, 702, 703],
          trackedDeviceIds: [702],
        },
      }),
    )
  })
  it('unticking removes only this device from the camera slot', async () => {
    render(wrap(<LinkedDevicesTable device={GATE} />))
    fireEvent.click(screen.getByRole('switch', { name: 'Linked to Camera garden' }))
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 104,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [705] },
      }),
    )
  })
  it('a camera whose slot read failed is disabled with the reason, never shown as unlinked (D315, D49)', () => {
    render(wrap(<LinkedDevicesTable device={GATE} />))
    const broken = screen.getByRole('switch', {
      name: 'Linked to Camera shed',
    })
    expect(broken.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/owner timed out/)).toBeTruthy()
    fireEvent.click(broken)
    expect(setSlot).not.toHaveBeenCalled()
  })
  it('a camera whose slot has not answered yet is disabled, not unlinked', () => {
    slotsByCamera.current = {
      ...slotsByCamera.current,
      105: { status: 'pending' },
    }
    render(wrap(<LinkedDevicesTable device={GATE} />))
    expect(
      screen.getByRole('switch', { name: 'Linked to Camera shed' }).hasAttribute('disabled'),
    ).toBe(true)
  })
  it('a container is never a pick, so it has no table', () => {
    const { container } = render(
      wrap(<LinkedDevicesTable device={{ ...GATE, type: DeviceType.Container }} />),
    )
    expect(container.textContent).toBe('')
  })
})
