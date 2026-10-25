// @vitest-environment jsdom
/**
 * <DeviceMultiSelectField> with a location to suggest from (D356). It was
 * the retired linked-devices section's picker (D655); the recording bands
 * editor still passes `suggestLocation`, and any `device-multiselect` field
 * may.
 *
 *  - **Same-location devices are SUGGESTED, never pre-selected.** The room's
 *    own devices come first under a heading; the value stays whatever the
 *    operator picked. A container family is suggested by its auto-selected
 *    primary child only (D749) — the other children stay in the list.
 *  - **Location and type facets narrow the catalogue before the search.**
 *    Hundreds of sensors are useless as a flat list.
 *  - **A container is never offered; its children are, named after it.**
 *    `Faretti hall 2 · in Pulsante faretti hall` is how the second
 *    spotlight becomes pickable at all — the retired auto mode only ever
 *    reached the container's primary child.
 */

import { DeviceType } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

interface FakeDevice {
  readonly id: number
  readonly name: string
  readonly type: DeviceType
  readonly location: string | null
  readonly parentDeviceId: number | null
  readonly stableId: string
}

const fleet: readonly FakeDevice[] = [
  {
    id: 104,
    name: 'Camera hall',
    type: DeviceType.Camera,
    location: 'Hall',
    parentDeviceId: null,
    stableId: 'st-1',
  },
  {
    id: 3513,
    name: 'Pulsante faretti hall',
    type: DeviceType.Container,
    location: 'Hall',
    parentDeviceId: null,
    stableId: 'st-2',
  },
  {
    id: 3519,
    name: 'Faretti hall 1',
    type: DeviceType.Switch,
    location: 'Hall',
    parentDeviceId: 3513,
    stableId: 'st-3',
  },
  {
    id: 3520,
    name: 'Faretti hall 2',
    type: DeviceType.Switch,
    location: 'Hall',
    parentDeviceId: 3513,
    stableId: 'st-4',
  },
  {
    id: 3510,
    name: 'Faretti kitchen',
    type: DeviceType.Switch,
    location: 'Kitchen',
    parentDeviceId: null,
    stableId: 'st-5',
  },
  {
    id: 4001,
    name: 'Sensore porta',
    type: DeviceType.Sensor,
    location: 'Kitchen',
    parentDeviceId: null,
    stableId: 'st-6',
  },
]

vi.mock('../../generated/system-hooks', () => ({
  useDeviceManagerListAll: () => ({ data: fleet, isLoading: false, error: null }),
}))

const { DeviceMultiSelectField } = await import('../device-select-field')

function renderPicker(onChange = vi.fn()) {
  render(
    <DeviceMultiSelectField
      field={{
        type: 'device-multiselect',
        key: '_linkedDeviceIds',
        label: 'Linked devices',
        deviceFilter: { excludeDeviceId: 104, excludeTypes: [DeviceType.Container] },
        suggestLocation: 'Hall',
      }}
      value={[]}
      onChange={onChange}
    />,
  )
  fireEvent.focus(screen.getByRole('combobox'))
  return onChange
}

describe('DeviceMultiSelectField as the linked-devices picker', () => {
  it('suggests the same-location devices first, without selecting them', () => {
    const onChange = renderPicker()
    expect(screen.getByText(/Suggested/)).toBeTruthy()
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options[0]).toContain('Faretti hall 1')
    expect(onChange).not.toHaveBeenCalled()
  })

  it("suggests a container's primary child only; its other children stay under Other devices", () => {
    renderPicker()
    const listbox = screen.getByRole('listbox')
    const text = listbox.textContent ?? ''
    const other = text.indexOf('Other devices')
    expect(other).toBeGreaterThan(-1)
    expect(text.indexOf('Faretti hall 1')).toBeLessThan(other)
    expect(text.indexOf('Faretti hall 2')).toBeGreaterThan(other)
  })

  it('names the container a child lives in, and never offers the container', () => {
    renderPicker()
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(
      options.some((t) => t.includes('Faretti hall 2') && t.includes('in Pulsante faretti hall')),
    ).toBe(true)
    expect(options.some((t) => t.startsWith('Pulsante faretti hall'))).toBe(false)
    expect(options.some((t) => t.includes('Camera hall'))).toBe(false)
  })

  it('narrows by the Location dropdown, then by the Type dropdown — two compact multi-selects', () => {
    renderPicker()
    // The facets are dropdowns, not rows of chips: closed they take one line each.
    fireEvent.click(screen.getByRole('button', { name: /^Location/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Kitchen' }))
    let options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /^Type/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'sensor' }))
    options = screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('Sensore porta')
    // The trigger names what is chosen.
    expect(screen.getByRole('button', { name: /^Location/ }).textContent).toContain('Kitchen')
  })
})
