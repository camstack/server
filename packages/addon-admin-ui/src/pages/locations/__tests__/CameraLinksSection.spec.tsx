/**
 * Camera links: a room's cameras with the devices each is LINKED to, read from
 * the same `linked-devices` slot the Customize page edits — and the quick
 * multi-add, which writes through that slot with only what the operator picked
 * (D356): nothing pre-selected, suggestions are toggles, linked devices are
 * drawn checked and disabled.
 */
import type { System } from '@camstack/sdk'
import { SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { installDialogPolyfill } from '../../../components/device/customize/assignments/__tests__/dialog-polyfill'
import type { SiteDevice } from '../site-locations'

const SLOT_REF = 'device-manager:linked-devices'
const setSlot = vi.hoisted(() => vi.fn(async () => ({ applied: true, reload: 'none' })))

const slotsFor = (deviceId: number) => [
  {
    state: 'ok',
    slotRef: SLOT_REF,
    slot: 'linked-devices',
    authority: 'device-manager:_linkedDeviceIds',
    activation: null,
    value: { slot: 'linked-devices', deviceIds: deviceId === 101 ? [303] : [] },
    sources: deviceId === 101 ? [{ deviceId: 303, name: 'Porch light', health: 'ok' }] : [],
  },
]

const CANDIDATES = {
  candidates: [
    {
      deviceId: 301,
      name: 'Porch sensor',
      type: 'sensor',
      location: 'Front',
      parentName: null,
      suggested: true,
      reason: 'same location',
    },
    {
      deviceId: 303,
      name: 'Porch light',
      type: 'light',
      location: 'Front',
      parentName: null,
      suggested: true,
      reason: 'same location',
    },
    {
      deviceId: 304,
      name: 'Garage lamp',
      type: 'light',
      location: 'Garage',
      parentName: null,
      suggested: false,
      reason: null,
    },
  ],
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceExtensionListSlots: (input: { deviceId: number }) => ({
      status: 'success',
      data: slotsFor(input.deviceId),
      error: null,
      refetch: async () => undefined,
    }),
    useDeviceExtensionListCandidates: () => ({ status: 'success', data: CANDIDATES, error: null }),
    useDeviceExtensionSetSlot: () => ({ mutateAsync: setSlot, isPending: false }),
  }
})

const { CameraLinksSection } = await import('../CameraLinksSection')

const dev = (over: Partial<SiteDevice> & Pick<SiteDevice, 'id' | 'name'>): SiteDevice => ({
  type: 'sensor',
  online: true,
  location: 'Front',
  parentDeviceId: null,
  isCamera: false,
  role: null,
  stableId: `s-${String(over.id)}`,
  primaryChildEntityId: null,
  ...over,
})
const CAMERA = dev({ id: 101, name: 'Driveway', type: 'camera', isCamera: true })
const FLEET = [
  CAMERA,
  dev({ id: 102, name: 'Garden', type: 'camera', isCamera: true }),
  dev({ id: 303, name: 'Porch light', type: 'light' }),
]

function Where() {
  const loc = useLocation()
  return <span data-testid="where">{`${loc.pathname}${loc.search}`}</span>
}

const SYSTEM = {
  trpcClient: { deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } } },
} as unknown as System

function mount(cameras: readonly SiteDevice[] = [CAMERA, FLEET[1] as SiteDevice]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SystemProvider system={SYSTEM}>
        <MemoryRouter initialEntries={['/locations']}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <CameraLinksSection room="Front" cameras={cameras} fleet={FLEET} />
                  <Where />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </SystemProvider>
    </QueryClientProvider>,
  )
}

beforeAll(installDialogPolyfill)
beforeEach(() => setSlot.mockClear())

describe('CameraLinksSection overview', () => {
  it('lists each camera of the room with the devices it is linked to', () => {
    mount()
    const driveway = screen.getByTestId('camera-links-101')
    expect(within(driveway).getByText('Driveway')).toBeTruthy()
    expect(within(driveway).getByText('Porch light')).toBeTruthy()
    // A camera with nothing linked says so rather than drawing an empty table.
    const garden = screen.getByTestId('camera-links-102')
    expect(within(garden).getByText('No linked devices.')).toBeTruthy()
  })

  it('names an empty room instead of drawing nothing', () => {
    mount([])
    expect(screen.getByTestId('camera-links-empty')).toBeTruthy()
  })

  it("links to the camera's Customize page to edit", () => {
    mount()
    fireEvent.click(within(screen.getByTestId('camera-links-101')).getByText('Edit links'))
    expect(screen.getByTestId('where').textContent).toBe('/devices/101?tab=customize')
  })
})

describe('the quick Add', () => {
  function openPicker() {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Link devices to Driveway' }))
  }

  it('draws the already-linked device checked and disabled, and pre-selects nothing', () => {
    openPicker()
    const linked = document.querySelector<HTMLInputElement>('input[data-device-id="303"]')
    expect(linked?.checked).toBe(true)
    expect(linked?.disabled).toBe(true)
    const sensor = document.querySelector<HTMLInputElement>('input[data-device-id="301"]')
    expect(sensor?.checked).toBe(false)
    // The suggested group is offered but not ticked.
    const group = screen.getByRole('region', { name: 'Suggested · Front' })
    expect(
      within(group).getByRole('button', { name: 'Porch sensor' }).getAttribute('aria-pressed'),
    ).toBe('false')
    expect(screen.getByRole('button', { name: 'Add 0' }).hasAttribute('disabled')).toBe(true)
    expect(setSlot).not.toHaveBeenCalled()
  })

  it('writes ONLY the picked ids through the linked-devices slot, on top of what is linked', async () => {
    openPicker()
    const sensor = document.querySelector<HTMLInputElement>('input[data-device-id="301"]')
    fireEvent.click(sensor as HTMLInputElement)
    const lamp = document.querySelector<HTMLInputElement>('input[data-device-id="304"]')
    fireEvent.click(lamp as HTMLInputElement)
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }))
    await waitFor(() => expect(setSlot).toHaveBeenCalledTimes(1))
    expect(setSlot).toHaveBeenCalledWith({
      deviceId: 101,
      slotRef: SLOT_REF,
      value: { slot: 'linked-devices', deviceIds: [303, 301, 304] },
    })
  })
})
