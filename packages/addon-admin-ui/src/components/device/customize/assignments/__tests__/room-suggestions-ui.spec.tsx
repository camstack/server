/**
 * The suggestions as the operator meets them (D749): a "N suggested · <room>"
 * entry on the card header, and a "Suggested · <room>" group at the top of
 * every Customize picker whose one-click add is the picker's own pick.
 * Rendering never assigns anything (D356).
 */
import type { System } from '@camstack/sdk'
import { SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import type { AssignmentCandidate } from '../assignment-candidates'
import type { RoomSuggestions } from '../room-suggestions'
import { installDialogPolyfill } from './dialog-polyfill'

const FEEDER = {
  id: 4127,
  name: 'Mangiatoia PetKit',
  addonId: 'provider-homeassistant',
  stableId: 'ha:feeder',
  type: 'pet-feeder',
  location: 'Hall',
  role: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}
const OTHER = {
  ...FEEDER,
  id: 4200,
  name: 'Bilancia kitchen',
  stableId: 'ha:scale',
  location: 'Kitchen',
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceManagerListAll: () => ({ status: 'success', data: [FEEDER, OTHER] }),
    useDeviceManagerGetWireableFields: () => ({
      status: 'success',
      data: { caps: [{ cap: 'numeric-sensor', fields: [{ path: 'value', kind: 'number' }] }] },
    }),
    useDeviceStateGetSnapshot: () => ({
      status: 'success',
      data: { 'numeric-sensor': { value: 18 } },
    }),
  }
})
const { AssignmentSection } = await import('../AssignmentSection')
const { CustomizeDevicePickerDialog } = await import('../CustomizeDevicePickerDialog')
beforeAll(installDialogPolyfill)

function wrap(node: ReactNode): ReactElement {
  const system = {
    trpcClient: { deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } } },
  } as unknown as System
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SystemProvider system={system}>{node}</SystemProvider>
    </QueryClientProvider>
  )
}

const candidate = (deviceId: number, name: string, detail: string): AssignmentCandidate => ({
  deviceId,
  ref: { addonId: 'provider-homeassistant', stableId: `ha:${deviceId}` },
  name,
  detail,
  meta: 'motion',
  caps: ['motion'],
  value: null,
})
const PIR = candidate(1, 'PIR hall', 'Home Assistant · Hall')
const CONTACT = candidate(11, 'Contatto porta', 'Home Assistant · Hall')
const KITCHEN = candidate(4, 'PIR kitchen', 'Home Assistant · Kitchen')
const ROOM: RoomSuggestions = {
  location: 'Hall',
  ids: new Set([1, 11, 4127]),
  containers: new Map([[11, 'Porta hall']]),
}

describe('the card header entry', () => {
  it('says how many devices the room suggests, and opens the picker', () => {
    const onOpen = vi.fn()
    render(
      <AssignmentSection
        id="motion"
        title="Motion"
        addLabel="+ Add"
        onAdd={vi.fn()}
        suggestion={{ count: 2, location: 'Hall', onOpen }}
      >
        {null}
      </AssignmentSection>,
    )
    fireEvent.click(screen.getByRole('button', { name: /2 suggested · Hall/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is not drawn when nothing can be added', () => {
    render(
      <AssignmentSection
        id="motion"
        title="Motion"
        suggestion={{ count: 2, location: 'Hall', onOpen: vi.fn() }}
      >
        {null}
      </AssignmentSection>,
    )
    expect(screen.queryByRole('button', { name: /suggested/ })).toBeNull()
  })
})

describe('the device picker', () => {
  function open(onConfirm = vi.fn(), room: RoomSuggestions | null = ROOM) {
    render(
      wrap(
        <CustomizeDevicePickerDialog
          open
          title="Add a motion sensor"
          selection="multi"
          candidates={{ kind: 'known', value: [PIR, CONTACT, KITCHEN] }}
          room={room}
          confirmLabel={(n) => `Add ${n}`}
          onConfirm={onConfirm}
          onClose={vi.fn()}
        />,
      ),
    )
    return onConfirm
  }

  it('groups the room first, names a child after its container, and assigns nothing on its own', () => {
    const onConfirm = open()
    const group = screen.getByRole('region', { name: 'Suggested · Hall' })
    expect(within(group).getByText('PIR hall')).toBeTruthy()
    expect(within(group).getByText(/in Porta hall/)).toBeTruthy()
    expect(within(group).queryByText('PIR kitchen')).toBeNull()
    // The rest of the list does not repeat a suggestion.
    expect(screen.queryByRole('checkbox', { name: /PIR hall/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /PIR kitchen/ })).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('one click adds a suggestion through the same confirm as a pick', () => {
    const onConfirm = open()
    fireEvent.click(screen.getByRole('button', { name: 'Add PIR hall' }))
    expect(onConfirm).toHaveBeenCalledWith([PIR])
  })

  it('adds every suggestion at once when several can be added', () => {
    const onConfirm = open()
    fireEvent.click(screen.getByRole('button', { name: /Add all/ }))
    expect(onConfirm).toHaveBeenCalledWith([PIR, CONTACT])
  })

  it('without a room the picker is unchanged', () => {
    open(vi.fn(), null)
    expect(screen.queryByRole('region', { name: /Suggested/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /PIR hall/ })).toBeTruthy()
  })
})
