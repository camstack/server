/**
 * The filter bar's Zone dropdown against a zones read that has not answered
 * (D315, D697): drawn DISABLED and saying why — even with a zone already
 * chosen, when it would otherwise vanish — the chosen zone is reported paused,
 * and Reset still clears it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceFilterBar } from '../device-filter-bar'
import { PICKER_NO_FILTERS, type PickerFilters, type PickerZonesRead } from '../device-picker-model'

const CHOSEN_ZONE: PickerFilters = { ...PICKER_NO_FILTERS, zones: ['night zone'] }

function mount(filters: PickerFilters, zones: PickerZonesRead) {
  const onFiltersChange = vi.fn<(next: PickerFilters) => void>()
  render(
    <DeviceFilterBar
      filters={filters}
      onFiltersChange={onFiltersChange}
      typeOptions={[]}
      zoneOptions={[]}
      locationOptions={[]}
      zones={zones}
      searchPlaceholder="Search"
      searchLabel="Search devices"
    />,
  )
  return onFiltersChange
}

describe('DeviceFilterBar — Zone dropdown without an answered zones read', () => {
  afterEach(cleanup)

  it.each([
    ['pending', /loading zones/],
    ['failed', /zones unavailable/],
  ] as const)('%s: a chosen zone keeps a disabled, explained dropdown and a paused note', (state, words) => {
    mount(CHOSEN_ZONE, { state })
    const trigger = screen.getByTestId('picker-filter-zone').querySelector('button')
    expect(trigger?.disabled).toBe(true)
    expect(trigger?.textContent).toMatch(words)
    expect(screen.getByTestId('picker-zone-filter-paused')).toBeTruthy()
  })

  it('Reset clears the chosen zone', () => {
    const onFiltersChange = mount(CHOSEN_ZONE, { state: 'pending' })
    fireEvent.click(screen.getByTestId('picker-reset-filters'))
    expect(onFiltersChange).toHaveBeenCalledWith(PICKER_NO_FILTERS)
  })

  it('an answered read with one zone value draws no Zone dropdown', () => {
    mount(PICKER_NO_FILTERS, { state: 'answered', zones: [] })
    expect(screen.queryByTestId('picker-filter-zone')).toBeNull()
  })
})
