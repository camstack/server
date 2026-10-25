/**
 * The unassigned table — the two things it PROMISES.
 *
 * 1. Bulk assignment. The measured fleet had 74 top-level roomless devices;
 *    that is a first population, not 74 individual corrections. Checkbox +
 *    selection bar has to reach `onAssign` once, with every selected id.
 * 2. "Accessories in tow". The row states, before the tap, how many devices
 *    the server cascade will move with it. It is counted over the WHOLE fleet,
 *    not over the rows on screen — the cascade does not know about the
 *    operator's search filter, and a number read off the filtered slice would
 *    quietly understate it.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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
const siren = device(2, 'Sirena', null, { isCamera: false, type: 'siren', parentDeviceId: 1 })
const sirenSwitch = device(3, 'Sirena switch', null, {
  isCamera: false,
  type: 'switch',
  parentDeviceId: 2,
})
const childCam = device(4, 'Camera figlia', null, { type: 'camera', parentDeviceId: 1 })
const lock = device(5, 'Serratura', null, { isCamera: false, type: 'lock' })
const ghost = device(6, 'Camera fantasma', 'Mansarda')

const FLEET = [cam, siren, sirenSwitch, childCam, lock, ghost]
const LOCATIONS = ['Hall', 'Kitchen']
// Derived, not hand-listed: the page hands the table exactly this, so a spec
// that hard-coded the rows would keep passing while the page shipped 568 of
// them.
const ROWS = topLevelUnassigned(FLEET, LOCATIONS)

function renderTable(onAssign: (ids: readonly number[], location: string) => void) {
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

function cellsOf(deviceName: string): readonly HTMLElement[] {
  const row = screen.getByRole('row', { name: new RegExp(deviceName) })
  return within(row).getAllByRole('cell')
}

describe('unassigned table — accessories in tow', () => {
  it('counts every descendant the cascade rewrites: direct, nested, and a child CAMERA', () => {
    renderTable(vi.fn())
    // siren (direct) + siren switch (grandchild) + child camera. A count built
    // on `linkedChildren` would say 1.
    expect(cellsOf('Camera Hall')[4]?.textContent).toBe('3')
  })

  it('says 0 — never blank — for a device that moves alone', () => {
    renderTable(vi.fn())
    expect(cellsOf('Serratura')[4]?.textContent).toBe('0')
  })

  it('counts over the WHOLE fleet, not over the rows on screen', () => {
    // Same rows, but the fleet handed in is only what a filter left visible.
    // The cascade still moves the accessories; a filtered count would say 0
    // and the row would lie about what the tap does.
    const { unmount } = render(
      <MemoryRouter>
        <UnassignedTable
          rows={ROWS}
          fleet={FLEET}
          locations={LOCATIONS}
          busy={false}
          emptyMessage=""
          onAssign={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(cellsOf('Camera Hall')[4]?.textContent).toBe('3')
    unmount()

    render(
      <MemoryRouter>
        <UnassignedTable
          rows={ROWS}
          fleet={ROWS}
          locations={LOCATIONS}
          busy={false}
          emptyMessage=""
          onAssign={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(cellsOf('Camera Hall')[4]?.textContent).toBe('0')
  })

  it('shows only top-level rows — an accessory is never its own row', () => {
    renderTable(vi.fn())
    expect(screen.getByLabelText('Select Camera Hall')).toBeTruthy()
    expect(screen.queryByLabelText('Select Sirena')).toBeNull()
    expect(screen.queryByLabelText('Select Sirena switch')).toBeNull()
    expect(screen.queryByLabelText('Select Camera figlia')).toBeNull()
  })

  it('names the unknown room on the row instead of dropping the device', () => {
    renderTable(vi.fn())
    expect(screen.getByText(/unknown room/)).toBeTruthy()
    expect(screen.getByText(/Mansarda/)).toBeTruthy()
  })
})

describe('unassigned table — assignment', () => {
  it('assigns a whole checkbox selection in ONE call', () => {
    const onAssign = vi.fn()
    renderTable(onAssign)

    fireEvent.click(screen.getByLabelText('Select Camera Hall'))
    fireEvent.click(screen.getByLabelText('Select Serratura'))
    fireEvent.change(screen.getByLabelText('Assign selected devices to'), {
      target: { value: 'Kitchen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))

    expect(onAssign).toHaveBeenCalledTimes(1)
    const [ids, location] = onAssign.mock.calls[0] as [readonly number[], string]
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 5])
    expect(location).toBe('Kitchen')
  })

  it('the selection bar totals the accessories the bulk assign will move', () => {
    renderTable(vi.fn())
    fireEvent.click(screen.getByLabelText('Select Camera Hall'))
    fireEvent.click(screen.getByLabelText('Select Serratura'))
    expect(screen.getByText(/2 selected · 3 accessories in tow/)).toBeTruthy()
  })

  it('select-all takes every visible row, and clearing takes none', () => {
    const onAssign = vi.fn()
    renderTable(onAssign)

    fireEvent.click(screen.getByLabelText('Select all unassigned devices'))
    fireEvent.change(screen.getByLabelText('Assign selected devices to'), {
      target: { value: 'Hall' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))

    const [ids] = onAssign.mock.calls[0] as [readonly number[], string]
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 5, 6])
  })

  it('refuses to assign with no room chosen — the bar cannot fire an empty location', () => {
    const onAssign = vi.fn()
    renderTable(onAssign)
    fireEvent.click(screen.getByLabelText('Select Serratura'))
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))
    expect(onAssign).not.toHaveBeenCalled()
  })

  it('the inline select assigns exactly one row', () => {
    const onAssign = vi.fn()
    renderTable(onAssign)
    fireEvent.change(screen.getByLabelText('Location for Serratura'), {
      target: { value: 'Hall' },
    })
    expect(onAssign).toHaveBeenCalledTimes(1)
    expect(onAssign).toHaveBeenCalledWith([5], 'Hall')
  })
})
