/**
 * "Group by" on the admin device picker — Zone (default) / Location / None —
 * mounted over a stubbed `deviceManager.listSiteZones` and the real
 * `localStorage`.
 *
 * What only a mount can say: the control is on the DEVICE picker and not on
 * the node picker; the zones are read only once the list is open; switching
 * modes regroups; the choice persists; and a zone read that FAILED groups by
 * location and says so — never "No zone" from a read that did not answer
 * (D315).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickerDevice } from '../device-picker-model'

/** What the stubbed hub answers `listSiteZones` with. */
const zonesAnswer = vi.fn<() => Promise<unknown>>()

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: { deviceManager: { listSiteZones: { query: () => zonesAnswer() } } },
  }),
}))

import { DevicePicker } from '../DevicePicker'
import { DEVICE_PICKER_GROUP_STORAGE_KEY } from '../device-picker-grouping'

const HOUSE: readonly PickerDevice[] = [
  { id: 1, name: 'Bedroom cam', type: 'camera', location: 'Camera Carol' },
  { id: 2, name: 'Kitchen cam', type: 'camera', location: 'Kitchen' },
  { id: 4, name: 'Cantina cam', type: 'camera', location: 'Cantina' },
  { id: 5, name: 'Garden cam', type: 'camera', location: null },
]

const ZONES = [
  { zoneKey: 'night zone', label: 'Night zone', icon: null, locationKeys: ['camera carol'] },
  { zoneKey: 'zona giorno', label: 'Zona giorno', icon: null, locationKeys: ['kitchen'] },
]

function withQueries(ui: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function mountDevices(): void {
  render(
    withQueries(
      <DevicePicker
        devices={HOUSE}
        listState="answered"
        value={[]}
        onChange={vi.fn()}
        noun="device"
      />,
    ),
  )
}

async function openPanel(): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /add devices|edit/i }))
  })
  return screen.getByTestId('device-picker-panel')
}

function headers(panel: HTMLElement): readonly string[] {
  return within(panel)
    .queryAllByTestId('device-picker-group')
    .map((header) => header.textContent ?? '')
}

async function pick(panel: HTMLElement, mode: 'Zone' | 'Location' | 'None'): Promise<void> {
  await act(async () => {
    fireEvent.click(within(panel).getByRole('radio', { name: mode }))
  })
}

beforeEach(() => {
  localStorage.clear()
  zonesAnswer.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('DevicePicker — Group by', () => {
  it('reads the zones only once open, and groups by ZONE by default', async () => {
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    expect(zonesAnswer).not.toHaveBeenCalled()
    const panel = await openPanel()
    expect(within(panel).getByRole('radiogroup', { name: 'Group by' })).toBeTruthy()
    await within(panel).findByText('Night zone')
    expect(zonesAnswer).toHaveBeenCalledTimes(1)
    const shown = headers(panel)
    expect(shown).toHaveLength(4)
    expect(shown[0]).toContain('Night zone')
    expect(shown[1]).toContain('Zona giorno')
    expect(shown[2]).toContain('No zone')
    expect(shown[3]).toContain('No location')
  })

  it('Location regroups by room; None is one list with no headers', async () => {
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    const panel = await openPanel()
    await within(panel).findByText('Night zone')
    await pick(panel, 'Location')
    const rooms = headers(panel)
    expect(rooms).toHaveLength(4)
    expect(rooms[0]).toContain('Camera Carol')
    expect(rooms[3]).toContain('No location')
    await pick(panel, 'None')
    expect(headers(panel)).toHaveLength(0)
    expect(within(panel).queryAllByTestId('device-picker-row')).toHaveLength(4)
  })

  it("the row's second line carries the device TYPE, which left the group key", async () => {
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    const panel = await openPanel()
    await within(panel).findByText('Night zone')
    expect(within(panel).getByText('Camera Carol · Camera')).toBeTruthy()
  })

  it('the choice persists across a remount', async () => {
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    await pick(await openPanel(), 'Location')
    expect(localStorage.getItem(DEVICE_PICKER_GROUP_STORAGE_KEY)).toBe('location')
    cleanup()
    mountDevices()
    const panel = await openPanel()
    expect(
      within(panel).getByRole('radio', { name: 'Location' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(headers(panel)[0]).toContain('Camera Carol')
  })

  it.each([
    'location',
    'none',
  ] as const)('opened in %s mode, zones are read for the Zone filter but never group (D697)', async (mode) => {
    localStorage.setItem(DEVICE_PICKER_GROUP_STORAGE_KEY, mode)
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    const panel = await openPanel()
    await act(async () => {
      await Promise.resolve()
    })
    expect(within(panel).queryAllByTestId('device-picker-row')).toHaveLength(4)
    expect(zonesAnswer).toHaveBeenCalledTimes(1)
    expect(
      within(panel)
        .queryAllByTestId('device-picker-group')
        .map((h) => h.textContent),
    ).not.toContainEqual(expect.stringContaining('Zona'))
  })

  it('an unreadable stored value is the default, Zone', async () => {
    localStorage.setItem(DEVICE_PICKER_GROUP_STORAGE_KEY, 'by-colour')
    zonesAnswer.mockResolvedValue(ZONES)
    mountDevices()
    const panel = await openPanel()
    expect(within(panel).getByRole('radio', { name: 'Zone' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('a FAILED zone read groups by location and says so — never "No zone"', async () => {
    zonesAnswer.mockRejectedValue(new Error('NOT_FOUND'))
    mountDevices()
    const panel = await openPanel()
    expect(await within(panel).findByText('Zones unavailable — grouped by location')).toBeTruthy()
    expect(within(panel).queryByText(/No zone/)).toBeNull()
    expect(headers(panel)[0]).toContain('Camera Carol')
  })

  it('a PENDING zone read groups by location and says it is loading', async () => {
    zonesAnswer.mockReturnValue(new Promise<never>(() => undefined))
    mountDevices()
    const panel = await openPanel()
    expect(within(panel).getByText('Loading zones — grouped by location for now')).toBeTruthy()
    expect(within(panel).queryByText(/No zone/)).toBeNull()
  })
})

describe('DevicePicker<string> — no Group by', () => {
  it('the node picker has no "Group by" control and reads no zones', async () => {
    render(
      withQueries(
        <DevicePicker<string>
          noun="node"
          devices={[{ id: 'hub', name: 'Hub', type: 'hub', location: 'online' }]}
          listState="answered"
          value={[]}
          onChange={vi.fn()}
        />,
      ),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add nodes/i }))
    })
    expect(screen.queryByRole('radiogroup', { name: 'Group by' })).toBeNull()
    expect(zonesAnswer).not.toHaveBeenCalled()
  })
})
