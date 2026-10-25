// @vitest-environment jsdom
/**
 * <DeviceSelectorPicker> — the v3 `DeviceSelector` editor.
 *
 * It lives HERE, with the composite, not in the admin UI: the picker resolves
 * its own fleet through the generated hooks, so the admin-UI side can only
 * ever test a stub of it. What is pinned:
 *
 *  - **The room tab exists only when there are rooms.** An empty tab reads as
 *    a broken feature; the operator's rule was to show the axis only when the
 *    fleet actually carries location labels.
 *  - **Counts are LIVE.** "Camera · 2" is the whole reason an operator can
 *    answer "how much am I granting" without leaving the panel.
 *  - **Switching tabs starts EMPTY, never at `all`.** A half-filled selector
 *    that silently means "everything" is the one failure this control cannot
 *    have.
 *  - **The `includeLinked` hint names the CONSEQUENCE** — no siren, no light
 *    — rather than describing parent/child inheritance. That restriction is
 *    real (`create` does not inherit) and invisible until someone hits it.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DeviceType, type DeviceSelector } from '@camstack/types'

interface FakeDevice {
  readonly id: number
  readonly name: string
  readonly type: DeviceType
  readonly location: string | null
  readonly parentDeviceId: number | null
}

let fleet: readonly FakeDevice[] = []

vi.mock('../../generated/system-hooks', () => ({
  useDeviceManagerListAll: () => ({ data: fleet, isLoading: false, error: null }),
  useAddonsList: () => ({ data: [], isLoading: false, error: null }),
}))

const { DeviceSelectorPicker } = await import('../device-selector-picker')

const CAMERA_FRONT: FakeDevice = {
  id: 5,
  name: 'Front door',
  type: DeviceType.Camera,
  location: 'Entrance',
  parentDeviceId: null,
}
const CAMERA_YARD: FakeDevice = {
  id: 7,
  name: 'Yard',
  type: DeviceType.Camera,
  location: null,
  parentDeviceId: null,
}
const SIREN: FakeDevice = {
  id: 51,
  name: 'Front siren',
  type: DeviceType.Siren,
  location: null,
  parentDeviceId: 5,
}

function renderPicker(value: DeviceSelector, onChange = vi.fn()) {
  const utils = render(<DeviceSelectorPicker value={value} onChange={onChange} />)
  return { ...utils, onChange }
}

describe('DeviceSelectorPicker — tabs', () => {
  it('omits the room tab when nothing in the fleet has a room', () => {
    fleet = [CAMERA_YARD, SIREN]
    renderPicker({ kind: 'all' })
    expect(screen.getByRole('button', { name: 'By type' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'By room' })).toBeNull()
  })

  it('offers the room tab as soon as one device carries a room', () => {
    fleet = [CAMERA_FRONT, CAMERA_YARD]
    renderPicker({ kind: 'all' })
    expect(screen.getByRole('button', { name: 'By room' })).toBeDefined()
  })

  it('keeps the room tab reachable when the CURRENT selector is a room one', () => {
    // The labels were removed from the fleet after the grant was written.
    // Hiding the tab would strand the operator on a selector they cannot see.
    fleet = [CAMERA_YARD]
    renderPicker({ kind: 'locations', locations: ['Entrance'] })
    expect(screen.getByRole('button', { name: 'By room' })).toBeDefined()
  })

  it('switching a tab resets to an EMPTY selector, never to `all`', () => {
    fleet = [CAMERA_FRONT, CAMERA_YARD, SIREN]
    const { onChange } = renderPicker({ kind: 'all' })
    fireEvent.click(screen.getByRole('button', { name: 'By type' }))
    expect(onChange).toHaveBeenCalledWith({ kind: 'types', types: [] })
  })
})

describe('DeviceSelectorPicker — live counts', () => {
  it('counts devices per type', () => {
    fleet = [CAMERA_FRONT, CAMERA_YARD, SIREN]
    renderPicker({ kind: 'types', types: [] })
    const cameraRow = screen.getByText('Camera').closest('label')
    expect(cameraRow?.textContent).toContain('2')
    const sirenRow = screen.getByText('Siren').closest('label')
    expect(sirenRow?.textContent).toContain('1')
  })

  it('keeps a selected type listed even when the fleet no longer has one', () => {
    // Otherwise the operator's own choice vanishes from the form while
    // remaining in the grant — the control would be lying about the grant.
    fleet = [CAMERA_YARD]
    renderPicker({ kind: 'types', types: [DeviceType.Siren] })
    const sirenRow = screen.getByText('Siren').closest('label')
    expect(sirenRow).not.toBeNull()
    const checkbox = sirenRow === null ? null : sirenRow.querySelector('input')
    expect(checkbox).not.toBeNull()
    expect(checkbox instanceof HTMLInputElement && checkbox.checked).toBe(true)
  })

  it('counts devices per room', () => {
    fleet = [CAMERA_FRONT, CAMERA_YARD]
    renderPicker({ kind: 'locations', locations: [] })
    const row = screen.getByText('Entrance').closest('label')
    expect(row?.textContent).toContain('1')
  })
})

describe('DeviceSelectorPicker — chosen list', () => {
  it('filters by name and toggles ids', () => {
    fleet = [CAMERA_FRONT, CAMERA_YARD, SIREN]
    const { onChange } = renderPicker({ kind: 'ids', ids: [] })
    fireEvent.change(screen.getByPlaceholderText('Search devices…'), { target: { value: 'yard' } })
    expect(screen.queryByText('Front door')).toBeNull()
    fireEvent.click(screen.getByText('Yard').closest('label')!.querySelector('input')!)
    expect(onChange).toHaveBeenCalledWith({ kind: 'ids', ids: [7] })
  })

  it('warns that a chosen list is STATIC', () => {
    fleet = [CAMERA_YARD]
    renderPicker({ kind: 'ids', ids: [7] })
    expect(screen.getByText(/device added later is/)).toBeDefined()
  })
})

describe('DeviceSelectorPicker — includeLinked', () => {
  it('is absent unless the caller wires it', () => {
    fleet = [CAMERA_YARD]
    renderPicker({ kind: 'all' })
    expect(screen.queryByText('Include linked devices')).toBeNull()
  })

  it('spells out the CONSEQUENCE when it is off', () => {
    fleet = [CAMERA_FRONT, SIREN]
    render(
      <DeviceSelectorPicker
        value={{ kind: 'all' }}
        onChange={vi.fn()}
        includeLinked={false}
        onIncludeLinkedChange={vi.fn()}
      />,
    )
    expect(screen.getByText(/siren or light attached to it/)).toBeDefined()
  })

  it('states what it covers when it is on', () => {
    fleet = [CAMERA_FRONT, SIREN]
    render(
      <DeviceSelectorPicker
        value={{ kind: 'all' }}
        onChange={vi.fn()}
        includeLinked
        onIncludeLinkedChange={vi.fn()}
      />,
    )
    expect(screen.getByText(/siren, floodlight, PIR/)).toBeDefined()
  })
})
