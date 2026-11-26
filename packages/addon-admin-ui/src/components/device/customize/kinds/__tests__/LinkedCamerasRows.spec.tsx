import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
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
  sources: deviceIds.map((deviceId) => ({ deviceId, name: `#${deviceId}`, health: 'ok' })),
})

interface QueryAnswer {
  readonly status: string
  readonly isFetching?: boolean
  readonly data?: unknown
  readonly error?: { readonly message: string }
}
/** The one batch read: which cameras link which devices. */
const batch = vi.hoisted((): { current: QueryAnswer } => ({ current: { status: 'pending' } }))
/** The fresh slot read of an add or a remove, by camera id; a missing id fails. */
const freshSlots = vi.hoisted((): { current: Record<number, unknown> } => ({ current: {} }))
const setSlot = vi.fn(async (_input: unknown) => ({ applied: true, reload: 'none' }))
const refetch = vi.fn(async () => undefined)
const invalidate = vi.fn(async (_input: unknown) => undefined)
const fetchSlots = vi.fn(async (input: { deviceId: number }) => {
  const rows = freshSlots.current[input.deviceId]
  if (rows === undefined) throw new Error('owner timed out')
  return rows
})
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    trpc: {
      useUtils: () => ({ deviceExtension: { listSlots: { fetch: fetchSlots, invalidate } } }),
    },
    useDeviceExtensionSetSlot: () => ({ mutateAsync: setSlot, isPending: false }),
    useDeviceManagerGetLinkedDevicesBatch: () => ({ ...batch.current, refetch }),
  }
})
vi.mock('../../use-confirm-remove', () => ({ useConfirmRemove: () => async () => true }))
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
/** The shared picker, reduced to what it is handed and what it confirms. */
vi.mock('../../source-selector/SourceSelectorDevicesDialog', () => ({
  SourceSelectorDevicesDialog: (props: {
    open: boolean
    candidates: {
      kind: string
      value?: readonly { deviceId: number; name: string }[]
    }
    onConfirm: (picked: readonly unknown[]) => void
  }) =>
    props.open && props.candidates.kind === 'known' ? (
      <div role="dialog">
        {(props.candidates.value ?? []).map((c) => (
          <button key={c.deviceId} onClick={() => props.onConfirm([c])}>
            {`pick ${c.name}`}
          </button>
        ))}
      </div>
    ) : null,
}))
const { LinkedCameraButtons, LinkedCameraItem, LinkedCameraValue, useLinkedCameras } = await import(
  '../LinkedCamerasRows'
)
const { CustomizeDraftProvider } = await import('../../customize-draft')

/** The rows as the Customize table lays them out: one cell each, plus the picker its "+ Add" opens. */
function Harness({ device }: { readonly device: typeof GATE }): ReactNode {
  const state = useLinkedCameras(device)
  return (
    <div>
      {state.lines.map((line, i) => (
        <div key={`${line.kind}-${String(i)}`} data-testid="line">
          <LinkedCameraItem line={line} />
          <LinkedCameraValue line={line} />
          <LinkedCameraButtons line={line} state={state} />
        </div>
      ))}
      {state.canAdd && <button onClick={state.openPicker}>open picker</button>}
      {state.dialog}
    </div>
  )
}

function wrap(node: ReactNode): ReactNode {
  return (
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <CustomizeDraftProvider order={['linked-cameras']}>{node}</CustomizeDraftProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const batchOf = (links: Readonly<Record<number, readonly number[]>>): QueryAnswer => ({
  status: 'success',
  data: [103, 104, 105].map((deviceId) => ({
    deviceId,
    mode: 'manual',
    devices: (links[deviceId] ?? []).map((id) => ({
      deviceId: id,
      name: `#${id}`,
      location: null,
      features: [],
    })),
  })),
})

beforeEach(() => {
  setSlot.mockClear()
  fetchSlots.mockClear()
  invalidate.mockClear()
  // Only the porch camera links the gate.
  batch.current = batchOf({ 103: [701, 703], 104: [705] })
  freshSlots.current = {
    103: [slotOf([701, 702, 703], [702])],
    104: [slotOf([705])],
    105: [slotOf([], [])],
  }
})

describe('Linked cameras rows on a device a camera can link', () => {
  it('lists only the cameras that link this device, with a link to each', () => {
    render(wrap(<Harness device={GATE} />))
    expect(screen.getByText('Camera porch').closest('a')?.getAttribute('href')).toBe('/devices/103')
    expect(screen.queryByText('Camera garden')).toBeNull()
    expect(screen.queryByText('Camera shed')).toBeNull()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  it('a batch that has not answered is shown as checking, never as an empty list (D315)', () => {
    batch.current = { status: 'pending' }
    render(wrap(<Harness device={GATE} />))
    expect(screen.getByRole('status').textContent).toMatch(/Checking/)
    expect(screen.queryByText('Camera porch')).toBeNull()
  })

  it('a batch that failed says why, never an empty list (D315)', () => {
    batch.current = { status: 'error', error: { message: 'owner timed out' } }
    render(wrap(<Harness device={GATE} />))
    expect(screen.getByRole('alert').textContent).toMatch(/owner timed out/)
    expect(screen.queryByText('Camera porch')).toBeNull()
  })

  it('a batch that answered with no camera linking shows nothing upfront, only the picker', () => {
    batch.current = batchOf({})
    render(wrap(<Harness device={GATE} />))
    expect(screen.queryAllByTestId('line')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'open picker' })).toBeTruthy()
  })

  it('the picker offers the host cameras not yet linked, and nothing else', () => {
    render(wrap(<Harness device={GATE} />))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    expect(screen.getByRole('button', { name: 'pick Camera garden' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'pick Camera shed' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'pick Camera porch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'pick Luce porch' })).toBeNull()
  })

  it('adding is a draft line: nothing is written until Save, then the camera slot is read fresh and written with its stamp', async () => {
    freshSlots.current[104] = [{ ...slotOf([705]), updatedAt: 41 }]
    render(wrap(<Harness device={GATE} />))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick Camera garden' }))
    expect(screen.getByText('Camera garden')).toBeTruthy()
    expect(setSlot).not.toHaveBeenCalled()
    expect(fetchSlots).not.toHaveBeenCalledWith({ deviceId: 104 }, { staleTime: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 104,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [705, 703] },
        expectedUpdatedAt: 41,
      }),
    )
    expect(fetchSlots).toHaveBeenCalledWith({ deviceId: 104 }, { staleTime: 0 })
  })

  it('Discard drops a pending add and a pending remove without a write', async () => {
    render(wrap(<Harness device={GATE} />))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick Camera garden' }))
    const remove = await screen.findByRole('button', { name: 'Remove Camera porch' })
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false))
    fireEvent.click(remove)
    await waitFor(() => expect(screen.queryByText('Camera porch')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await screen.findByText('Camera porch')
    expect(screen.queryByText('Camera garden')).toBeNull()
    expect(setSlot).not.toHaveBeenCalled()
  })

  it('a camera whose slot cannot be read at Save is not written, says so, and stays in the draft', async () => {
    freshSlots.current = { 103: [slotOf([701, 703])] }
    render(wrap(<Harness device={GATE} />))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick Camera shed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/owner timed out/)).toBeTruthy()
    expect(setSlot).not.toHaveBeenCalled()
    expect(screen.getByText('Camera shed')).toBeTruthy()
  })

  it('removing is a draft edit: Save drops only this device from the camera slot, keeping its other ids and tracked opt-in', async () => {
    render(wrap(<Harness device={GATE} />))
    const remove = await screen.findByRole('button', { name: 'Remove Camera porch' })
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false))
    fireEvent.click(remove)
    await waitFor(() => expect(screen.queryByText('Camera porch')).toBeNull())
    expect(setSlot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 103,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [701, 702], trackedDeviceIds: [702] },
      }),
    )
  })

  it('Save writes from a slot read AT Save: a link another operator added meanwhile survives', async () => {
    render(wrap(<Harness device={GATE} />))
    const remove = await screen.findByRole('button', { name: 'Remove Camera porch' })
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false))
    fireEvent.click(remove)
    await waitFor(() => expect(screen.queryByText('Camera porch')).toBeNull())
    // Another operator links 801 to the camera while the draft is open.
    freshSlots.current[103] = [slotOf([701, 702, 703, 801], [702])]
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 103,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [701, 702, 801], trackedDeviceIds: [702] },
      }),
    )
    expect(invalidate).toHaveBeenCalledWith({ deviceId: 103 })
  })

  it('two cameras in one Save: the one that landed leaves the draft, the refused one stays', async () => {
    freshSlots.current = { 104: [slotOf([705])] }
    render(wrap(<Harness device={GATE} />))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick Camera garden' }))
    fireEvent.click(screen.getByRole('button', { name: 'open picker' }))
    fireEvent.click(screen.getByRole('button', { name: 'pick Camera shed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Camera shed: owner timed out/)).toBeTruthy()
  })

  it('a camera whose slot cannot be read cannot be removed from', async () => {
    freshSlots.current = {}
    render(wrap(<Harness device={GATE} />))
    const remove = await screen.findByRole('button', { name: 'Remove Camera porch' })
    await screen.findByText(/owner timed out/)
    expect(remove.hasAttribute('disabled')).toBe(true)
    fireEvent.click(remove)
    expect(setSlot).not.toHaveBeenCalled()
  })

  it("the cameras' slots are read in ONE query for the table, not one per row", async () => {
    batch.current = batchOf({ 103: [703], 104: [703] })
    freshSlots.current = { 103: [slotOf([703])], 104: [slotOf([703])] }
    render(wrap(<Harness device={GATE} />))
    await screen.findAllByRole('button', { name: /^Remove Camera/ })
    expect(fetchSlots).toHaveBeenCalledTimes(2)
  })
})
