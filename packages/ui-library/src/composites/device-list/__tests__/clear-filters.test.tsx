import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilterChips } from '../filter-chips'
import type { MultiSelectOption } from '../multi-select'

/**
 * Clear appears only when there is something to clear.
 *
 * A control that is always visible and usually does nothing teaches the
 * operator to stop seeing it. It also has to account for the SEARCH box, which
 * is rendered outside this component: telling someone the filters are cleared
 * while a search term still narrows the list is worse than not offering the
 * button at all.
 */
const TYPE_OPTIONS: readonly MultiSelectOption[] = [
  { id: 'camera', label: 'Camera' },
  { id: 'sensor', label: 'Sensor' },
]

function renderChips(over: Partial<Parameters<typeof FilterChips>[0]> = {}) {
  const onClearFilters = vi.fn()
  render(
    <FilterChips
      typeOptions={TYPE_OPTIONS}
      selectedTypes={[]}
      onTypesChange={vi.fn()}
      selectedAddons={[]}
      onAddonsChange={vi.fn()}
      onClearFilters={onClearFilters}
      {...over}
    />,
  )
  return { onClearFilters }
}

describe('the clear-filters affordance', () => {
  it('is absent while nothing is filtered', () => {
    renderChips()
    expect(screen.queryByText('Clear filters')).toBeNull()
  })

  it('appears when a TYPE is selected', () => {
    renderChips({ selectedTypes: ['camera'] })
    expect(screen.getByText('Clear filters')).not.toBeNull()
  })

  it('appears when an INTEGRATION is selected', () => {
    renderChips({ selectedAddons: ['reolink'] })
    expect(screen.getByText('Clear filters')).not.toBeNull()
  })

  it('appears for a search term alone — the input lives elsewhere', () => {
    renderChips({ query: 'garage' })
    expect(screen.getByText('Clear filters')).not.toBeNull()
  })

  it('ignores a whitespace-only search term', () => {
    renderChips({ query: '   ' })
    expect(screen.queryByText('Clear filters')).toBeNull()
  })

  it('calls back once when pressed', () => {
    const { onClearFilters } = renderChips({ selectedTypes: ['camera'] })
    fireEvent.click(screen.getByText('Clear filters'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it('stays hidden when the host offers no handler', () => {
    render(
      <FilterChips
        typeOptions={TYPE_OPTIONS}
        selectedTypes={['camera']}
        onTypesChange={vi.fn()}
        selectedAddons={[]}
        onAddonsChange={vi.fn()}
      />,
    )
    expect(screen.queryByText('Clear filters')).toBeNull()
  })
})
