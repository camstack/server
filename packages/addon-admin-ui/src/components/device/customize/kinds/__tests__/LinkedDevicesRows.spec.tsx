import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { CustomizeDraftProvider } from '../../customize-draft'

const CAMERA = {
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
}
const SLOT = {
  state: 'ok',
  slotRef: 'device-manager:linked-devices',
  slot: 'linked-devices',
  updatedAt: 500,
  authority: 'device-manager:_linkedDeviceIds',
  activation: null,
  value: { slot: 'linked-devices', deviceIds: [701, 702], trackedDeviceIds: [702] },
  sources: [
    { deviceId: 701, name: 'Luce porch', health: 'ok' },
    { deviceId: 702, name: 'Sirena esterna', health: 'ok' },
  ],
  impliedSources: [{ deviceId: 710, name: 'Spotlight 1', health: 'ok' }],
}
const CANDIDATE = {
  deviceId: 703,
  ref: { addonId: 'provider-zigbee', stableId: 'z:gate' },
  name: 'Cancello',
  detail: 'Zigbee · Garden',
  meta: 'switch',
  caps: [],
  value: null,
}

interface SlotsAnswer {
  readonly status: string
  readonly data?: readonly unknown[]
  readonly error?: { readonly message: string }
}
const slots = vi.hoisted((): { current: SlotsAnswer } => ({
  current: { status: 'success', data: [] },
}))
const candidatesAnswer = vi.hoisted((): { current: readonly unknown[] } => ({ current: [] }))
/** What the (mocked) picker was handed — the card's candidates, as the picker would see them. */
const offeredToPicker = vi.hoisted((): { current: unknown } => ({ current: null }))
const setSlot = vi.fn(async (_input: unknown) => ({ applied: true, reload: 'none' }))
const confirmAnswer = vi.hoisted((): { current: boolean } => ({ current: true }))
vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => async () => confirmAnswer.current,
    useDeviceExtensionListSlots: () => ({
      ...slots.current,
      refetch: vi.fn(async () => undefined),
    }),
    useDeviceExtensionListCandidates: () => ({
      status: 'success',
      data: { candidates: candidatesAnswer.current },
    }),
    useDeviceExtensionSetSlot: () => ({ mutateAsync: setSlot, isPending: false }),
  }
})
vi.mock('../../assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      {
        id: 701,
        name: 'Luce porch',
        addonId: 'ha',
        stableId: 'light.porch',
        type: 'light',
        location: 'Porch',
        isCamera: false,
        integration: 'Home Assistant',
      },
      {
        id: 702,
        name: 'Sirena esterna',
        addonId: 'z',
        stableId: 'z:siren',
        type: 'siren',
        location: 'Garden',
        isCamera: false,
        integration: 'Zigbee',
      },
      {
        id: 703,
        name: 'Cancello',
        addonId: 'provider-zigbee',
        stableId: 'z:gate',
        type: 'switch',
        location: 'Garden',
        isCamera: false,
        integration: 'Zigbee',
      },
      {
        id: 710,
        name: 'Spotlight 1',
        addonId: 'provider-reolink',
        stableId: 'r-103-spot1',
        type: 'light',
        location: 'Porch',
        isCamera: false,
        integration: 'Reolink',
      },
    ],
  }),
}))
vi.mock('../../source-selector/SourceSelectorDevicesDialog', () => ({
  SourceSelectorDevicesDialog: (p: {
    open: boolean
    candidates: unknown
    onConfirm: (c: readonly unknown[]) => void
  }) => {
    offeredToPicker.current = p.candidates
    return p.open ? (
      <button type="button" onClick={() => p.onConfirm([CANDIDATE])}>
        pick-gate
      </button>
    ) : null
  },
}))
const {
  hostsLinkedDevices,
  LinkedDeviceButtons,
  LinkedDeviceItem,
  LinkedDeviceSource,
  LinkedDeviceValue,
  useLinkedDevices,
} = await import('../LinkedDevicesRows')

/** The rows as the Customize table lays them out: one cell each, plus the picker its "+ Add" opens. */
function Harness({ device }: { readonly device: typeof CAMERA }): ReactNode {
  const state = useLinkedDevices(device)
  return (
    <div>
      {state.lines.map((line, i) => (
        <div key={`${line.kind}-${String(i)}`} data-testid="line">
          <LinkedDeviceItem line={line} />
          <LinkedDeviceValue line={line} />
          <LinkedDeviceSource line={line} state={state} />
          <LinkedDeviceButtons line={line} state={state} />
        </div>
      ))}
      {state.canAdd && (
        <button type="button" onClick={state.openPicker}>
          + Link
        </button>
      )}
      {state.dialog}
    </div>
  )
}

function wrap(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <CustomizeDraftProvider order={['linked-devices']}>{node}</CustomizeDraftProvider>
    </QueryClientProvider>
  )
}

/** The tab's one Save: nothing is written until it is pressed. */
async function pressSave(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Save$/i }))
}

beforeEach(() => {
  confirmAnswer.current = true
  slots.current = { status: 'success', data: [SLOT] }
  setSlot.mockClear()
  offeredToPicker.current = null
  candidatesAnswer.current = [
    {
      deviceId: 703,
      name: 'Cancello',
      type: 'switch',
      location: 'Garden',
      parentName: null,
      suggested: true,
      reason: 'same location',
    },
  ]
})

describe('Linked devices rows (spec U7)', () => {
  it('only an extension host lists them (a container is never a pick)', () => {
    expect(hostsLinkedDevices(DeviceType.Camera)).toBe(true)
    expect(hostsLinkedDevices(DeviceType.Container)).toBe(false)
  })
  it('a device whose slot is absent lists nothing', () => {
    slots.current = { status: 'success', data: [] }
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.queryAllByTestId('line')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Link/ })).toBeNull()
  })
  it('an unreachable owner is said with its reason — never "no links" (D315)', () => {
    slots.current = {
      status: 'success',
      data: [{ state: 'unreachable', addonId: 'device-manager', reason: 'timeout' }],
    }
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.getByRole('alert').textContent).toMatch(/timeout/)
  })
  it('rows: device, type, timeline switch; implied rows have no ✕', () => {
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.getByText('Linked devices')).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Remove Luce porch' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Spotlight 1' })).toBeNull()
  })
  it('"Controls with the camera" is read-only and SAID in visible text, not only a header tooltip (task 8 L4)', () => {
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.getByText("Every linked device's controls show with the camera")).toBeTruthy()
  })
  it('the timeline switch writes trackedDeviceIds through setSlot', async () => {
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Luce porch on this camera's timeline" }),
    )
    // An edit is a draft: nothing is written until Save, which sends the stamp it read.
    expect(setSlot).not.toHaveBeenCalled()
    await pressSave()
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 103,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [701, 702], trackedDeviceIds: [702, 701] },
        expectedUpdatedAt: 500,
      }),
    )
  })
  it('✕ unlinks after a confirm and + Link appends the picks: two edits, ONE write on Save', async () => {
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sirena esterna' }))
    await waitFor(() => expect(screen.queryByText('Sirena esterna')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Link/ }))
    fireEvent.click(screen.getByRole('button', { name: 'pick-gate' }))
    expect(setSlot).not.toHaveBeenCalled()
    await pressSave()
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(1))
    expect(setSlot).toHaveBeenCalledWith({
      deviceId: 103,
      slotRef: 'device-manager:linked-devices',
      value: { slot: 'linked-devices', deviceIds: [701, 703], trackedDeviceIds: [] },
      expectedUpdatedAt: 500,
    })
  })
  it('Discard restores the stored list without a write', async () => {
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sirena esterna' }))
    await waitFor(() => expect(screen.queryByText('Sirena esterna')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }))
    expect(screen.getByText('Sirena esterna')).toBeTruthy()
    expect(setSlot).not.toHaveBeenCalled()
  })
  it('two consecutive Saves chain the stamp the refetch returned', async () => {
    const { rerender } = render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Luce porch on this camera's timeline" }),
    )
    await pressSave()
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(1))
    // The write's refetch lands with the new stamp.
    slots.current = { status: 'success', data: [{ ...SLOT, updatedAt: 777 }] }
    rerender(wrap(<Harness device={CAMERA} />))
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Luce porch on this camera's timeline" }),
    )
    await pressSave()
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(2))
    expect(setSlot.mock.calls[0]?.[0]).toMatchObject({ expectedUpdatedAt: 500 })
    expect(setSlot.mock.calls[1]?.[0]).toMatchObject({ expectedUpdatedAt: 777 })
  })
  // The picker is mocked here: the real guarantee is that `AssignmentCandidate` has no field for
  // the owner's `suggested` / `reason`, and `linkedCandidates` drops both (model spec).
  it('no "Suggested" text is rendered (spec U11)', () => {
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(screen.getByRole('button', { name: /Link/ }))
    expect(screen.queryByText(/Suggested|same location/)).toBeNull()
  })
  it('a pending slot read says Checking — never an empty table (D315)', () => {
    slots.current = { status: 'pending' }
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.getByRole('status').textContent).toMatch(/Checking/)
    expect(screen.queryByRole('button', { name: /Link/ })).toBeNull()
  })
  it('a declined confirm unlinks nothing', async () => {
    confirmAnswer.current = false
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sirena esterna' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(setSlot).not.toHaveBeenCalled()
  })
  it("the owner's refusal is shown by name (D391)", async () => {
    setSlot.mockRejectedValueOnce(new Error('linked-devices: device 701 is a container'))
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Luce porch on this camera's timeline" }),
    )
    await pressSave()
    expect((await screen.findByRole('alert')).textContent).toMatch(/is a container/)
    // A refused save keeps the draft and the bar.
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeTruthy()
  })
  it('an owner that reports no opt-in list gets no timeline switch — never a write it cannot keep (review M1)', () => {
    slots.current = {
      status: 'success',
      data: [{ ...SLOT, value: { slot: 'linked-devices', deviceIds: [701, 702] } }],
    }
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.queryByRole('switch')).toBeNull()
  })
  it('a stored opt-in whose device is no longer linked is shown and can be untracked (review M2)', async () => {
    slots.current = {
      status: 'success',
      data: [
        {
          ...SLOT,
          value: { slot: 'linked-devices', deviceIds: [701, 702], trackedDeviceIds: [702, 703] },
        },
      ],
    }
    render(wrap(<Harness device={CAMERA} />))
    expect(screen.getByText('Cancello')).toBeTruthy()
    expect(screen.getByText(/no longer linked/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Cancello' })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: "Show Cancello on this camera's timeline" }))
    await pressSave()
    await waitFor(() =>
      expect(setSlot).toHaveBeenCalledWith({
        deviceId: 103,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [701, 702], trackedDeviceIds: [702] },
        expectedUpdatedAt: 500,
      }),
    )
  })
  it('one write at a time: while it is in flight every control is disabled (review M3)', async () => {
    let release = (): void => undefined
    setSlot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ applied: true, reload: 'none' })
        }),
    )
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Luce porch on this camera's timeline" }),
    )
    await pressSave()
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(1))
    expect(
      screen
        .getByRole('switch', { name: "Show Sirena esterna on this camera's timeline" })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Remove Luce porch' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.queryByRole('button', { name: /Link/ })).toBeNull()
    fireEvent.click(
      screen.getByRole('switch', { name: "Show Sirena esterna on this camera's timeline" }),
    )
    expect(setSlot).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.getByRole('button', { name: /Link/ })).toBeTruthy())
  })
  it('an implied device is never offered as a pick (review M4)', async () => {
    candidatesAnswer.current = [
      {
        deviceId: 710,
        name: 'Spotlight 1',
        type: 'light',
        location: 'Porch',
        parentName: null,
        suggested: false,
        reason: null,
      },
      {
        deviceId: 703,
        name: 'Cancello',
        type: 'switch',
        location: 'Garden',
        parentName: null,
        suggested: false,
        reason: null,
      },
    ]
    render(wrap(<Harness device={CAMERA} />))
    fireEvent.click(screen.getByRole('button', { name: /Link/ }))
    await waitFor(() => expect(offeredToPicker.current).toMatchObject({ kind: 'known' }))
    const offered = offeredToPicker.current
    const ids =
      typeof offered === 'object' &&
      offered !== null &&
      'value' in offered &&
      Array.isArray(offered.value)
        ? offered.value.map((c: { deviceId: number }) => c.deviceId)
        : null
    expect(ids).toEqual([703])
  })
})
