// @vitest-environment jsdom
/**
 * D648 / D315 — the Extensions section claims absence only from an answer.
 *
 *  - pending → progress, never "no extensions";
 *  - a FAILED `listSlots` → an alert with the reason, never "no extensions";
 *  - answered with nothing → "no extensions", in those words;
 *  - an owner that could not answer → its own row, reason verbatim, beside
 *    the cards that did answer — and a device whose only owner failed is NOT
 *    told it has no extensions;
 *  - an association card lists every saved source with its health, reports a
 *    gate owned by another authority, adds a suggestion only when clicked,
 *    and saves through `setSlot` with the slot's own discriminant.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EXTENSION_SLOTS, type ExtensionSlotRow } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface SlotsQuery {
  status: 'pending' | 'error' | 'success'
  data?: readonly ExtensionSlotRow[]
  error?: { message: string } | null
  refetch: () => Promise<void>
}

const refetch = vi.fn(async () => undefined)
let slotsQuery: SlotsQuery = { status: 'pending', refetch }
const mutateAsync = vi.fn(async () => ({ applied: true, reload: 'none' }))

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceExtensionListSlots: () => slotsQuery,
  useDeviceExtensionListCandidates: () => ({
    status: 'success',
    data: {
      candidates: [
        {
          deviceId: 701,
          name: 'Porch contact',
          type: 'sensor',
          location: 'Porch',
          parentName: null,
          suggested: true,
          reason: 'same location',
        },
        {
          deviceId: 702,
          name: 'Kitchen flood',
          type: 'sensor',
          location: 'Kitchen',
          parentName: null,
          suggested: false,
          reason: null,
        },
      ],
    },
  }),
  useDeviceExtensionSetSlot: () => ({ mutateAsync, isPending: false }),
}))

const { ExtensionsPanel } = await import('../ExtensionsPanel.js')

const LINKED: ExtensionSlotRow = {
  state: 'ok',
  slotRef: 'device-manager:linked-devices',
  slot: 'linked-devices',
  authority: 'device-manager:_linkedDeviceIds',
  activation: null,
  value: { slot: 'linked-devices', deviceIds: [703, 999] },
  sources: [
    { deviceId: 703, name: 'Garage switch', health: 'ok' },
    { deviceId: 999, name: null, health: 'missing', detail: 'No device has this id any more' },
  ],
}

/** A second, FAKE owner's row whose sources act only behind a gate it does not own (D648.6). */
const GATED: ExtensionSlotRow = {
  state: 'ok',
  slotRef: 'other-owner:linked-devices',
  slot: 'linked-devices',
  authority: 'other-owner:store',
  activation: { state: 'inactive', authority: 'device-manager:setWrapperActive' },
  value: { slot: 'linked-devices', deviceIds: [] },
  sources: [],
}

/** A `linked-devices` row from a D655 owner: it carries the tracked-event opt-in. */
const LINKED_TRACKED: ExtensionSlotRow = {
  ...LINKED,
  value: { slot: 'linked-devices', deviceIds: [703, 999], trackedDeviceIds: [703, 4131] },
}

/** A camera with a tree child and a legacy container pick (D356). */
const LINKED_WITH_CHILD: ExtensionSlotRow = {
  ...LINKED,
  value: { slot: 'linked-devices', deviceIds: [703, 5], trackedDeviceIds: [] },
  sources: [
    { deviceId: 703, name: 'Garage switch', health: 'ok' },
    {
      deviceId: 5,
      name: 'Lock container',
      health: 'unavailable',
      detail: 'A container is never a pick',
    },
  ],
  impliedSources: [{ deviceId: 800, name: 'Camera PIR', health: 'ok' }],
}

beforeEach(() => {
  slotsQuery = { status: 'pending', refetch }
  mutateAsync.mockClear()
  refetch.mockClear()
})

describe('ExtensionsPanel — what it may claim (D315)', () => {
  it('pending renders progress, never absence', () => {
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.getByRole('status').textContent ?? '').toMatch(/loading/i)
    expect(screen.queryByText(/no extensions/i)).toBeNull()
  })

  it('a failed read is an alert with the reason — not "no extensions"', () => {
    slotsQuery = { ...slotsQuery, status: 'error', error: { message: 'hub unreachable' } }
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/hub unreachable/)
    expect(screen.queryByText(/no extensions/i)).toBeNull()
  })

  it('an answered empty list says so, in those words', () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [] }
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.getByRole('status').textContent ?? '').toMatch(/no extensions/i)
  })

  it('an unreachable owner is its own row, reason verbatim, beside the cards', () => {
    slotsQuery = {
      ...slotsQuery,
      status: 'success',
      data: [
        { state: 'unreachable', addonId: 'other-owner', reason: 'settings store unavailable' },
        LINKED,
      ],
    }
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.getByRole('group', { name: 'Linked devices' })).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent ?? '').toMatch(/other-owner/)
    expect(alert.textContent ?? '').toMatch(/settings store unavailable/)
    expect(screen.queryByText(/no extensions/i)).toBeNull()
  })

  it('a device whose ONLY owner failed is not told it has no extensions', () => {
    slotsQuery = {
      ...slotsQuery,
      status: 'success',
      data: [{ state: 'unreachable', addonId: 'device-manager', reason: 'boom' }],
    }
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.queryByText(/no extensions/i)).toBeNull()
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/boom/)
  })
})

describe('AssociationSlotCard', () => {
  it('lists every saved source with its health — a missing one is shown', () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} />)
    expect(screen.getByText('Garage switch')).toBeTruthy()
    expect(screen.getByText('Device 999')).toBeTruthy()
    expect(screen.getByText('Missing')).toBeTruthy()
  })

  it('the panel’s `readOnly` prop drops the Edit affordance, and keeps the saved picks (L4, D676)', () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} readOnly />)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByText('Garage switch')).toBeTruthy()
  })

  it('reports a gate owned by another authority, read-only', () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [GATED] }
    render(<ExtensionsPanel deviceId={101} />)
    const card = screen.getByRole('group', { name: 'Linked devices' })
    expect(card.textContent ?? '').toMatch(/Inactive/)
    expect(card.textContent ?? '').toMatch(/device-manager:setWrapperActive/)
  })

  it('a suggestion is added only when clicked, and Save sends the slot’s own value', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // Suggested, not picked: Save has nothing to send yet.
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Add Porch contact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({
      deviceId: 101,
      slotRef: 'device-manager:linked-devices',
      value: { slot: 'linked-devices', deviceIds: [703, 999, 701] },
    })
  })

  it('a successful save re-reads the panel’s own slots', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Porch contact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  })

  it('a refused save re-reads nothing', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('refused'))
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Porch contact' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(refetch).not.toHaveBeenCalled()
  })

  it('an owner refusal is shown by name and the editor stays open', async () => {
    mutateAsync.mockRejectedValueOnce(
      new Error('linked-devices on 101: refused — 5 is a container'),
    )
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Garage switch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/5 is a container/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})

describe('AssociationSlotCard — the tracked-event opt-in (D655)', () => {
  it('shows which picked devices produce tracked events', () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED_TRACKED] }
    render(<ExtensionsPanel deviceId={101} />)
    const card = screen.getByRole('group', { name: 'Linked devices' })
    expect(card.textContent ?? '').toMatch(/Tracked events/)
  })

  it('toggling an opt-in enables Save and sends the WHOLE opt-in with the picks', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED_TRACKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    const garage = screen.getByRole('checkbox', { name: 'Tracked events from Garage switch' })
    expect(garage).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracked events from Device 999' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    // 4131 is stored but no longer linked: it is shown, so it is sent — the
    // owner accepts what it already stored.
    expect(mutateAsync).toHaveBeenCalledWith({
      deviceId: 101,
      slotRef: 'device-manager:linked-devices',
      value: {
        slot: 'linked-devices',
        deviceIds: [703, 999],
        trackedDeviceIds: [703, 4131, 999],
      },
    })
  })

  it('a stored opt-in that is linked no more is visible and can be removed', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED_TRACKED] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const stale = screen.getByRole('checkbox', { name: 'Tracked events from Device 4131' })
    expect(stale).toHaveProperty('checked', true)
    expect(stale.parentElement?.textContent ?? '').toMatch(/not linked any more/)
    fireEvent.click(stale)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { slot: 'linked-devices', deviceIds: [703, 999], trackedDeviceIds: [703] },
      }),
    )
  })

  it('a tree child is shown as always linked, and can be opted in (old-section parity)', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED_WITH_CHILD] }
    render(<ExtensionsPanel deviceId={101} />)
    const always = screen.getByRole('list', { name: 'Always linked' })
    expect(always.textContent ?? '').toMatch(/Camera PIR/)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // Not removable as a pick: there is no chip for it.
    expect(screen.queryByRole('button', { name: 'Remove Camera PIR' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracked events from Camera PIR' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { slot: 'linked-devices', deviceIds: [703, 5], trackedDeviceIds: [800] },
      }),
    )
  })

  it('a picked container gets no toggle of its own (D356); un-picking drops the pick’s opt-in', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED_WITH_CHILD] }
    render(<ExtensionsPanel deviceId={101} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(
      screen.queryByRole('checkbox', { name: 'Tracked events from Lock container' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracked events from Garage switch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Garage switch' }))
    expect(screen.queryByRole('checkbox', { name: 'Tracked events from Garage switch' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { slot: 'linked-devices', deviceIds: [5], trackedDeviceIds: [] },
      }),
    )
  })

  it('a row that carries no opt-in offers no toggle and sends none', async () => {
    slotsQuery = { ...slotsQuery, status: 'success', data: [LINKED, GATED] }
    render(<ExtensionsPanel deviceId={101} />)
    for (const edit of screen.getAllByRole('button', { name: 'Edit' })) fireEvent.click(edit)
    expect(screen.queryAllByRole('checkbox')).toEqual([])
  })
})

describe('ExtensionsPanel — slots filter (D676)', () => {
  beforeEach(() => {
    slotsQuery = { status: 'success', data: [LINKED], refetch }
  })

  it('renders only the named slots', () => {
    // A row of a slot the filter does not name. The table declares one slot,
    // so the row is built at an untyped boundary (JSON.parse); only the filter
    // keeps it off the page.
    const other: ExtensionSlotRow = JSON.parse(
      JSON.stringify({ ...LINKED, slotRef: 'other-owner:other-slot', slot: 'other-slot' }),
    )
    slotsQuery = { status: 'success', data: [LINKED, other], refetch }
    render(<ExtensionsPanel deviceId={104} slots={['linked-devices']} title="Links" />)
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      EXTENSION_SLOTS['linked-devices'].descriptor.label,
    ])
    // Not rendered in any form — neither as a card nor as an unknown-slot row.
    expect(screen.queryByText('other-slot')).toBeNull()
    expect(screen.getByText('Links')).toBeTruthy()
  })

  it('a row of a slot this build does not declare is said by name, never crashes the panel (R1, D315)', () => {
    // An older server can still answer a slot this admin UI no longer declares
    // (a rollback after slice 6 answers `doorbell-source`). Built at an untyped
    // boundary: the typed union cannot spell it.
    const stale: ExtensionSlotRow = JSON.parse(
      JSON.stringify({
        ...LINKED,
        slotRef: 'virtual-owner:retired-slot',
        slot: 'retired-slot',
      }),
    )
    slotsQuery = { status: 'success', data: [LINKED, stale], refetch }
    render(<ExtensionsPanel deviceId={104} />)
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      EXTENSION_SLOTS['linked-devices'].descriptor.label,
    ])
    const alert = screen.getByRole('alert')
    expect(alert.textContent ?? '').toMatch(/Unknown slot/)
    expect(alert.textContent ?? '').toMatch(/retired-slot/)
    expect(alert.textContent ?? '').toMatch(/virtual-owner:retired-slot/)
    expect(alert.textContent ?? '').toMatch(/admin UI and the server disagree/)
    expect(screen.queryByText(/no extensions/i)).toBeNull()
  })

  it('an empty filter renders no slot', () => {
    render(<ExtensionsPanel deviceId={104} slots={[]} title="Links" />)
    expect(screen.queryAllByRole('group')).toEqual([])
  })

  it('without the prop renders every slot, as the host widget always has', () => {
    render(<ExtensionsPanel deviceId={104} />)
    expect(
      screen.getByRole('group', { name: EXTENSION_SLOTS['linked-devices'].descriptor.label }),
    ).toBeTruthy()
    expect(screen.getByText('Extensions')).toBeTruthy()
  })

  it('an unreachable owner is still shown when filtering', () => {
    slotsQuery = {
      status: 'success',
      data: [LINKED, { state: 'unreachable', addonId: 'other-owner', reason: 'runner restarting' }],
      refetch,
    }
    render(<ExtensionsPanel deviceId={104} slots={['linked-devices']} />)
    expect(screen.getByText('runner restarting')).toBeTruthy()
  })

  it('a filter that leaves nothing, with every owner answered, says so in a sentence', () => {
    slotsQuery = { status: 'success', data: [LINKED], refetch }
    render(<ExtensionsPanel deviceId={104} slots={[]} />)
    expect(screen.getByText('None of these extensions is offered on this device.')).toBeTruthy()
    expect(screen.queryAllByRole('group')).toEqual([])
  })

  it('a filter that leaves nothing beside an unreachable owner claims no absence', () => {
    slotsQuery = {
      status: 'success',
      data: [LINKED, { state: 'unreachable', addonId: 'other-owner', reason: 'runner restarting' }],
      refetch,
    }
    render(<ExtensionsPanel deviceId={104} slots={[]} />)
    expect(screen.getByText('runner restarting')).toBeTruthy()
    expect(screen.queryByText(/None of these extensions/)).toBeNull()
  })
})
