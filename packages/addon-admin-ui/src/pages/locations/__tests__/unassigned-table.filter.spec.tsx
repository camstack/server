/**
 * The unassigned table's OWN filter, and the one number it must not touch.
 *
 * The table narrows itself — search + type chips — and the page has no filter
 * above it. Two promises:
 *   1. the filter acts on what is drawn: rows, select-all, the bulk bar;
 *   2. "accessories in tow" is read from the WHOLE fleet, whatever the filter
 *      hides. The server cascade does not know about the search box, and a
 *      count read off the filtered slice would understate what a tap moves.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { topLevelUnassigned, type SiteDevice } from '../site-locations'
import { UnassignedTable } from '../UnassignedTable'

function device(
  id: number,
  name: string,
  location: string | null,
  extra?: Partial<SiteDevice>,
): SiteDevice {
  return {
    id,
    name,
    location,
    type: extra?.type ?? 'camera',
    isCamera: extra?.isCamera ?? true,
    parentDeviceId: extra?.parentDeviceId ?? null,
    online: extra?.online ?? true,
    role: extra?.role ?? null,
    ...extra,
  }
}

const cam = device(1, 'Camera Hall', null)
// Its accessories are named after the room, NOT after the camera: a search
// for the camera's name hides them from `rows` and from every filtered view.
const siren = device(2, 'Sirena', null, { isCamera: false, type: 'siren', parentDeviceId: 1 })
const sirenSwitch = device(3, 'Sirena switch', null, {
  isCamera: false,
  type: 'switch',
  parentDeviceId: 2,
})
const lock = device(5, 'Serratura', null, { isCamera: false, type: 'lock' })
const cam2 = device(6, 'Camera Kitchen', null)

const FLEET = [cam, siren, sirenSwitch, lock, cam2]
const LOCATIONS = ['Hall', 'Kitchen']
const ROWS = topLevelUnassigned(FLEET, LOCATIONS)

function renderTable(onAssign: (ids: readonly number[], location: string) => void = vi.fn()) {
  return render(
    <MemoryRouter>
      <UnassignedTable
        rows={ROWS}
        fleet={FLEET}
        locations={LOCATIONS}
        busy={false}
        emptyMessage="Every top-level device has a room."
        onAssign={onAssign}
      />
    </MemoryRouter>,
  )
}

function rowNames(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('link')[0]?.textContent ?? '')
}

function followersOf(deviceName: string): string {
  const row = screen.getByRole('row', { name: new RegExp(deviceName) })
  return within(row).getAllByRole('cell')[4]?.textContent ?? ''
}

const searchBox = (): HTMLElement => screen.getByLabelText('Search devices not in a room')

describe('unassigned table — its own filter', () => {
  it('the search narrows the rows to the names that match', () => {
    renderTable()
    expect(rowNames()).toEqual(['Camera Hall', 'Serratura', 'Camera Kitchen'])
    fireEvent.change(searchBox(), { target: { value: 'camera' } })
    expect(rowNames()).toEqual(['Camera Hall', 'Camera Kitchen'])
  })

  it('a type chip narrows the rows to that type', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: /^lock/ }))
    expect(rowNames()).toEqual(['Serratura'])
  })

  it('says "nothing matches", never "everything has a room", when the filter empties the table', () => {
    renderTable()
    fireEvent.change(searchBox(), { target: { value: 'zzz' } })
    expect(screen.getByText('No device matches this filter.')).toBeTruthy()
    expect(screen.queryByText('Every top-level device has a room.')).toBeNull()
  })

  it('select-all under a filter takes only the rows on screen', () => {
    const onAssign = vi.fn()
    renderTable(onAssign)
    fireEvent.change(searchBox(), { target: { value: 'camera' } })
    fireEvent.click(screen.getByLabelText('Select all unassigned devices'))
    fireEvent.change(screen.getByLabelText('Assign selected devices to'), {
      target: { value: 'Hall' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))
    const [ids] = onAssign.mock.calls[0] as [readonly number[], string]
    expect(ids.toSorted((a, b) => a - b)).toEqual([1, 6])
  })
})

describe('unassigned table — the filter never changes "accessories in tow"', () => {
  it('a search that hides the siren still counts it under its camera', () => {
    renderTable()
    expect(followersOf('Camera Hall')).toBe('2')

    // "hall" matches the camera and nothing else on the row set — and none
    // of the accessories at all.
    fireEvent.change(searchBox(), { target: { value: 'hall' } })
    expect(rowNames()).toEqual(['Camera Hall'])
    expect(followersOf('Camera Hall')).toBe('2')
  })

  it('a type chip that hides every accessory type still counts them', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: /^camera/ }))
    expect(rowNames()).toEqual(['Camera Hall', 'Camera Kitchen'])
    expect(followersOf('Camera Hall')).toBe('2')

    fireEvent.click(screen.getByLabelText('Select Camera Hall'))
    expect(screen.getByText(/1 selected · 2 accessories in tow/)).toBeTruthy()
  })
})
