/**
 * The quick multi-add dialog and the room card's "Add" that opens it. A room's
 * members are drawn checked and disabled, unassigned devices are suggested but
 * never ticked, and Confirm hands back exactly the picked ids.
 */
import type { System } from '@camstack/sdk'
import { type PickerItem, SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { installDialogPolyfill } from '../../../components/device/customize/assignments/__tests__/dialog-polyfill'
import { LocationCard } from '../LocationCard'
import { QuickAddDevicesDialog } from '../QuickAddDevicesDialog'

const SYSTEM = {
  trpcClient: { deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } } },
} as unknown as System

const ITEMS: readonly PickerItem<number>[] = [
  { id: 1, name: 'Counter', type: 'camera', location: 'Kitchen' },
  { id: 2, name: 'Spare sensor', type: 'sensor', location: null },
  { id: 3, name: 'Hall lamp', type: 'light', location: 'Hall' },
]

function box(id: number): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[data-device-id="${String(id)}"]`)
  if (el === null) throw new Error(`no checkbox ${String(id)}`)
  return el
}

function mount(onConfirm = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SystemProvider system={SYSTEM}>
        <QuickAddDevicesDialog
          open
          title="Add devices to Kitchen"
          items={ITEMS}
          listState="answered"
          lockedIds={[1]}
          lockedNote="Already in this room"
          suggestions={{ heading: 'Not in a room yet', ids: [2] }}
          onConfirm={onConfirm}
          onClose={vi.fn()}
        />
      </SystemProvider>
    </QueryClientProvider>,
  )
  return onConfirm
}

beforeAll(installDialogPolyfill)

describe('QuickAddDevicesDialog', () => {
  it('shows members checked and disabled; suggestions are offered but nothing is pre-selected', () => {
    mount()
    expect(box(1).checked).toBe(true)
    expect(box(1).disabled).toBe(true)
    expect(box(2).checked).toBe(false)
    expect(box(3).checked).toBe(false)
    const group = screen.getByRole('region', { name: 'Not in a room yet' })
    expect(
      within(group).getByRole('button', { name: 'Spare sensor' }).getAttribute('aria-pressed'),
    ).toBe('false')
    expect(screen.getByRole('button', { name: 'Add 0' }).hasAttribute('disabled')).toBe(true)
  })

  it('confirms exactly the picked ids — a suggestion toggle and a list pick share one selection', () => {
    const onConfirm = mount()
    const group = screen.getByRole('region', { name: 'Not in a room yet' })
    fireEvent.click(within(group).getByRole('button', { name: 'Spare sensor' }))
    fireEvent.click(box(3))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }))
    expect(onConfirm).toHaveBeenCalledWith([2, 3])
  })
})

describe('LocationCard Add', () => {
  it('opens the multi-add through onAddDevices', () => {
    const onAddDevices = vi.fn()
    render(
      <MemoryRouter>
        <LocationCard
          name="Kitchen"
          members={[]}
          devices={[]}
          busy={false}
          icon={null}
          description={null}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          onRebuildLinks={vi.fn()}
          onAddDevices={onAddDevices}
          onPickIcon={vi.fn()}
          onSaveDescription={vi.fn()}
          zones={[]}
          zoneKey={null}
          onChangeZone={vi.fn()}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add devices to Kitchen' }))
    expect(onAddDevices).toHaveBeenCalledTimes(1)
  })
})
